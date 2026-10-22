import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  bareBroken,
  bareGood,
  expoNoPlugin,
  read,
  runCli,
  write,
} from './cli-fixtures.mjs';

function withoutBackgroundAudio(t) {
  const root = bareGood(t);
  const file = path.join(root, 'ios/App/Info.plist');
  const text = fs
    .readFileSync(file, 'utf8')
    .replace(
      /\t<key>UIBackgroundModes<\/key>\n\t<array>\n\t\t<string>audio<\/string>\n\t<\/array>\n/,
      ''
    );
  fs.writeFileSync(file, text);
  return root;
}

test('init adds the Expo plugin and leaves unrelated config alone', (t) => {
  const root = expoNoPlugin(t);
  const before = read(root, 'app.json');
  const result = runCli(['init', '--yes'], { cwd: root });

  assert.match(result.stdout, /--- a\/app\.json/);
  assert.match(result.stdout, /"react-native-anything-player"/);
  assert.equal(result.status, 0, result.stdout);

  const config = JSON.parse(read(root, 'app.json'));
  assert.deepEqual(config.expo.plugins, ['react-native-anything-player']);
  assert.equal(config.expo.userInterfaceStyle, 'dark');
  assert.deepEqual(config.expo.extra, { apiUrl: 'https://example.test' });
  assert.equal(config.expo.ios.bundleIdentifier, 'com.example.app');
  assert.match(before, /"userInterfaceStyle": "dark"/);

  const doctor = runCli(['doctor', '--json', '--cwd', root], { cwd: root });
  assert.equal(doctor.json.summary.errors, 0);
});

test('init is idempotent: a second run has nothing to do', (t) => {
  const root = expoNoPlugin(t);
  runCli(['init', '--yes'], { cwd: root });
  const second = runCli(['init', '--yes', '--json'], { cwd: root });
  assert.deepEqual(second.json.applied, []);
  assert.deepEqual(second.json.skipped, []);
  assert.equal(second.json.dryRun, false);
  assert.equal(second.status, 0);
});

test('init fixes the bare project files it owns, one diff each', (t) => {
  const root = bareBroken(t);
  const result = runCli(['init', '--yes'], { cwd: root });

  assert.match(result.stdout, /--- a\/ios\/App\/Info\.plist/);
  assert.match(result.stdout, /--- a\/ios\/Podfile\.properties\.json/);
  assert.match(result.stdout, /--- a\/android\/gradle\.properties/);

  const plist = read(root, 'ios/App/Info.plist');
  assert.match(plist, /<key>UIBackgroundModes<\/key>/);
  assert.match(plist, /<string>audio<\/string>/);
  assert.match(plist, /<string>Broken<\/string>/); // unrelated key kept

  const properties = JSON.parse(read(root, 'ios/Podfile.properties.json'));
  assert.equal(properties.newArchEnabled, 'true');

  assert.match(
    read(root, 'android/gradle.properties'),
    /^newArchEnabled=true$/m
  );

  // Errors the CLI cannot fix are still reported, so the exit code stays 1.
  assert.equal(result.status, 1);
  assert.match(result.stdout, /react-native-version/);
  assert.match(result.stdout, /Still to fix:/);
});

test('init --json without --yes is a dry run', (t) => {
  const root = bareBroken(t);
  const before = read(root, 'ios/App/Info.plist');
  const result = runCli(['init', '--json'], { cwd: root });

  assert.equal(result.json.dryRun, true);
  assert.deepEqual(result.json.applied, []);
  assert.ok(result.json.skipped.length >= 3);
  assert.equal(read(root, 'ios/App/Info.plist'), before);
  assert.equal(result.status, 1);
});

test('init asks per change and respects a no', (t) => {
  const root = withoutBackgroundAudio(t);
  const refused = runCli(['init'], { cwd: root, input: 'n\n' });
  assert.match(refused.stdout, /Apply this change\? \[y\/N\]/);
  assert.match(refused.stdout, /Skipped\./);
  assert.doesNotMatch(read(root, 'ios/App/Info.plist'), /UIBackgroundModes/);
  assert.equal(refused.status, 1);

  const accepted = runCli(['init'], { cwd: root, input: 'y\n' });
  assert.match(accepted.stdout, /Applied\./);
  assert.match(read(root, 'ios/App/Info.plist'), /<string>audio<\/string>/);
  assert.equal(accepted.status, 0, accepted.stdout);
});

test('init writes only inside the project', (t) => {
  const root = expoNoPlugin(t);
  const outside = path.join(path.dirname(root), 'rnap-outside-marker.json');
  write(path.dirname(root), path.basename(outside), '{"untouched":true}\n');
  try {
    runCli(['init', '--yes'], { cwd: root });
    assert.deepEqual(JSON.parse(fs.readFileSync(outside, 'utf8')), {
      untouched: true,
    });
  } finally {
    fs.rmSync(outside, { force: true });
  }
});

test('init with no input skips instead of hanging', (t) => {
  const root = withoutBackgroundAudio(t);
  const result = runCli(['init'], { cwd: root, input: '' });
  assert.equal(result.signal, null);
  assert.match(result.stdout, /Skipped\./);
  assert.match(result.stdout, /0 changes applied\./);
  assert.equal(result.status, 1);
});

test('init never writes through a symlink to a file outside the project', (t) => {
  const root = withoutBackgroundAudio(t);
  const outside = fs.mkdtempSync(
    path.join(path.dirname(root), 'rnap-outside-')
  );
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const target = path.join(outside, 'Info.plist');
  const plistFile = path.join(root, 'ios/App/Info.plist');
  fs.renameSync(plistFile, target);
  fs.symlinkSync(target, plistFile);
  const before = fs.readFileSync(target, 'utf8');

  runCli(['init', '--yes'], { cwd: root });

  assert.equal(fs.readFileSync(target, 'utf8'), before);
  assert.ok(fs.lstatSync(plistFile).isSymbolicLink());
});
