// The Internet Computer principal textual form.
//
// The commitment preimage embeds the creator's principal as text, so "what
// counts as a principal" is part of the frozen v1 layout and cannot be left to
// a length check. It used to be one: any string of 5 to 100 characters was
// accepted, which meant `hello` and `not-a-principal` produced perfectly good
// commitments that no canister could ever match, because the canister derives
// the same field from `Principal.toText(caller)` and never from a request.
//
// The textual form is defined in the Interface Specification, "Textual
// representation of principals":
//
//   text = groups of 5 base32 characters, '-' separated, lowercase
//   bytes = base32-decode(text without '-')
//   bytes = CRC32(blob) as 4 big-endian bytes || blob
//
// A principal blob is at most 29 bytes, so the text is between 8 characters
// (`aaaaa-aa`, the empty blob, which is the management canister) and 63.
//
// Validation here is strict in both directions: the checksum must match *and*
// re-encoding the decoded blob must reproduce the input exactly. The second
// half is what makes the form canonical — without it, a differently grouped or
// padded string with a correct checksum would be a second spelling of the same
// principal, and two spellings mean two commitments for one creator.

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const MAX_BLOB_BYTES = 29;

export const MIN_TEXT_LENGTH = 8;
export const MAX_TEXT_LENGTH = 63;

export class PrincipalError extends Error {
  constructor(message) {
    super(message);
    this.name = "PrincipalError";
  }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function base32Encode(bytes) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  // No padding: the spec drops the trailing '=' that RFC 4648 would add.
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(text) {
  let bits = 0;
  let value = 0;
  const out = [];
  for (const character of text) {
    const index = ALPHABET.indexOf(character);
    if (index === -1) throw new PrincipalError(`invalid base32 character ${JSON.stringify(character)}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

/** Text for a principal blob, in the canonical grouped lowercase form. */
export function encode(blob) {
  if (blob.length > MAX_BLOB_BYTES) {
    throw new PrincipalError(`principal blob is ${blob.length} bytes, over the ${MAX_BLOB_BYTES}-byte maximum`);
  }
  const checksum = crc32(blob);
  const payload = new Uint8Array(4 + blob.length);
  payload[0] = (checksum >>> 24) & 0xff;
  payload[1] = (checksum >>> 16) & 0xff;
  payload[2] = (checksum >>> 8) & 0xff;
  payload[3] = checksum & 0xff;
  payload.set(blob, 4);
  return (base32Encode(payload).match(/.{1,5}/g) ?? []).join("-");
}

/**
 * Decode and fully validate principal text. Throws `PrincipalError` with a
 * stable message; the conformance vectors pin those messages.
 */
export function decode(text) {
  if (typeof text !== "string") throw new PrincipalError("principal must be text");
  if (text.length === 0) throw new PrincipalError("principal is empty");
  if (text !== text.toLowerCase()) {
    // Not normalized here. The preimage is defined over the canonical form, and
    // a tool that silently accepted `AAAAA-AA` would be teaching callers that
    // the field is case-insensitive when the bytes that get hashed are not.
    // Callers that hold a mixed-case string should lowercase it and say so.
    throw new PrincipalError("principal must be lowercase; the canonical form has no uppercase characters");
  }
  if (text.length < MIN_TEXT_LENGTH || text.length > MAX_TEXT_LENGTH) {
    throw new PrincipalError(
      `principal text is ${text.length} characters, outside ${MIN_TEXT_LENGTH}..${MAX_TEXT_LENGTH}`,
    );
  }
  if (!/^[a-z2-7]+(-[a-z2-7]+)*$/.test(text)) {
    throw new PrincipalError("principal must be base32 groups separated by single '-'");
  }
  const payload = base32Decode(text.replaceAll("-", ""));
  if (payload.length < 4) throw new PrincipalError("principal is too short to contain a checksum");
  const blob = payload.slice(4);
  if (blob.length > MAX_BLOB_BYTES) {
    throw new PrincipalError(`principal blob is ${blob.length} bytes, over the ${MAX_BLOB_BYTES}-byte maximum`);
  }
  const expected = ((payload[0] << 24) | (payload[1] << 16) | (payload[2] << 8) | payload[3]) >>> 0;
  const actual = crc32(blob);
  if (expected !== actual) {
    throw new PrincipalError(
      `principal checksum is ${expected.toString(16).padStart(8, "0")}, expected ${actual.toString(16).padStart(8, "0")}`,
    );
  }
  // The round trip is what makes the form canonical: it rejects a mis-grouped
  // string, a wrong number of trailing bits, or anything else that decodes to
  // the same blob but is not the spelling the specification defines.
  const canonical = encode(blob);
  if (canonical !== text) {
    throw new PrincipalError(`principal is not in canonical form; ${JSON.stringify(canonical)} is`);
  }
  return blob;
}

/** True when `text` is a valid principal in canonical form. */
export function isValid(text) {
  try {
    decode(text);
    return true;
  } catch (error) {
    if (error instanceof PrincipalError) return false;
    throw error;
  }
}
