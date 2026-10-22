#!/usr/bin/env node
// Bundles the CLI (bin/rnap.mjs and bin/cli/) into one minified file,
// lib/cli/rnap.mjs: what the package ships and `rnap` runs. The readable
// sources stay in bin/ for development and the tooling tests. Runs as part of
// `yarn prepare`, then smoke-tests the bundle.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'lib/cli/rnap.mjs');

await build({
  entryPoints: [path.join(ROOT, 'bin/rnap.mjs')],
  outfile: OUT,
  bundle: true,
  minify: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  legalComments: 'none',
  logLevel: 'warning',
});
fs.chmodSync(OUT, 0o755);

// The bundle sits at the same depth as bin/cli/, so its relative paths to
// package.json and plugin/ still resolve; prove it.
const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const reported = execFileSync(process.execPath, [OUT, '--version'], { encoding: 'utf8' }).trim();
if (!reported.includes(version)) {
  throw new Error(`lib/cli/rnap.mjs reports "${reported}", expected ${version}`);
}
console.log(`wrote ${path.relative(ROOT, OUT)} (${(fs.statSync(OUT).size / 1024).toFixed(1)} KB)`);
