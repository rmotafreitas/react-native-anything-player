import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { bareBroken, bareGood, makeDir, runCli } from './cli-fixtures.mjs';
import { tilde } from '../../bin/cli/info.mjs';
import { cliVersion } from '../../bin/cli/cli.mjs';

test('paths under the home directory print as ~', () => {
  const home = os.homedir();
  assert.equal(tilde(home), '~');
  assert.equal(tilde(path.join(home, 'apps', 'radio')), '~/apps/radio');
  assert.equal(tilde('/tmp/radio'), '/tmp/radio');
  assert.equal(tilde(null), null);
});

test('info --json has versions, modules and the doctor summary', (t) => {
  const root = bareGood(t);
  const result = runCli(['info', '--json'], { cwd: root });

  assert.equal(result.status, 0);
  assert.equal(result.json.schemaVersion, 1);
  assert.equal(result.json.command, 'info');
  assert.equal(result.json.cli.version, cliVersion());
  assert.match(result.json.collectedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.match(result.json.environment.node, /^v\d+/);
  assert.equal(result.json.project.kind, 'bare');
  assert.equal(result.json.project.reactNative, '0.86.3');
  assert.equal(result.json.project.library.version, '0.1.0');
  assert.equal(result.json.project.library.installed, true);
  assert.deepEqual(result.json.project.modules.on, [
    'hls',
    'assistant',
    'background-audio',
  ]);
  assert.deepEqual(result.json.project.modules.off, [
    'cast',
    'siri',
    'sound',
    'car',
    'video',
  ]);
  assert.equal(result.json.doctor.ok, true);
  assert.deepEqual(result.json.doctor.summary, {
    errors: 0,
    warnings: 0,
    infos: 0,
  });
});

test('info is a report: errors are listed and the exit code stays 0', (t) => {
  const root = bareBroken(t);
  const result = runCli(['info', '--json'], { cwd: root });

  assert.equal(result.status, 0);
  assert.equal(result.json.doctor.ok, false);
  assert.ok(result.json.doctor.summary.errors > 0);
  const ids = result.json.doctor.findings.map((finding) => finding.id);
  assert.ok(ids.includes('ios-background-audio'));
});

test('info still explains a directory without a package.json', (t) => {
  const root = makeDir(t);
  const result = runCli(['info', '--json'], { cwd: root });

  assert.equal(result.status, 0);
  assert.equal(result.json.project.reactNative, null);
  const ids = result.json.doctor.findings.map((finding) => finding.id);
  assert.deepEqual(ids, ['project-package-json']);
});

test('info prints sections a person can paste into an issue', (t) => {
  const root = bareGood(t);
  const result = runCli(['info'], { cwd: root });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /^RNAP info \d+\.\d+\.\d+$/m);
  assert.match(result.stdout, /Environment/);
  assert.match(result.stdout, /Project/);
  assert.match(result.stdout, /Modules on\s+hls, assistant, background-audio/);
  assert.match(result.stdout, /Doctor/);
  assert.match(result.stdout, /Findings\s+0 errors, 0 warnings, 0 info/);
});
