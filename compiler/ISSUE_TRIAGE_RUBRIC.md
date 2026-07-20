# Issue Triage Rubric

## Classification

- parser/syntax
- type checker
- diagnostics/locations/autofix
- persistence/migration
- Candid/serialization
- codegen/Wasm validation
- runtime/GC
- performance
- JavaScript compiler/tooling
- documentation/downstream

## Severity

- P0: security/data loss/release blocker
- P1: incorrect compilation/runtime crash/common upgrade failure
- P2: wrong diagnostic/edge case/performance regression
- P3: docs/tooling/feature request

## Reproduction quality

- exact version
- minimal source
- exact command/flags
- expected/actual
- current master status
- regression range when available
- platform/target

## Next action

- needs reproduction
- needs spec decision
- test ready
- patch ready
- downstream only
- duplicate
