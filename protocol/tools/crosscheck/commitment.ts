// An implementation of the v1 commitment layout written from
// protocol/COMMITMENT_V1.md.
//
// Independent of protocol/tools/commitment.mjs in the part that matters most:
// the principal textual form is validated by @dfinity/principal, DFINITY's own
// library, rather than by the base32 and CRC32 code in protocol/tools/principal.mjs.

import { createHash } from "node:crypto";
import { Principal } from "@dfinity/principal";

const DOMAIN = "icp-creator-proof:v1";
const DIGEST_BYTES = 32;
const SALT_MIN = 16;
const SALT_MAX = 64;

export interface Triple {
  principal: string;
  manifestHash: string;
  salt: string;
}

export interface Built {
  preimageHex: string;
  commitmentHex: string;
}

function hexToBytes(field: string, value: string): Buffer {
  if (value.length === 0) throw new Error(`${field} is empty`);
  if (value.length % 2 !== 0) throw new Error(`${field} has an odd number of hex characters`);
  if (!/^[0-9a-fA-F]+$/.test(value)) throw new Error(`${field} is not hexadecimal`);
  return Buffer.from(value, "hex");
}

export function build({ principal, manifestHash, salt }: Triple): Built {
  const text = principal.trim();
  if (text.length === 0) throw new Error("principal is empty");
  if (text !== text.toLowerCase()) throw new Error("principal is not lowercase");
  let parsed: Principal;
  try {
    parsed = Principal.fromText(text);
  } catch (error) {
    throw new Error(`principal invalid: ${(error as Error).message}`);
  }
  if (parsed.toText() !== text) throw new Error("principal is not in canonical form");

  const manifestBytes = hexToBytes("manifest", manifestHash);
  if (manifestBytes.length !== DIGEST_BYTES) {
    throw new Error(`manifest must be ${DIGEST_BYTES} bytes, got ${manifestBytes.length}`);
  }
  const saltBytes = hexToBytes("salt", salt);
  if (saltBytes.length < SALT_MIN || saltBytes.length > SALT_MAX) {
    throw new Error(`salt must be ${SALT_MIN}..${SALT_MAX} bytes, got ${saltBytes.length}`);
  }

  const zero = Buffer.from([0]);
  const preimage = Buffer.concat([
    Buffer.from(DOMAIN, "utf8"),
    zero,
    Buffer.from(text, "utf8"),
    zero,
    manifestBytes,
    zero,
    saltBytes,
  ]);
  return {
    preimageHex: preimage.toString("hex"),
    commitmentHex: createHash("sha256").update(preimage).digest("hex"),
  };
}
