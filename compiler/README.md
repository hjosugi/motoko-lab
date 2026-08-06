# Motoko Compiler Maintainer Track

## Start

0. `repros/` — reductions of compiler bugs found while using the kit, each with
   the versions it was confirmed on and what still needs deciding before an
   upstream report
1. `BOOTSTRAP.md`
2. `ARCHITECTURE_MAP.md`
3. `ISSUE_TRIAGE_RUBRIC.md`
4. `FIRST_10_PRS.md`
5. `RELEASE_CHECKLIST.md`

## Goal

compiler maintainerは、codeを書くだけでなく、language compatibility、runtime safety、diagnostics、downstream tools、release riskを扱います。

## First exercise

```motoko
persistent actor {
  public query func add(a : Nat, b : Nat) : async Nat { a + b };
}
```

このprogramがparser、type checker、IR、codegen、Candid outputをどう通るかsourceで追跡し、`notes/compiler-trace.md`へ記録します。
