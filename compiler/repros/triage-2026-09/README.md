# Triage repros, September 2026

Snippets from open `caffeinelabs/motoko` issues, adapted to current Motoko
(`persistent` actors, `mo:core`), for [TRIAGE_2026-09.md](../../TRIAGE_2026-09.md).
Each file names its issue in its first line.

```bash
node compiler/repros/triage-2026-09/run.mjs <moc> [<another moc> ...]
```

`run.mjs` runs each file through `moc --check`, `moc -r` and `moc -c` and
prints the exit status and the line that says what happened. With no
arguments it uses the kit's pinned compiler. It is read-only and makes no
network calls.

| File | Issue | Status on moc 1.11.1 and 1.16.1 |
| --- | --- | --- |
| `FloatLiteralOverflow.mo` | #3464 | reproduces: `OOPS` (compiler bug) |
| `AwaitNone.mo` | #3819 | reproduces: `IR type error [M0000]` under `-c` |
| `FloatPattern.mo` | #4701 | reproduces: `compile_lit_pat: (FloatLit 0)` |
| `ObjectTerminalValue.mo` | #2017 | reproduces: accepted |
| `TopLevelAwait.mo` | #3624 | crash gone; `--check` passes, `-c` fails with M0038 |
| `OrPatterns.mo` | #3993 | does not reproduce (unannotated form: M0184) |
| `AsyncHelperName.mo` | #3117 | does not reproduce (helper is now `__motoko_async_helper`) |
| `ForwardImport.mo` | #4733 | does not reproduce |
| `DeprecationTwice.mo` | #3855 | does not reproduce |
