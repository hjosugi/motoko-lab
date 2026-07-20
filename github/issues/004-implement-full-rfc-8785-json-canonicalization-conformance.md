---
title: "Implement full RFC 8785 JSON canonicalization conformance"
labels: ["priority:P0", "area:provenance", "area:crypto", "type:feature", "effort:XL"]
milestone: "M1 Protocol Core"
---
# Context

The included CLI uses recursive key sorting but is not a complete JSON Canonicalization Scheme implementation.

## Scope

- [ ] Choose maintained RFC 8785 implementations for TypeScript and Rust verifier paths.
- [ ] Define Motoko responsibility: raw digest only or canonicalization library.
- [ ] Reject duplicate keys and unsupported numeric cases before hashing.
- [ ] Add Unicode and number edge vectors.
- [ ] Version canonicalization in the manifest.

## Acceptance criteria

- [ ] Official RFC vectors pass.
- [ ] TypeScript/Rust/Motoko digest outputs agree for supported inputs.
- [ ] Failure behavior is deterministic.
- [ ] Docs stop calling the educational subset production-ready.

## Test plan

- [ ] Unicode normalization cases
- [ ] -0 and exponent formatting
- [ ] Escaping and surrogate cases

## Dependencies

#001

## Out of scope

- Unrelated refactors.
- Mainnet rollout before the acceptance criteria and security gates pass.

## Evidence to attach

- Exact tool and dependency versions.
- Commands and logs.
- Before/after behavior.
- Candid and stable-data impact.
- Performance/security notes where relevant.
