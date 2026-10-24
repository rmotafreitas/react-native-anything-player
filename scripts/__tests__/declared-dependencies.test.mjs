// Every package the tooling imports must be declared: one that only resolves
// because another package pulls it in vanishes when that package changes
// (esbuild came with Vite 6 and left with Vite 8, breaking the CLI build).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..'
);
const pkg = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')
);
const declared = new Set([
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.devDependencies ?? {}),
  ...Object.keys(pkg.peerDependencies ?? {}),
]);
const builtins = new Set(builtinModules);

function* sources(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__' && entry.name !== 'node_modules')
        yield* sources(full);
    } else if (/\.m?js$/.test(entry.name)) yield full;
  }
}

/** `a` → `a`, `@s/a/b` → `@s/a`, `a/b` → `a`. */
function packageOf(specifier) {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

test('the tooling imports only declared packages', () => {
  const missing = [];
  for (const dir of ['scripts', 'bin']) {
    for (const file of sources(path.join(ROOT, dir))) {
      const text = fs.readFileSync(file, 'utf8');
      const specifiers = [
        ...text.matchAll(/^\s*import\s[^'"]*?from\s+['"]([^'"]+)['"]/gm),
        ...text.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm),
      ].map((m) => m[1]);
      for (const specifier of specifiers) {
        if (specifier.startsWith('.') || specifier.startsWith('node:'))
          continue;
        const name = packageOf(specifier);
        if (builtins.has(name) || declared.has(name)) continue;
        missing.push(`${path.relative(ROOT, file)}: ${specifier}`);
      }
    }
  }
  assert.deepEqual(missing, []);
});
