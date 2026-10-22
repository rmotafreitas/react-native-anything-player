#!/usr/bin/env node
// Checks the ESM build after `bob build`: every relative import in lib/module
// (static, re-export or `import()`) names its file, as strict ESM resolvers
// (browsers, Node, webpack's `fullySpecified`) require. bob leaves two kinds
// without an extension on purpose, for React Native bundlers to resolve: files
// with platform variants (`x.web.js`, `x.ios.js`) and Codegen specs (kept as
// TypeScript).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LIB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../lib/module');
const PLATFORM_VARIANTS = ['.web.js', '.ios.js', '.android.js', '.native.js', '.ts'];

const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.{1,2}\/[^'"]*)\1/g;

function* files(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* files(p);
    else if (p.endsWith('.js')) yield p;
  }
}

const problems = [];
for (const file of files(LIB)) {
  const code = fs.readFileSync(file, 'utf8');
  for (const [, , specifier] of code.matchAll(SPECIFIER)) {
    const target = path.resolve(path.dirname(file), specifier);
    const named = /\.(c|m)?js(on)?$/.test(specifier) && fs.existsSync(target);
    const platformResolved = PLATFORM_VARIANTS.some((ext) => fs.existsSync(target + ext));
    if (!named && !platformResolved)
      problems.push(`${path.relative(LIB, file)}: ${specifier}`);
  }
}
if (problems.length > 0) {
  console.error(`lib/module has imports a strict ESM resolver cannot follow:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('lib/module: every relative import names an existing file');
