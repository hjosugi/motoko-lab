#!/usr/bin/env node
// Runs every repro in this directory against one or more `moc` binaries and
// prints one line per (repro, mode): exit status and the first line that says
// what happened. Read-only: nothing here talks to GitHub.
//
//   node compiler/repros/triage-2026-09/run.mjs /path/to/moc [/path/to/other/moc ...]
//
// With no arguments it uses the kit's pinned compiler (`mops toolchain bin moc`
// from apps/01_creator_proof_registry).

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = mkdtempSync(resolve(tmpdir(), 'triage-'));
// Repros that import `mo:core` get the kit's pinned core 2.6.0.
const core = resolve(here, '../../../apps/01_creator_proof_registry/.mops/core@2.6.0/src');
const packages = (file) => (readFileSync(resolve(here, file), 'utf8').includes('"mo:core/') ? ['--package', 'core', core] : []);
const MODES = {
  check: (file) => [...packages(file), '--check', file],
  interpret: (file) => [...packages(file), '-r', file],
  compile: (file) => [...packages(file), '-c', file, '-o', resolve(out, 'out.wasm')],
};

const compilers = process.argv.slice(2);
if (!compilers.length) {
  compilers.push(execFileSync('mops', ['toolchain', 'bin', 'moc'], { cwd: resolve(here, '../../../apps/01_creator_proof_registry') }).toString().trim());
}

// The line worth reporting: a crash banner, an error code, or a trap.
function summarize(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean).filter((l) => !/^note:|^\|/.test(l));
  const deprecations = lines.filter((l) => /M0154/.test(l)).length;
  if (deprecations) return `${deprecations} deprecation warning(s) [M0154]`;
  const telling = lines.find((l) => /OOPS|Fatal error|IR type error|error \[M\d{4}\]|trap|Assert_failure|exception|failed/i.test(l));
  return (telling ?? lines[0] ?? '').slice(0, 140);
}

for (const moc of compilers) {
  const version = execFileSync(moc, ['--version']).toString().trim();
  console.log(`## ${version}`);
  for (const file of readdirSync(here).filter((f) => f.endsWith('.mo')).sort()) {
    for (const [mode, args] of Object.entries(MODES)) {
      const result = spawnSync(moc, args(file), { cwd: here, encoding: 'utf8' });
      console.log(`${file.padEnd(26)} ${mode.padEnd(9)} exit=${result.status} ${summarize(result.stdout + result.stderr)}`);
    }
  }
}
