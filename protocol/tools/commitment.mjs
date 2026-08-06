// The v1 commitment layout, frozen.
//
// This is the byte layout `apps/01_creator_proof_registry` recomputes on-chain
// and any verifier recomputes off-chain. Once a record exists on mainnet the
// layout cannot change, because changing it invalidates every commitment ever
// made — so v1 is defined here exactly, and a future layout gets a new domain
// string rather than an edit to this one.
//
//   preimage = domain %x00 principal %x00 manifest-digest %x00 salt
//
//   domain          = %s"icp-creator-proof:v1"     ; 20 bytes, US-ASCII
//   principal       = 8*63(%x61-7A / %x32-37 / "-") ; canonical principal text
//   manifest-digest = 32OCTET                       ; SHA-256 of the canonical manifest
//   salt            = 16*64OCTET
//
//   commitment = SHA-256(preimage)                  ; 32 octets
//
// The full ABNF and the reasoning are in protocol/COMMITMENT_V1.md.
//
// The layout is unambiguous, and `parsePreimage` is the demonstration rather
// than the claim: every field boundary is recoverable from the bytes alone. The
// domain is a fixed literal; `principal` is base32 and dashes and therefore
// cannot contain %x00; `manifest-digest` is exactly 32 octets read positionally;
// and `salt` is last, so the %x00 octets it is allowed to contain cannot be
// mistaken for a separator.

import { createHash } from "node:crypto";
import { decode as decodePrincipal, PrincipalError } from "./principal.mjs";

export class CommitmentError extends Error {
  constructor(message) {
    super(message);
    this.name = "CommitmentError";
  }
}

export const VERSION = "v1";
export const DOMAIN = "icp-creator-proof:v1";
export const ALGORITHM = "sha256V1";
export const SEPARATOR = 0x00;
export const DIGEST_BYTES = 32;
export const SALT_MIN_BYTES = 16;
export const SALT_MAX_BYTES = 64;

const DOMAIN_BYTES = Buffer.from(DOMAIN, "utf8");
const ZERO = Buffer.from([SEPARATOR]);

function parseHex(field, value, exactBytes = null) {
  if (typeof value !== "string" || value.length === 0) {
    throw new CommitmentError(`${field} must be a non-empty hexadecimal string`);
  }
  if (value.length % 2 !== 0) {
    throw new CommitmentError(`${field} must have an even number of hexadecimal characters`);
  }
  if (!/^[0-9a-fA-F]+$/.test(value)) {
    throw new CommitmentError(`${field} must contain only hexadecimal characters`);
  }
  const bytes = Buffer.from(value, "hex");
  if (exactBytes !== null && bytes.length !== exactBytes) {
    throw new CommitmentError(`${field} must be exactly ${exactBytes} bytes, got ${bytes.length}`);
  }
  return bytes;
}

function checkPrincipal(principal) {
  // Trimmed, because a trailing newline from a shell pipeline is not a
  // different principal. Not lowercased: the preimage is defined over the
  // canonical form, and silently accepting `AAAAA-AA` would teach callers the
  // field is case-insensitive when the bytes that get hashed are not.
  const text = typeof principal === "string" ? principal.trim() : principal;
  try {
    decodePrincipal(text);
  } catch (error) {
    if (error instanceof PrincipalError) throw new CommitmentError(`principal: ${error.message}`);
    throw error;
  }
  return text;
}

function checkSalt(salt) {
  const bytes = parseHex("salt", salt);
  if (bytes.length < SALT_MIN_BYTES || bytes.length > SALT_MAX_BYTES) {
    throw new CommitmentError(
      `salt must be ${SALT_MIN_BYTES}..${SALT_MAX_BYTES} bytes, got ${bytes.length}`,
    );
  }
  return bytes;
}

/** The exact bytes SHA-256 is applied to. */
export function preimage({ principal, manifestHash, salt }) {
  const principalText = checkPrincipal(principal);
  const manifestBytes = parseHex("manifest hash", manifestHash, DIGEST_BYTES);
  const saltBytes = checkSalt(salt);
  return Buffer.concat([
    DOMAIN_BYTES,
    ZERO,
    Buffer.from(principalText, "utf8"),
    ZERO,
    manifestBytes,
    ZERO,
    saltBytes,
  ]);
}

/**
 * Recover the three fields from a preimage.
 *
 * Nothing in the protocol needs this. It exists so the conformance suite can
 * assert that the layout is injective — that every accepted triple is
 * recoverable from its own bytes — rather than asserting in prose that no two
 * triples can collide.
 */
export function parsePreimage(bytes) {
  const buffer = Buffer.from(bytes);
  if (!buffer.subarray(0, DOMAIN_BYTES.length).equals(DOMAIN_BYTES)) {
    throw new CommitmentError(`preimage does not start with the ${VERSION} domain`);
  }
  let at = DOMAIN_BYTES.length;
  if (buffer[at] !== SEPARATOR) throw new CommitmentError("missing separator after the domain");
  at += 1;

  const principalEnd = buffer.indexOf(SEPARATOR, at);
  if (principalEnd === -1) throw new CommitmentError("missing separator after the principal");
  const principal = buffer.subarray(at, principalEnd).toString("utf8");
  at = principalEnd + 1;

  if (buffer.length < at + DIGEST_BYTES + 1 + SALT_MIN_BYTES) {
    throw new CommitmentError("preimage is too short to hold a digest, a separator and a salt");
  }
  const manifestHash = buffer.subarray(at, at + DIGEST_BYTES).toString("hex");
  at += DIGEST_BYTES;
  if (buffer[at] !== SEPARATOR) throw new CommitmentError("missing separator after the manifest digest");
  at += 1;

  const salt = buffer.subarray(at).toString("hex");
  return { principal, manifestHash, salt };
}

/** The commitment as lowercase hexadecimal. */
export function commitmentHex(input) {
  return createHash("sha256").update(preimage(input)).digest("hex");
}

/** Recompute and compare, the operation a verifier actually performs. */
export function verify({ principal, manifestHash, salt, commitment }) {
  const calculated = commitmentHex({ principal, manifestHash, salt });
  const expected = typeof commitment === "string" ? commitment.trim().toLowerCase() : "";
  return { valid: /^[0-9a-f]{64}$/.test(expected) && expected === calculated, expected, calculated };
}

/** What `commitmentSpec()` on the canister reports, for comparison. */
export function spec() {
  return {
    version: VERSION,
    algorithm: ALGORITHM,
    domain: DOMAIN,
    layout: "domain-zero-principalText-zero-manifestDigest-zero-salt",
    digestSize: DIGEST_BYTES,
    minSaltSize: SALT_MIN_BYTES,
    maxSaltSize: SALT_MAX_BYTES,
  };
}
