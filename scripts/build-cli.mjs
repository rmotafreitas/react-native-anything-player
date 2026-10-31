#!/usr/bin/env node
// Bundles the CLI (bin/rnap.mjs and bin/cli/) into one minified file,
// lib/cli/rnap.mjs: what the package ships and `rnap` runs. The readable
// sources stay in bin/ for development and the tooling tests. Runs as part of
// `yarn prepare`, then smoke-tests the bundle.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { deriveSizeData } from '../bin/cli/size-data.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'lib/cli/rnap.mjs');

const readJson = (file) =>
  JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
const sizeData = deriveSizeData(
  readJson('benchmarks/results/apk.json'),
  readJson('benchmarks/results/size.json')
);

await build({
  entryPoints: [path.join(ROOT, 'bin/rnap.mjs')],
  outfile: OUT,
  bundle: true,
  minify: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  legalComments: 'none',
  // Loaded from the app at run time (`rnap migrate`), not shipped: it is 300+ KB.
  external: ['@babel/parser'],
  logLevel: 'warning',
  define: { __RNAP_SIZE_DATA__: JSON.stringify(sizeData) },
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

// The catalog an app bundles (the Expo plugin's `catalog` option), built at
// prebuild in Node by the library's own setCatalog serialization.
const SEED = path.join(ROOT, 'lib/plugin/catalogSeed.cjs');
await build({
  entryPoints: [path.join(ROOT, 'src/core/catalogSeed.ts')],
  outfile: SEED,
  bundle: true,
  minify: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  legalComments: 'none',
  logLevel: 'warning',
});
const seed = createRequire(import.meta.url)(SEED).catalogSeed({
  items: [{ id: 'a', title: 'A', source: 'https://example.com/a.mp3' }],
});
if (seed.items?.[0]?.source?.uri !== 'https://example.com/a.mp3') {
  throw new Error(`lib/plugin/catalogSeed.cjs serialized ${JSON.stringify(seed)}`);
}
console.log(`wrote ${path.relative(ROOT, SEED)} (${(fs.statSync(SEED).size / 1024).toFixed(1)} KB)`);
