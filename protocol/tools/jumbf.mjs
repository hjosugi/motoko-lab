// JUMBF (ISO/IEC 19566-5), the box format a C2PA manifest store is made of.
//
// A box is `LBox (u32 BE, whole box length) || TBox (4 ASCII bytes) || payload`,
// with `LBox = 1` meaning a u64 `XLBox` follows. A JUMBF superbox (`jumb`)
// starts with a description box (`jumd`) — a 16-byte type UUID, a toggle byte,
// and, when the toggles say so, a NUL-terminated label and a private box —
// followed by its content boxes.
//
// C2PA addresses everything by label (`self#jumbf=c2pa.assertions/c2pa.hash.data`)
// and hashes assertions over the superbox *payload*: the description box and
// the content boxes, not the superbox's own LBox/TBox. That rule was confirmed
// byte for byte against a c2patool 0.27.22 manifest; see protocol/C2PA_BRIDGE.md.

export class JumbfError extends Error {
  constructor(message) {
    super(message);
    this.name = 'JumbfError';
  }
}

/// The ISO 19566-5 suffix every C2PA box-type UUID shares after its 4CC.
const UUID_SUFFIX = '00110010800000aa00389b71';
const uuidFor = (fourcc) => Buffer.from(Buffer.from(fourcc, 'latin1').toString('hex') + UUID_SUFFIX, 'hex');

export const UUID = Object.freeze({
  manifestStore: uuidFor('c2pa'),
  manifest: uuidFor('c2ma'),
  assertionStore: uuidFor('c2as'),
  claim: uuidFor('c2cl'),
  signature: uuidFor('c2cs'),
  cbor: uuidFor('cbor'),
  json: uuidFor('json'),
});

/// Toggle bits of the description box.
export const TOGGLE = Object.freeze({ requestable: 0x01, label: 0x02, id: 0x04, signature: 0x08, private: 0x10 });

export function box(type, payload) {
  if (Buffer.byteLength(type, 'latin1') !== 4) throw new JumbfError(`box type must be 4 bytes: ${type}`);
  const body = Buffer.from(payload);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(body.length + 8, 0);
  header.write(type, 4, 'latin1');
  return Buffer.concat([header, body]);
}

/**
 * A description box. `salt`, when given, is carried in a private `c2sh` box —
 * the per-assertion salt C2PA uses so that a redacted or withheld assertion
 * cannot be recovered by hashing guesses against its hashed URI.
 */
export function descriptionBox({ uuid, label, salt }) {
  if (uuid.length !== 16) throw new JumbfError('a JUMBF type UUID is 16 bytes');
  if (label.includes('\0')) throw new JumbfError('a JUMBF label cannot contain NUL');
  let toggles = TOGGLE.requestable | TOGGLE.label;
  const parts = [Buffer.from(uuid), Buffer.alloc(1), Buffer.from(label, 'utf8'), Buffer.alloc(1)];
  if (salt) {
    toggles |= TOGGLE.private;
    parts.push(box('c2sh', salt));
  }
  parts[1][0] = toggles;
  return box('jumd', Buffer.concat(parts));
}

export function superbox(description, contents) {
  return box('jumb', Buffer.concat([descriptionBox(description), ...contents]));
}

/// Splits a byte range into boxes. Every box must fit exactly: a length that
/// runs past the end, or bytes left over, is malformed rather than ignored.
export function parseBoxes(bytes, base = 0) {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = [];
  let offset = 0;
  while (offset < data.length) {
    if (offset + 8 > data.length) throw new JumbfError('truncated box header');
    let length = data.readUInt32BE(offset);
    const type = data.toString('latin1', offset + 4, offset + 8);
    let headerLength = 8;
    if (length === 1) {
      if (offset + 16 > data.length) throw new JumbfError('truncated XLBox');
      length = Number(data.readBigUInt64BE(offset + 8));
      headerLength = 16;
    } else if (length === 0) {
      length = data.length - offset; // "to the end of the enclosing container"
    }
    if (length < headerLength || offset + length > data.length) {
      throw new JumbfError(`box ${type} at ${base + offset} overruns its container`);
    }
    out.push({
      type,
      start: base + offset,
      payload: data.subarray(offset + headerLength, offset + length),
      raw: data.subarray(offset, offset + length),
    });
    offset += length;
  }
  return out;
}

export function parseDescription(payload) {
  if (payload.length < 17) throw new JumbfError('description box is too short');
  const uuid = payload.subarray(0, 16);
  const toggles = payload[16];
  let offset = 17;
  let label = null;
  if (toggles & TOGGLE.label) {
    const end = payload.indexOf(0, offset);
    if (end < 0) throw new JumbfError('description label is not NUL-terminated');
    label = new TextDecoder('utf-8', { fatal: true }).decode(payload.subarray(offset, end));
    offset = end + 1;
  }
  let id = null;
  if (toggles & TOGGLE.id) {
    if (offset + 4 > payload.length) throw new JumbfError('truncated description id');
    id = payload.readUInt32BE(offset);
    offset += 4;
  }
  if (toggles & TOGGLE.signature) offset += 32;
  let salt = null;
  if (toggles & TOGGLE.private) {
    const [privateBox] = parseBoxes(payload.subarray(offset));
    if (privateBox?.type === 'c2sh') salt = privateBox.payload;
  }
  return { uuid: Buffer.from(uuid), toggles, label, id, salt };
}

/**
 * Parses a `jumb` superbox's payload into its description and children. Child
 * superboxes are parsed recursively; other boxes are kept as `{type, payload}`.
 * `payload` of the superbox itself is kept, since that is what C2PA hashes.
 */
export function parseSuperbox(payload) {
  const boxes = parseBoxes(payload);
  if (!boxes.length || boxes[0].type !== 'jumd') throw new JumbfError('a superbox must start with a description box');
  const description = parseDescription(boxes[0].payload);
  const children = boxes.slice(1).map((child) =>
    child.type === 'jumb' ? { type: 'jumb', ...parseSuperbox(child.payload) } : child,
  );
  return { description, children, payload };
}

/// The child superbox with this label, or `undefined`.
export function child(superboxNode, label) {
  return superboxNode.children.find((node) => node.type === 'jumb' && node.description.label === label);
}
