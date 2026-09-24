// The CBOR (RFC 8949) subset a C2PA manifest is written in.
//
// C2PA claims, assertions and COSE signatures are all CBOR. A claim signature
// covers the claim's exact bytes, so the encoder has to be deterministic about
// the things RFC 8949 leaves open: every length and integer uses its shortest
// form (the "preferred serialization" of section 4.1) and map entries keep the
// order they were written in. The claim generator chooses the order; verifiers
// never re-encode, they hash and verify the bytes they were given.
//
// The decoder is the stricter half. It accepts what other claim generators
// write — indefinite lengths, half/single/double floats, tags — because a
// verifier that can only read its own output verifies nothing, and it rejects
// trailing bytes and truncated items, because a signature over bytes the
// decoder silently ignored would cover less than it appears to.

export class CborError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CborError';
  }
}

/// A tagged item: `new Tagged(18, [...])` is a COSE_Sign1_Tagged.
export class Tagged {
  constructor(tag, value) {
    this.tag = tag;
    this.value = value;
  }
}

// ------------------------------------------------------------------ encoding

function head(major, value) {
  const n = typeof value === 'bigint' ? value : BigInt(value);
  if (n < 0n) throw new CborError('a CBOR length or argument cannot be negative');
  const m = major << 5;
  if (n < 24n) return Buffer.from([m | Number(n)]);
  if (n < 0x100n) return Buffer.from([m | 24, Number(n)]);
  if (n < 0x10000n) {
    const out = Buffer.alloc(3);
    out[0] = m | 25;
    out.writeUInt16BE(Number(n), 1);
    return out;
  }
  if (n < 0x100000000n) {
    const out = Buffer.alloc(5);
    out[0] = m | 26;
    out.writeUInt32BE(Number(n), 1);
    return out;
  }
  if (n < 0x10000000000000000n) {
    const out = Buffer.alloc(9);
    out[0] = m | 27;
    out.writeBigUInt64BE(n, 1);
    return out;
  }
  throw new CborError('integer does not fit in 64 bits');
}

function encodeInto(value, parts) {
  if (value === null) {
    parts.push(Buffer.from([0xf6]));
  } else if (value === true) {
    parts.push(Buffer.from([0xf5]));
  } else if (value === false) {
    parts.push(Buffer.from([0xf4]));
  } else if (typeof value === 'number' || typeof value === 'bigint') {
    if (typeof value === 'number' && !Number.isSafeInteger(value)) {
      // Floats are legal CBOR, but nothing this bridge writes is one, and a
      // float that slipped in would be encoded in whichever width the encoder
      // preferred — exactly the freedom a signed structure must not have.
      throw new CborError(`refusing to encode a non-integer number: ${value}`);
    }
    const n = BigInt(value);
    parts.push(n >= 0n ? head(0, n) : head(1, -1n - n));
  } else if (typeof value === 'string') {
    const bytes = Buffer.from(value, 'utf8');
    parts.push(head(3, bytes.length), bytes);
  } else if (value instanceof Uint8Array) {
    parts.push(head(2, value.length), Buffer.from(value));
  } else if (Array.isArray(value)) {
    parts.push(head(4, value.length));
    for (const item of value) encodeInto(item, parts);
  } else if (value instanceof Tagged) {
    parts.push(head(6, value.tag));
    encodeInto(value.value, parts);
  } else if (value instanceof Map) {
    parts.push(head(5, value.size));
    for (const [key, item] of value) {
      encodeInto(key, parts);
      encodeInto(item, parts);
    }
  } else if (typeof value === 'object') {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined);
    parts.push(head(5, entries.length));
    for (const [key, item] of entries) {
      encodeInto(key, parts);
      encodeInto(item, parts);
    }
  } else {
    throw new CborError(`cannot encode a value of type ${typeof value}`);
  }
}

/**
 * Encodes `value` with preferred serialization. Plain objects become maps with
 * text keys in insertion order (`undefined` members are omitted, which is how
 * an optional field is left out); a `Map` is used where keys are integers, as
 * in a COSE header.
 */
export function encode(value) {
  const parts = [];
  encodeInto(value, parts);
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------ decoding

function halfToNumber(bits) {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const fraction = bits & 0x3ff;
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
  if (exponent === 0x1f) return fraction ? Number.NaN : sign * Number.POSITIVE_INFINITY;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

class Reader {
  constructor(bytes) {
    this.bytes = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.offset = 0;
  }

  need(count) {
    if (this.offset + count > this.bytes.length) throw new CborError('truncated CBOR item');
  }

  byte() {
    this.need(1);
    return this.bytes[this.offset++];
  }

  argument(info) {
    if (info < 24) return BigInt(info);
    const widths = { 24: 1, 25: 2, 26: 4, 27: 8 };
    const width = widths[info];
    if (width === undefined) throw new CborError(`reserved additional information ${info}`);
    this.need(width);
    const at = this.offset;
    this.offset += width;
    if (width === 1) return BigInt(this.bytes[at]);
    if (width === 2) return BigInt(this.bytes.readUInt16BE(at));
    if (width === 4) return BigInt(this.bytes.readUInt32BE(at));
    return this.bytes.readBigUInt64BE(at);
  }

  length(info) {
    const n = this.argument(info);
    if (n > BigInt(this.bytes.length)) throw new CborError('declared length exceeds the input');
    return Number(n);
  }

  take(count) {
    this.need(count);
    const out = this.bytes.subarray(this.offset, this.offset + count);
    this.offset += count;
    return out;
  }

  chunks(major) {
    // Indefinite-length string: definite chunks of the same major type up to 0xff.
    const parts = [];
    for (;;) {
      const initial = this.byte();
      if (initial === 0xff) break;
      if (initial >> 5 !== major || (initial & 0x1f) === 31) {
        throw new CborError('malformed indefinite-length string chunk');
      }
      parts.push(this.take(this.length(initial & 0x1f)));
    }
    return Buffer.concat(parts);
  }

  item(depth = 0) {
    if (depth > 64) throw new CborError('CBOR nesting is too deep');
    const initial = this.byte();
    const major = initial >> 5;
    const info = initial & 0x1f;
    switch (major) {
      case 0:
      case 1: {
        const n = this.argument(info);
        const value = major === 0 ? n : -1n - n;
        return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
          ? Number(value)
          : value;
      }
      case 2:
        return new Uint8Array(info === 31 ? this.chunks(2) : this.take(this.length(info)));
      case 3: {
        const bytes = info === 31 ? this.chunks(3) : this.take(this.length(info));
        const text = new TextDecoder('utf-8', { fatal: true });
        try {
          return text.decode(bytes);
        } catch {
          throw new CborError('text string is not valid UTF-8');
        }
      }
      case 4: {
        const out = [];
        if (info === 31) {
          while (this.bytes[this.offset] !== 0xff) {
            this.need(1);
            out.push(this.item(depth + 1));
          }
          this.offset += 1;
        } else {
          const count = this.length(info);
          for (let i = 0; i < count; i++) out.push(this.item(depth + 1));
        }
        return out;
      }
      case 5: {
        const entries = [];
        const readEntry = () => entries.push([this.item(depth + 1), this.item(depth + 1)]);
        if (info === 31) {
          while (this.bytes[this.offset] !== 0xff) {
            this.need(1);
            readEntry();
          }
          this.offset += 1;
        } else {
          const count = this.length(info);
          for (let i = 0; i < count; i++) readEntry();
        }
        return toMap(entries);
      }
      case 6:
        return new Tagged(Number(this.argument(info)), this.item(depth + 1));
      default: {
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22) return null;
        if (info === 23) return undefined;
        if (info === 25) return halfToNumber(this.take(2).readUInt16BE(0));
        if (info === 26) return this.take(4).readFloatBE(0);
        if (info === 27) return this.take(8).readDoubleBE(0);
        throw new CborError(`unsupported simple value ${info}`);
      }
    }
  }
}

/// Text-keyed maps become plain objects, anything else a `Map`. A duplicate key
/// is rejected: two readers could otherwise disagree about which value a
/// signed structure carried, the same reason `jcs.mjs` rejects duplicate JSON
/// member names.
function toMap(entries) {
  const textKeys = entries.every(([key]) => typeof key === 'string');
  if (textKeys) {
    const out = {};
    for (const [key, value] of entries) {
      if (Object.hasOwn(out, key)) throw new CborError(`duplicate map key ${key}`);
      // defineProperty, not assignment: a key named `__proto__` must stay data.
      Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
    }
    return out;
  }
  const out = new Map();
  for (const [key, value] of entries) {
    if (out.has(key)) throw new CborError(`duplicate map key ${String(key)}`);
    out.set(key, value);
  }
  return out;
}

/// Decodes exactly one CBOR item and rejects anything after it.
export function decode(bytes) {
  const reader = new Reader(bytes);
  const value = reader.item();
  if (reader.offset !== reader.bytes.length) {
    throw new CborError(`${reader.bytes.length - reader.offset} trailing bytes after the CBOR item`);
  }
  return value;
}
