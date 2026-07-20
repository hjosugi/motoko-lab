# Motoko Maintainer Path

## “メンテナになる”を分解する

1. reliable user: reproductionとminimal exampleを作れる
2. ecosystem contributor: docs/sample/package/toolingを直せる
3. compiler contributor: regression testとsmall fixを出せる
4. subsystem owner: parser/type checker/codegen/runtimeの一領域を継続保守
5. release/community maintainer: triage、compatibility、release riskを判断

## Required skills

- Motoko language/reference/Candid
- OCaml module、pattern matching、Dune
- Nix flakes、Cachix、reproducible build
- Wasm instruction、memory model、custom sections
- compiler frontend、typed AST、IR、optimization、codegen
- runtime/GC/persistence/upgrades
- property/regression/performance testing
- issue triage and technical writing

## First 10 contributions

1. documentation typo with verification
2. outdated sample update
3. minimal reproduction for open issue
4. missing regression test
5. diagnostic wording improvement
6. error location/span test
7. small parser edge case
8. type checker false-positive/negative fix
9. performance benchmark
10. codegen/runtime fix with before/after Wasm/test

## Contribution quality

- one PR, one behavior change
- issue link and minimal reproduction
- expected vs actual
- regression test fails before, passes after
- compatibility/performance impact
- changelog when user-visible
- no speculative refactor mixed into fix

## Weekly routine

- Monday: recent changelog/issues/PRs
- Tuesday: reproduce one bug
- Wednesday: source trace and test
- Thursday: patch/review
- Friday: documentation note and community answer

## Credibility signals

- repeated small merged PRs
- high-quality issue triage
- test ownership
- release note contribution
- migration guide
- performance data
- respectful review comments
- long-term follow-through
