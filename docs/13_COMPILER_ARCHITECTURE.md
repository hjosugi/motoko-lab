# Motoko Compiler Architecture

source repository: `caffeinelabs/motoko`

## Pipeline map

```text
Motoko source
  -> parser / source AST (`mo_frontend`, `mo_def`)
  -> type checking (`mo_frontend`, `mo_types`)
  -> lowering to IR (`lowering`, `ir_def`)
  -> IR passes (`ir_passes`)
  -> linking / Wasm extensions (`linking`, `wasm_exts`)
  -> code generation (`codegen`)
  -> Wasm + Candid/custom sections
```

Interpreters:

- source interpreter
- IR interpreter

Executables:

- `moc`
- `mo.js`
- `mo-ld`
- `didc`

## Reading strategy

1. `src/Structure.md`
2. CLI entry under executables
3. `pipeline/pipeline.ml`
4. one small source program
5. parser AST node
6. type rule
7. lowering output
8. IR pass
9. codegen
10. expected test output

## Development environment

upstream guidance:

```bash
git clone https://github.com/caffeinelabs/motoko.git
cd motoko
nix develop
make -C src
make -C rts
make -C test
nix build --no-link
```

Cachixを使わない場合、dependency buildに長時間かかり得ます。

## Debugging a compiler bug

- 10行未満の`.mo`へ縮小
- current releaseとmasterを比較
- parser/type/codegen/runtimeのどこで壊れるか分類
- diagnostic code、flags、targetを記録
- existing test directoryで類似testを探す
- fixより先にfailing testを書く

## High-value areas

- stable migration compatibility
- Candid decoding safety
- error diagnostics and machine-applicable fixes
- Wasm feature/tool compatibility
- incremental/64-bit persistence
- compiler performance and memory
- JavaScript compiler parity
- documentation synchronized with releases
