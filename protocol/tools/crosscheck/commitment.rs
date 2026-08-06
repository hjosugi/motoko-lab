// An implementation of the v1 commitment layout written from
// protocol/COMMITMENT_V1.md, sharing no code with the JavaScript one.
//
// Reads one vector per line as the JSON array `["principal","manifest-hex",
// "salt-hex"]` and writes `OK<TAB>preimage-hex<TAB>commitment-hex` or
// `ERR<TAB>reason`. JSON rather than a bare tab-separated line because one
// vector deliberately carries surrounding whitespace, and an escaping scheme
// that mangled it would manufacture a disagreement that is not there.
use candid::Principal;
use sha2::{Digest, Sha256};
use std::io::{self, BufRead, Write};

const DOMAIN: &[u8] = b"icp-creator-proof:v1";
const DIGEST_BYTES: usize = 32;
const SALT_MIN: usize = 16;
const SALT_MAX: usize = 64;

fn build(principal: &str, manifest_hex: &str, salt_hex: &str) -> Result<(Vec<u8>, String), String> {
    let text = principal.trim();
    if text.is_empty() {
        return Err("principal is empty".into());
    }
    if text != text.to_lowercase() {
        return Err("principal is not lowercase".into());
    }
    // `from_text` checks the base32 alphabet, the CRC32 checksum and the blob
    // length; comparing `to_text` back catches a non-canonical spelling.
    let parsed = Principal::from_text(text).map_err(|e| format!("principal invalid: {e}"))?;
    if parsed.to_text() != text {
        return Err("principal is not in canonical form".into());
    }

    let manifest = decode_hex("manifest", manifest_hex)?;
    if manifest.len() != DIGEST_BYTES {
        return Err(format!("manifest must be {DIGEST_BYTES} bytes, got {}", manifest.len()));
    }
    let salt = decode_hex("salt", salt_hex)?;
    if salt.len() < SALT_MIN || salt.len() > SALT_MAX {
        return Err(format!("salt must be {SALT_MIN}..{SALT_MAX} bytes, got {}", salt.len()));
    }

    let mut preimage = Vec::new();
    preimage.extend_from_slice(DOMAIN);
    preimage.push(0);
    preimage.extend_from_slice(text.as_bytes());
    preimage.push(0);
    preimage.extend_from_slice(&manifest);
    preimage.push(0);
    preimage.extend_from_slice(&salt);

    let commitment = hex::encode(Sha256::digest(&preimage));
    Ok((preimage, commitment))
}

fn decode_hex(field: &str, value: &str) -> Result<Vec<u8>, String> {
    if value.is_empty() {
        return Err(format!("{field} is empty"));
    }
    if value.len() % 2 != 0 {
        return Err(format!("{field} has an odd number of hex characters"));
    }
    hex::decode(value).map_err(|_| format!("{field} is not hexadecimal"))
}

fn main() {
    let stdin = io::stdin();
    let mut out = io::stdout().lock();
    for line in stdin.lock().lines() {
        let line = line.unwrap();
        if line.is_empty() {
            continue;
        }
        let parts: Vec<String> = serde_json::from_str(&line).expect("each line must be a JSON array of three strings");
        let principal = parts.first().map(String::as_str).unwrap_or("");
        let manifest = parts.get(1).map(String::as_str).unwrap_or("");
        let salt = parts.get(2).map(String::as_str).unwrap_or("");
        match build(principal, manifest, salt) {
            Ok((preimage, commitment)) => {
                writeln!(out, "OK\t{}\t{}", hex::encode(preimage), commitment).unwrap()
            }
            Err(reason) => writeln!(out, "ERR\t{reason}").unwrap(),
        }
    }
}
