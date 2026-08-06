// RFC 8785 JSON Canonicalization Scheme.
//
// The manifest digest is what the commitment binds, so two verifiers that
// disagree about the canonical bytes disagree about whether a record is valid.
// This used to be a recursive key sort over `JSON.stringify`, which is right
// far more often than it is wrong — and the ways it was wrong were all silent.
//
// Three of RFC 8785's rules fall out of ECMAScript for free, and the spec says
// so explicitly: number serialization is ES6 `Number::toString` (§3.2.2.3),
// string escaping is ES6 `JSON.stringify` (§3.2.2.2), and property sorting is
// by UTF-16 code unit, which is what JavaScript's default string comparison
// already does (§3.2.3). So `JSON.stringify` is not the weak part.
//
// The weak part is everything `JSON.parse` throws away before you can look at
// it. A duplicate key is silently resolved to the last occurrence, so two
// manifests that no human would call equal hash the same. A lone surrogate
// survives parsing and round-trips through `JSON.stringify` as an escape, where
// a Rust or Go implementation rejects the input outright. Neither is
// detectable after parsing, which is why this module scans the text itself.
//
// One restriction here is stricter than RFC 8785, and deliberately so: see
// `checkNumberLiteral`.

export class JcsError extends Error {
  constructor(message) {
    super(message);
    this.name = "JcsError";
  }
}

/** Identifier written into every manifest and bundle this tool produces. */
export const CANONICALIZATION_ID = "RFC8785";

// ------------------------------------------------------------------ parse --

// A JSON parser, rather than `JSON.parse`, for exactly one reason: the checks
// below are all on things the parsed value no longer remembers.
class Scanner {
  constructor(text) {
    this.text = text;
    this.at = 0;
  }

  fail(message) {
    throw new JcsError(`${message} at offset ${this.at}`);
  }

  parse() {
    this.skipWhitespace();
    const value = this.value();
    this.skipWhitespace();
    if (this.at !== this.text.length) this.fail("trailing content after the top-level value");
    return value;
  }

  skipWhitespace() {
    // RFC 8259 §2. Nothing else counts, so a vertical tab or a non-breaking
    // space between tokens is a parse error rather than an invisible edit.
    while (this.at < this.text.length) {
      const c = this.text[this.at];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") this.at += 1;
      else break;
    }
  }

  expect(char) {
    if (this.text[this.at] !== char) this.fail(`expected ${JSON.stringify(char)}`);
    this.at += 1;
  }

  value() {
    const c = this.text[this.at];
    if (c === "{") return this.object();
    if (c === "[") return this.array();
    if (c === '"') return this.string();
    if (c === "t") return this.literal("true", true);
    if (c === "f") return this.literal("false", false);
    if (c === "n") return this.literal("null", null);
    if (c === "-" || (c >= "0" && c <= "9")) return this.number();
    this.fail(c === undefined ? "unexpected end of input" : `unexpected character ${JSON.stringify(c)}`);
  }

  literal(word, result) {
    if (this.text.startsWith(word, this.at)) {
      this.at += word.length;
      return result;
    }
    this.fail(`expected ${word}`);
  }

  object() {
    this.expect("{");
    const result = {};
    const seen = new Set();
    this.skipWhitespace();
    if (this.text[this.at] === "}") {
      this.at += 1;
      return result;
    }
    for (;;) {
      this.skipWhitespace();
      if (this.text[this.at] !== '"') this.fail("expected a member name");
      const keyAt = this.at;
      const key = this.string();
      if (seen.has(key)) {
        // The one failure this whole module exists for. `JSON.parse` keeps the
        // last occurrence without a word, so `{"a":1,"a":2}` and `{"a":2}`
        // produce the same digest and a manifest can carry a claim that no
        // verifier will ever hash.
        this.at = keyAt;
        this.fail(`duplicate member name ${JSON.stringify(key)}`);
      }
      seen.add(key);
      this.skipWhitespace();
      this.expect(":");
      this.skipWhitespace();
      result[key] = this.value();
      this.skipWhitespace();
      if (this.text[this.at] === ",") {
        this.at += 1;
        continue;
      }
      this.expect("}");
      return result;
    }
  }

  array() {
    this.expect("[");
    const result = [];
    this.skipWhitespace();
    if (this.text[this.at] === "]") {
      this.at += 1;
      return result;
    }
    for (;;) {
      this.skipWhitespace();
      result.push(this.value());
      this.skipWhitespace();
      if (this.text[this.at] === ",") {
        this.at += 1;
        continue;
      }
      this.expect("]");
      return result;
    }
  }

  string() {
    this.expect('"');
    let out = "";
    for (;;) {
      const c = this.text[this.at];
      if (c === undefined) this.fail("unterminated string");
      if (c === '"') {
        this.at += 1;
        checkWellFormed(out, this);
        return out;
      }
      if (c === "\\") {
        this.at += 1;
        out += this.escape();
        continue;
      }
      const code = this.text.charCodeAt(this.at);
      if (code < 0x20) this.fail(`unescaped control character U+${code.toString(16).padStart(4, "0")}`);
      out += c;
      this.at += 1;
    }
  }

  escape() {
    const c = this.text[this.at];
    this.at += 1;
    switch (c) {
      case '"': return '"';
      case "\\": return "\\";
      case "/": return "/";
      case "b": return "\b";
      case "f": return "\f";
      case "n": return "\n";
      case "r": return "\r";
      case "t": return "\t";
      case "u": {
        const hex = this.text.slice(this.at, this.at + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail("malformed \\u escape");
        this.at += 4;
        return String.fromCharCode(parseInt(hex, 16));
      }
      default:
        this.at -= 1;
        this.fail(`invalid escape ${JSON.stringify(`\\${c ?? ""}`)}`);
    }
  }

  number() {
    const start = this.at;
    if (this.text[this.at] === "-") this.at += 1;
    if (this.text[this.at] === "0") {
      this.at += 1;
    } else if (this.text[this.at] >= "1" && this.text[this.at] <= "9") {
      while (this.text[this.at] >= "0" && this.text[this.at] <= "9") this.at += 1;
    } else {
      this.fail("expected a digit");
    }
    let fraction = false;
    if (this.text[this.at] === ".") {
      fraction = true;
      this.at += 1;
      if (!(this.text[this.at] >= "0" && this.text[this.at] <= "9")) this.fail("expected a digit after '.'");
      while (this.text[this.at] >= "0" && this.text[this.at] <= "9") this.at += 1;
    }
    let exponent = false;
    if (this.text[this.at] === "e" || this.text[this.at] === "E") {
      exponent = true;
      this.at += 1;
      if (this.text[this.at] === "+" || this.text[this.at] === "-") this.at += 1;
      if (!(this.text[this.at] >= "0" && this.text[this.at] <= "9")) this.fail("expected a digit in the exponent");
      while (this.text[this.at] >= "0" && this.text[this.at] <= "9") this.at += 1;
    }
    const literal = this.text.slice(start, this.at);
    this.at = start;
    checkNumberLiteral(literal, fraction || exponent, this);
    this.at = start + literal.length;
    return Number(literal);
  }
}

function checkNumberLiteral(literal, inexact, scanner) {
  const value = Number(literal);
  if (!Number.isFinite(value)) {
    // `1E400` parses to Infinity, which RFC 8785 has no serialization for.
    scanner.fail(`number ${literal} is outside the IEEE-754 double range`);
  }
  if (inexact) return;
  // Stricter than RFC 8785, on purpose.
  //
  // JCS is defined over the parsed double, so a conformant implementation is
  // free to accept `12345678901234567890` and serialize the rounded
  // `12345678901234567000` — and the official `values` vector requires exactly
  // that behaviour for `333333333.33333329`. Fine for a number that was always
  // approximate. Not fine for a bare integer literal, where every digit was
  // written to be exact and losing the last four is the difference between a
  // file size, an identifier, or a timestamp and a different one. Those are the
  // integers a provenance manifest actually carries, and nothing in the output
  // would tell the creator that the number they signed is not the number they
  // wrote. `serde_jcs` rounds it the same way, so this is not an interop
  // disagreement — both implementations lose the same digits, quietly.
  //
  // The test is exact round-tripping, not digit count. An earlier version of
  // this check rejected any integer literal above `Number.MAX_SAFE_INTEGER`,
  // which rejected `100000000000000000000` — the canonical form of `1e20`, and
  // therefore its own output. A canonicalization with no fixed point is a
  // canonicalization two verifiers can disagree about by applying it a
  // different number of times.
  //
  // Only the literal form is restricted: `1E30` is accepted, because a number
  // written in exponent form was never claiming digit-level precision, and the
  // official vectors require it.
  if (BigInt(literal) !== BigInt(value)) {
    scanner.fail(
      `integer literal ${literal} needs more precision than IEEE-754 double provides; ` +
        `it would be hashed as ${JSON.stringify(value)}`
    );
  }
}

function checkWellFormed(text, scanner) {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        scanner.fail(`unpaired high surrogate U+${code.toString(16).toUpperCase()}`);
      }
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      scanner.fail(`unpaired low surrogate U+${code.toString(16).toUpperCase()}`);
    }
  }
}

/**
 * Parse JSON text under the rules above. Use this instead of `JSON.parse`
 * anywhere the result is going to be hashed.
 */
export function parse(text) {
  if (typeof text !== "string") throw new JcsError("input must be JSON text");
  return new Scanner(text).parse();
}

// -------------------------------------------------------------- serialize --

function serialize(value, path) {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new JcsError(`${path || "value"} is ${value}, which RFC 8785 cannot serialize`);
      }
      // ES6 Number::toString, which is what §3.2.2.3 specifies. `-0` becomes
      // `0` here, as required.
      return JSON.stringify(value);
    case "string":
      // ES6 JSON.stringify string escaping, which is what §3.2.2.2 specifies:
      // `"` and `\` and the C0 controls, nothing else. U+007F stays literal.
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((item, index) => serialize(item, `${path}[${index}]`)).join(",")}]`;
      }
      const keys = Object.keys(value).sort(compareUtf16);
      const members = keys.map((key) => {
        const child = value[key];
        if (child === undefined) {
          throw new JcsError(`${path}${path ? "." : ""}${key} is undefined, which is not a JSON value`);
        }
        return `${JSON.stringify(key)}:${serialize(child, `${path}${path ? "." : ""}${key}`)}`;
      });
      return `{${members.join(",")}}`;
    }
    default:
      throw new JcsError(`${path || "value"} has type ${typeof value}, which is not a JSON value`);
  }
}

// §3.2.3: sort by UTF-16 code unit. This is what JavaScript's `<` on strings
// already does, written out so the intent survives a reader who wonders whether
// a locale-aware comparison snuck in. It is not code *point* order: U+1F602
// sorts before U+FB33 because its first code unit is 0xD83D.
function compareUtf16(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Canonicalize an already-parsed value. */
export function canonicalizeValue(value) {
  return serialize(value, "");
}

/** Parse JSON text strictly, then canonicalize it. */
export function canonicalize(text) {
  return canonicalizeValue(parse(text));
}
