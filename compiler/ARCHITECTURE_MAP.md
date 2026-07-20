# Architecture Map

| Directory | Responsibility |
|---|---|
| `src/lib` | general OCaml utilities |
| `src/lang_utils` | environments, diagnostics, source locations |
| `src/mo_def` | Motoko AST and pretty printer |
| `src/mo_types` | source/IR type definitions |
| `src/mo_values` | values and primitive operations |
| `src/mo_frontend` | parser and type checker |
| `src/ir_def` | IR AST/type checker |
| `src/lowering` | source to IR lowering |
| `src/ir_passes` | IR transformations |
| `src/wasm_exts` | Wasm custom sections |
| `src/linking` | Wasm linking |
| `src/codegen` | backend instruction generation |
| `src/pipeline` | orchestration, flags, prelude |
| `rts` | runtime system |
| `test` | regression/integration tests |

`src/Structure.md`をsource of truthとして更新を確認します。
