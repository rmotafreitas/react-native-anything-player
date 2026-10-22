import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import {
  ChangedSinceDiffError,
  applyChange,
  buildChange,
  editJson,
  editJsonDetailed,
  reviewChanges,
} from '../../bin/cli/edits.mjs';
import { setPluginOption } from '../../bin/cli/modules.mjs';
import { makeDir, read, write } from './cli-fixtures.mjs';

function sink() {
  let text = '';
  const stream = new Writable({
    write(chunk, encoding, done) {
      text += chunk;
      done();
    },
  });
  return { stream, text: () => text };
}

const plain = (value) => value;

function prepare(root, file, after) {
  return buildChange({
    cwd: root,
    file,
    before: read(root, file),
    after,
    change: 'edit',
  });
}

test('a change is refused when the file changed after the diff was prepared', (t) => {
  const root = makeDir(t);
  write(root, 'a.txt', 'one\n');
  const change = prepare(root, 'a.txt', 'two\n');

  write(root, 'a.txt', 'one\nedited meanwhile\n');
  assert.throws(() => applyChange(change), ChangedSinceDiffError);
  assert.equal(read(root, 'a.txt'), 'one\nedited meanwhile\n');
  assert.deepEqual(fs.readdirSync(root), ['a.txt']);
});

test('an unchanged file is replaced atomically and keeps its mode', (t) => {
  const root = makeDir(t);
  const file = write(root, 'run.sh', 'echo one\n');
  fs.chmodSync(file, 0o755);
  applyChange(prepare(root, 'run.sh', 'echo two\n'));

  assert.equal(read(root, 'run.sh'), 'echo two\n');
  assert.equal(fs.statSync(file).mode & 0o777, 0o755);
  assert.deepEqual(fs.readdirSync(root), ['run.sh']);
});

test('a new file is created, and refused when one appeared meanwhile', (t) => {
  const root = makeDir(t);
  const change = buildChange({
    cwd: root,
    file: 'gradle.properties',
    before: '',
    after: 'rnapCast=true\n',
    change: 'create',
    create: true,
  });
  write(root, 'gradle.properties', 'org.gradle.jvmargs=-Xmx2g\n');
  assert.throws(() => applyChange(change), ChangedSinceDiffError);
  assert.equal(read(root, 'gradle.properties'), 'org.gradle.jvmargs=-Xmx2g\n');

  fs.rmSync(path.join(root, 'gradle.properties'));
  applyChange(change);
  assert.equal(read(root, 'gradle.properties'), 'rnapCast=true\n');
});

test('reviewChanges reports a stale file, leaves it, and goes on', async (t) => {
  const root = makeDir(t);
  write(root, 'a.txt', 'a\n');
  write(root, 'b.txt', 'b\n');
  const changes = [prepare(root, 'a.txt', 'A\n'), prepare(root, 'b.txt', 'B\n')];
  write(root, 'a.txt', 'a, edited\n');

  const out = sink();
  const result = await reviewChanges({
    changes,
    yes: true,
    dryRun: false,
    paint: plain,
    stdout: out.stream,
    stdin: null,
  });
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].error, /a\.txt changed since the diff was shown/);
  assert.match(out.text(), /run the command again/);
  assert.deepEqual(result.applied.map((change) => change.file), ['b.txt']);
  assert.equal(read(root, 'a.txt'), 'a, edited\n');
  assert.equal(read(root, 'b.txt'), 'B\n');
});

const APP_JSON = `{
    "expo": {
        "name": "App",   "slug": "app",
        "plugins": [
            "expo-router",
            ["react-native-anything-player", {"cast": false}]
        ],
        "ios": { "bundleIdentifier": "com.example.app" }
    }
}
`;

test('a JSON edit changes only the lines it touches', () => {
  const after = setPluginOption(APP_JSON, 'cast', true);
  assert.equal(after.note, null);
  assert.equal(after.text, APP_JSON.replace('"cast": false', '"cast": true'));

  const added = setPluginOption(APP_JSON, 'siri', true);
  assert.equal(
    added.text,
    APP_JSON.replace('{"cast": false}', '{"cast": false, "siri": true}')
  );
});

test('a plugin listed as a bare string becomes an entry with options', () => {
  const text = `{
  "expo": {
    "plugins": [
      "expo-router",
      "react-native-anything-player"
    ],
    "name": "App"
  }
}
`;
  const { text: after } = setPluginOption(text, 'cast', true);
  assert.equal(
    after,
    text.replace(
      '"react-native-anything-player"\n',
      '["react-native-anything-player", { "cast": true }]\n'
    )
  );
  assert.equal(
    JSON.parse(after).expo.plugins[1][1].cast,
    true
  );
});

test('a new top-level key is appended with the file\'s own indent and EOL', () => {
  const text = '{\r\n\t"newArchEnabled": "true"\r\n}\r\n';
  const after = editJson(text, (properties) => {
    properties['rnap.cast'] = 'true';
  });
  assert.equal(
    after,
    '{\r\n\t"newArchEnabled": "true",\r\n\t"rnap.cast": "true"\r\n}\r\n'
  );
  assert.equal(
    editJson('{}', (properties) => {
      properties.a = 'b';
    }),
    '{ "a": "b" }'
  );
});

test('a JSON edit with no way to patch falls back and says so', () => {
  const text = '{\n    "a": 1,\n    "b": 2\n}\n';
  const result = editJsonDetailed(text, (value) => {
    delete value.a;
  });
  assert.equal(result.text, '{\n    "b": 2\n}\n');
  assert.match(result.note, /rewritten in full/);
  assert.equal(editJsonDetailed(text, () => false), null);
});
