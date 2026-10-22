// What `npm pack` ships: everything an app's build reads from the package.
// The example apps build from the workspace sources, so a file left out of
// `files` only shows up in an app installed from the tarball.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
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
const output = execFileSync(
  'npm',
  ['pack', '--dry-run', '--json', '--ignore-scripts'],
  {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }
);
const packed = new Set(
  JSON.parse(output.slice(output.search(/^\[/m)))[0].files.map((f) => f.path)
);

test('ships the Codegen specs the app builds its native glue from', () => {
  const dir = pkg.codegenConfig.jsSrcsDir;
  const specs = fs
    .readdirSync(path.join(ROOT, dir))
    .filter((f) => /\.(ts|tsx|js)$/.test(f));
  assert.ok(specs.length > 0);
  for (const spec of specs)
    assert.ok(packed.has(`${dir}/${spec}`), `${dir}/${spec} is not packed`);
});

test('ships the native build files', () => {
  for (const file of [
    'android/build.gradle',
    'app.plugin.js',
    'lib/cli/rnap.mjs',
  ].filter(
    (f) => f !== 'lib/cli/rnap.mjs' || fs.existsSync(path.join(ROOT, f))
  ))
    assert.ok(packed.has(file), `${file} is not packed`);
  assert.ok(
    [...packed].some((f) => f.endsWith('.podspec')),
    'no podspec is packed'
  );
});

test('ships every file the exports map points to (after a build)', (t) => {
  if (!fs.existsSync(path.join(ROOT, 'lib/module/index.js')))
    return t.skip('lib/ is not built');
  for (const entry of Object.values(pkg.exports)) {
    const targets =
      typeof entry === 'string'
        ? [entry]
        : Object.entries(entry)
            .filter(
              ([condition]) =>
                condition !== 'react-native-anything-player-source'
            )
            .map(([, target]) => target);
    for (const target of targets)
      assert.ok(
        packed.has(target.replace(/^\.\//, '')),
        `${target} is not packed`
      );
  }
});
