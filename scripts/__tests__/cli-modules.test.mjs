import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  bareGood,
  expoGood,
  expoJsConfig,
  expoPluginOptions,
  findingsOf,
  makeDir,
  read,
  runCli,
  write,
} from './cli-fixtures.mjs';
import { parsePlist } from '../../bin/cli/plist.mjs';
import {
  MODULE_IDS,
  findModule,
  expoOptions,
} from '../../bin/cli/modules.mjs';

const byId = (report, id) => report.modules.find((item) => item.id === id);

test('every module has an id, a description, a platform and a docs anchor', () => {
  assert.deepEqual(MODULE_IDS, [
    'hls',
    'cast',
    'siri',
    'assistant',
    'background-audio',
    'sound',
    'car',
  ]);
  for (const id of MODULE_IDS) {
    const module = findModule(id);
    assert.match(module.label, /\S/);
    assert.match(module.description, /\S/);
    assert.ok(module.platforms.length > 0);
    assert.match(module.docs, /^docs\/.+\.md(#.+)?$/);
  }
  assert.equal(findModule('nope'), null);
});

test('the Expo plugin options come from the registry', () => {
  assert.deepEqual(
    expoOptions().map((option) => option.key),
    ['cast', 'siri', 'assistant', 'backgroundAudio', 'sound', 'car']
  );
});

test('modules lists every module and where its state comes from', (t) => {
  const root = bareGood(t);
  const result = runCli(['modules', '--json'], { cwd: root });

  assert.equal(result.status, 0);
  assert.equal(result.json.schemaVersion, 1);
  assert.equal(result.json.command, 'modules');
  assert.deepEqual(result.json.project, {
    kind: 'bare',
    ios: true,
    android: true,
  });
  assert.equal(result.json.summary.on, 3);
  assert.equal(result.json.summary.total, 7);

  const hls = byId(result.json, 'hls');
  assert.equal(hls.effective, true);
  assert.equal(hls.source, 'default');
  assert.deepEqual(hls.size, { r8: 65536, noR8: 98304 });
  assert.equal(hls.sizeNote, null);

  const cast = byId(result.json, 'cast');
  assert.equal(cast.effective, false);
  assert.equal(cast.source, 'default');
  assert.deepEqual(cast.size, { r8: 1467731, noR8: 7391451 });

  // iOS-only modules still carry their platform note.
  assert.equal(byId(result.json, 'siri').size, null);
  assert.match(byId(result.json, 'siri').sizeNote, /iOS only/);

  // Assistant is manual: it is on because the manifest and the activity say so.
  const assistant = byId(result.json, 'assistant');
  assert.equal(assistant.effective, true);
  assert.equal(assistant.source, 'manual');

  const background = byId(result.json, 'background-audio');
  assert.equal(background.effective, true);
  assert.equal(background.source, 'Info.plist');
});

test('modules prints the one-line summary and the next commands', (t) => {
  const root = bareGood(t);
  const result = runCli(['modules'], { cwd: root });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /3 of 7 on/);
  assert.match(result.stdout, /npx rnap add <module>/);
  assert.match(result.stdout, /npx rnap size/);
  assert.match(result.stdout, /64 KB of the default build/);
});

test('an Expo project reads the plugin defaults', (t) => {
  const root = expoGood(t);
  const result = runCli(['modules', '--json'], { cwd: root });
  assert.equal(result.status, 0);
  assert.equal(result.json.project.kind, 'expo');
  assert.equal(byId(result.json, 'hls').effective, true);
  assert.equal(byId(result.json, 'assistant').effective, true);
  assert.equal(byId(result.json, 'background-audio').effective, true);
  assert.equal(byId(result.json, 'cast').effective, false);
  assert.equal(byId(result.json, 'cast').source, 'default');
});

test('plugin options win over the defaults, and say so', (t) => {
  const root = expoPluginOptions(t);
  const result = runCli(['modules', '--json'], { cwd: root });
  const background = byId(result.json, 'background-audio');
  assert.equal(background.effective, false);
  assert.equal(background.source, 'app.json');
  assert.equal(byId(result.json, 'assistant').effective, false);
  assert.equal(byId(result.json, 'assistant').source, 'app.json');
});

test('add turns a module on in every native place the project has', (t) => {
  const root = bareGood(t);
  const result = runCli(['add', 'cast', '--yes'], { cwd: root });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /rnapCast=true/);
  assert.match(result.stdout, /pod install/);

  assert.match(read(root, 'android/gradle.properties'), /^rnapCast=true$/m);
  assert.deepEqual(JSON.parse(read(root, 'ios/Podfile.properties.json')), {
    'rnap.cast': 'true',
  });

  const info = parsePlist(read(root, 'ios/App/Info.plist'));
  assert.deepEqual(info.NSBonjourServices, [
    '_googlecast._tcp',
    '_CC1AD845._googlecast._tcp',
  ]);
  assert.match(info.NSLocalNetworkUsageDescription, /Cast devices/);

  const modules = runCli(['modules', '--json'], { cwd: root });
  const cast = byId(modules.json, 'cast');
  assert.equal(cast.effective, true);
  assert.equal(cast.source, 'android/gradle.properties');

  const doctor = runCli(['doctor', '--json'], { cwd: root });
  assert.equal(doctor.json.ok, true);
  assert.ok(!findingsOf(doctor.json).includes('module-conflict'));
});

test('add --dry-run shows the diff and writes nothing', (t) => {
  const root = bareGood(t);
  const gradleBefore = read(root, 'android/gradle.properties');
  const plistBefore = read(root, 'ios/App/Info.plist');
  const result = runCli(['add', 'cast', '--dry-run'], { cwd: root });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /^\+\+\+ b\/android\/gradle\.properties$/m);
  assert.match(result.stdout, /Dry run: \d+ files would change, nothing written\./);
  assert.equal(read(root, 'android/gradle.properties'), gradleBefore);
  assert.equal(read(root, 'ios/App/Info.plist'), plistBefore);
});

test('adding a module that is already on changes nothing', (t) => {
  const root = bareGood(t);
  const result = runCli(['add', 'hls', '--yes'], { cwd: root });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /hls is already on in this project/);
});

test('remove takes the switch and the plist entries back out', (t) => {
  const root = bareGood(t);
  const result = runCli(['remove', 'background-audio', '--yes'], { cwd: root });
  assert.equal(result.status, 0);

  const info = parsePlist(read(root, 'ios/App/Info.plist'));
  assert.equal(info.UIBackgroundModes, undefined);

  const modules = runCli(['modules', '--json'], { cwd: root });
  assert.equal(byId(modules.json, 'background-audio').effective, false);
});

test('remove cast keeps the usage description but drops the Bonjour items', (t) => {
  const root = bareGood(t);
  runCli(['add', 'cast', '--yes'], { cwd: root });
  const result = runCli(['remove', 'cast', '--yes'], { cwd: root });
  assert.equal(result.status, 0);

  const info = parsePlist(read(root, 'ios/App/Info.plist'));
  assert.equal(info.NSBonjourServices, undefined);
  assert.match(info.NSLocalNetworkUsageDescription, /Cast devices/);
  assert.match(read(root, 'android/gradle.properties'), /^rnapCast=false$/m);
});

test('an unknown module is bad usage and names the valid ones', (t) => {
  const root = bareGood(t);
  const result = runCli(['add', 'nope', '--yes'], { cwd: root });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown module `nope`/);
  assert.match(result.stderr, /hls, cast, siri/);
});

test('with no names and no terminal, add refuses instead of guessing', (t) => {
  const root = bareGood(t);
  const result = runCli(['add'], { cwd: root });
  assert.equal(result.status, 2);
  assert.match(result.stdout, /name at least one module/);
});

test('a manual module prints the steps and changes no file', (t) => {
  const root = bareGood(t);
  const plistBefore = read(root, 'ios/App/Info.plist');
  const result = runCli(['add', 'siri', '--yes'], { cwd: root });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /By hand/);
  assert.match(result.stdout, /siri:/);
  assert.equal(read(root, 'ios/App/Info.plist'), plistBefore);

  const json = runCli(['add', 'siri', '--json'], { cwd: root });
  assert.equal(json.status, 0);
  assert.equal(json.json.applied.length, 0);
  assert.equal(json.json.manual[0].module, 'siri');
  assert.match(json.json.manual[0].step, /Intents extension/);
});

test('an Expo module is one plugin option in app.json', (t) => {
  const root = expoGood(t);
  const added = runCli(['add', 'cast', '--yes'], { cwd: root });
  assert.equal(added.status, 0);

  const config = JSON.parse(read(root, 'app.json'));
  assert.deepEqual(config.expo.plugins, [
    ['react-native-anything-player', { cast: true }],
  ]);
  assert.equal(byId(runCli(['modules', '--json'], { cwd: root }).json, 'cast').source, 'app.json');

  const removed = runCli(['remove', 'cast', '--yes'], { cwd: root });
  assert.equal(removed.status, 0);
  const after = JSON.parse(read(root, 'app.json'));
  assert.deepEqual(after.expo.plugins, [
    ['react-native-anything-player', { cast: false }],
  ]);
});

test('sound is a build switch on both platforms, like cast', (t) => {
  const root = bareGood(t);
  const added = runCli(['add', 'sound', '--yes'], { cwd: root });
  assert.equal(added.status, 0);
  assert.match(read(root, 'android/gradle.properties'), /^rnapSound=true$/m);
  assert.deepEqual(JSON.parse(read(root, 'ios/Podfile.properties.json')), {
    'rnap.sound': 'true',
  });
  const modules = runCli(['modules', '--json'], { cwd: root });
  const sound = byId(modules.json, 'sound');
  assert.equal(sound.effective, true);
  assert.equal(sound.source, 'android/gradle.properties');
  assert.equal(sound.size, null);
  assert.match(sound.sizeNote, /not measured/);
  assert.equal(runCli(['doctor', '--json'], { cwd: root }).json.ok, true);

  const removed = runCli(['remove', 'sound', '--yes'], { cwd: root });
  assert.equal(removed.status, 0);
  assert.match(read(root, 'android/gradle.properties'), /^rnapSound=false$/m);
  assert.deepEqual(JSON.parse(read(root, 'ios/Podfile.properties.json')), {
    'rnap.sound': 'false',
  });
  const again = runCli(['remove', 'sound', '--yes'], { cwd: root });
  assert.match(again.stdout, /sound is already off in this project/);
});

test('car switches Android Auto and CarPlay, and prints the CarPlay steps', (t) => {
  const root = bareGood(t);
  const added = runCli(['add', 'car', '--yes'], { cwd: root });
  assert.equal(added.status, 0);
  assert.match(read(root, 'android/gradle.properties'), /^rnapCar=true$/m);
  assert.deepEqual(JSON.parse(read(root, 'ios/Podfile.properties.json')), {
    'rnap.car': 'true',
  });
  // The entitlement and the scene belong to the app target: printed, not edited.
  assert.match(added.stdout, /com\.apple\.developer\.carplay-audio/);
  assert.match(added.stdout, /docs\/cars-and-watches\.md#carplay/);

  const removed = runCli(['remove', 'car', '--yes'], { cwd: root });
  assert.equal(removed.status, 0);
  assert.match(read(root, 'android/gradle.properties'), /^rnapCar=false$/m);
  assert.match(removed.stdout, /Remove the `RNAP CarPlay` scene/);
});

test('sound and car are Expo plugin options', (t) => {
  const root = expoGood(t);
  const added = runCli(['add', 'sound', 'car', '--yes'], { cwd: root });
  assert.equal(added.status, 0);
  const config = JSON.parse(read(root, 'app.json'));
  assert.deepEqual(config.expo.plugins, [
    ['react-native-anything-player', { sound: true, car: true }],
  ]);
  const modules = runCli(['modules', '--json'], { cwd: root });
  assert.equal(byId(modules.json, 'sound').source, 'app.json');
  assert.equal(byId(modules.json, 'car').effective, true);
  assert.ok(
    !findingsOf(runCli(['doctor', '--json'], { cwd: root }).json).includes(
      'expo-plugin-options'
    )
  );
});

test('app.config.js is never edited: the snippet is printed instead', (t) => {
  const root = expoJsConfig(t);
  const before = read(root, 'app.config.js');
  const result = runCli(['add', 'cast', '--yes'], { cwd: root });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /app\.config\.js\/ts is never rewritten/);
  assert.match(result.stdout, /npx expo prebuild/);
  assert.equal(read(root, 'app.config.js'), before);
});

test('the doctor warns when the plugin and a native switch disagree', (t) => {
  const root = expoGood(t);
  // `expo prebuild` would overwrite this from app.json, where cast is off.
  write(root, 'android/gradle.properties', 'rnapCast=true\n');

  const result = runCli(['doctor', '--json'], { cwd: root });
  const conflict = result.json.findings.find(
    (finding) => finding.id === 'module-conflict'
  );
  assert.ok(conflict, 'module-conflict should be reported');
  assert.equal(conflict.severity, 'warning');
  assert.match(
    conflict.message,
    /`cast` is off in the Expo plugin but on in android\/gradle\.properties/
  );
});

test('the doctor warns when sound or car disagree with the plugin', (t) => {
  const root = expoGood(t);
  write(root, 'android/gradle.properties', 'rnapSound=true\nrnapCar=true\n');
  write(
    root,
    'ios/Podfile.properties.json',
    JSON.stringify({ 'rnap.sound': 'true', 'rnap.car': 'true' })
  );
  const conflicts = runCli(['doctor', '--json'], { cwd: root }).json.findings
    .filter((finding) => finding.id === 'module-conflict')
    .map((finding) => finding.message);
  for (const id of ['sound', 'car']) {
    assert.ok(
      conflicts.some((message) =>
        message.startsWith(`\`${id}\` is off in the Expo plugin but on in android/gradle.properties`)
      ),
      `${id} should conflict in gradle.properties`
    );
    assert.ok(
      conflicts.some((message) =>
        message.startsWith(`\`${id}\` is off in the Expo plugin but on in ios/Podfile.properties.json`)
      ),
      `${id} should conflict in Podfile.properties.json`
    );
  }
});

test('remove background-audio leaves a marker the doctor reads as a choice', (t) => {
  const root = bareGood(t);
  const before = runCli(['doctor', '--json'], { cwd: root }).json;
  assert.ok(!findingsOf(before).includes('ios-background-audio'));

  const removed = runCli(['remove', 'background-audio', '--yes'], { cwd: root });
  assert.equal(removed.status, 0);
  assert.deepEqual(JSON.parse(read(root, 'ios/Podfile.properties.json')), {
    'rnap.backgroundAudio': 'false',
  });

  const doctor = runCli(['doctor', '--json'], { cwd: root });
  const finding = doctor.json.findings.find(
    (item) => item.id === 'ios-background-audio'
  );
  assert.equal(finding.severity, 'info');
  assert.match(finding.message, /off on purpose/);
  assert.equal(doctor.json.ok, true);
  assert.equal(
    doctor.json.findings.filter((item) => item.severity !== 'info').length,
    0
  );

  // Removing again changes nothing; adding resets the marker and the mode.
  assert.match(
    runCli(['remove', 'background-audio', '--yes'], { cwd: root }).stdout,
    /background-audio is already off/
  );
  assert.equal(runCli(['add', 'background-audio', '--yes'], { cwd: root }).status, 0);
  assert.deepEqual(JSON.parse(read(root, 'ios/Podfile.properties.json')), {
    'rnap.backgroundAudio': 'true',
  });
  const info = parsePlist(read(root, 'ios/App/Info.plist'));
  assert.deepEqual(info.UIBackgroundModes, ['audio']);
});

test('a hand-removed background mode is still marked by remove', (t) => {
  const root = bareGood(t);
  runCli(['remove', 'background-audio', '--yes'], { cwd: root });
  fs.rmSync(path.join(root, 'ios/Podfile.properties.json'));
  const result = runCli(['remove', 'background-audio', '--yes'], { cwd: root });
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(read(root, 'ios/Podfile.properties.json')), {
    'rnap.backgroundAudio': 'false',
  });
});

test('modules and add need a package.json', (t) => {
  const root = makeDir(t);
  const modules = runCli(['modules'], { cwd: root });
  assert.equal(modules.status, 1);
  assert.match(modules.stdout, /No package\.json here/);

  const add = runCli(['add', 'cast', '--yes'], { cwd: root });
  assert.equal(add.status, 1);

  const json = runCli(['modules', '--json'], { cwd: root });
  assert.equal(json.status, 1);
  assert.equal(json.json.ok, false);
});
