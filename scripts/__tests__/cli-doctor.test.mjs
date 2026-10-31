import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  bareBroken,
  bareGood,
  expoBroken,
  expoGood,
  expoJsConfig,
  expoNoPlugin,
  expoPluginOptions,
  findingsOf,
  LIBRARY,
  runCli,
} from './cli-fixtures.mjs';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..'
);

function byId(report, id) {
  return report.findings.filter((finding) => finding.id === id);
}

test('a well-configured bare project has nothing to report', (t) => {
  const root = bareGood(t);
  const result = runCli(['doctor', '--json', '--cwd', root], { cwd: root });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.json.findings, []);
  assert.equal(result.json.ok, true);
  assert.equal(result.json.project.kind, 'bare');
  assert.deepEqual(result.json.project.platforms, { ios: true, android: true });
  assert.equal(result.json.project.library.version, '0.1.0');
});

test('a broken bare project reports every mistake and exits 1', (t) => {
  const root = bareBroken(t);
  const result = runCli(['doctor', '--json', '--cwd', root], { cwd: root });
  assert.equal(result.status, 1);

  const ids = findingsOf(result.json);
  for (const id of [
    'react-native-version',
    'new-arch-ios',
    'new-arch-android',
    'ios-background-audio',
    'ios-scene-lifecycle',
    'ios-pods',
    'ios-pod-version',
    'ios-deployment-target',
    'android-minsdk',
    'android-compilesdk',
    'android-assistant',
  ])
    assert.ok(ids.includes(id), `${id} missing from ${ids.join(', ')}`);

  assert.equal(byId(result.json, 'react-native-version')[0].severity, 'error');
  assert.equal(byId(result.json, 'ios-scene-lifecycle')[0].severity, 'warning');
  assert.equal(byId(result.json, 'android-assistant')[0].severity, 'warning');
  assert.equal(byId(result.json, 'ios-pods')[0].severity, 'warning');
  assert.equal(byId(result.json, 'ios-pod-version')[0].severity, 'error');
  assert.equal(byId(result.json, 'android-minsdk')[0].severity, 'error');
  assert.equal(byId(result.json, 'android-compilesdk')[0].severity, 'warning');

  // Every finding carries an id, a severity, a message and, when actionable, a
  // concrete fix.
  for (const finding of result.json.findings) {
    assert.ok(finding.id);
    assert.ok(['error', 'warning', 'info'].includes(finding.severity));
    assert.ok(finding.message.length > 10);
    if (finding.severity !== 'info') {
      assert.ok(finding.fix.file, `${finding.id} has no fix file`);
      assert.ok(finding.fix.change, `${finding.id} has no fix change`);
    }
  }
});

test('warnings do not fail the run', (t) => {
  const root = bareGood(t);
  const plistFile = path.join(root, 'ios/App/Info.plist');
  const text = fs.readFileSync(plistFile, 'utf8');
  fs.writeFileSync(
    plistFile,
    text.replace(
      /\t<key>UIApplicationSceneManifest<\/key>\n\t<dict>\n\t\t<key>UIApplicationSupportsMultipleScenes<\/key>\n\t\t<false\/>\n\t<\/dict>\n/,
      ''
    )
  );
  const result = runCli(['doctor', '--json', '--cwd', root], { cwd: root });
  assert.equal(result.json.summary.warnings, 1);
  assert.equal(result.status, 0);
  assert.equal(byId(result.json, 'ios-scene-lifecycle')[0].severity, 'warning');
});

test('a good Expo project has nothing to report', (t) => {
  const root = expoGood(t);
  const result = runCli(['doctor', '--json', '--cwd', root], { cwd: root });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.json.findings, []);
  assert.equal(result.json.project.kind, 'expo');
  assert.equal(result.json.project.expo.sdk, 57);
  assert.deepEqual(result.json.project.platforms, {
    ios: false,
    android: false,
  });
});

test('Expo without the plugin is an error with an autofix', (t) => {
  const root = expoNoPlugin(t);
  const result = runCli(['doctor', '--json', '--cwd', root], { cwd: root });
  assert.equal(result.status, 1);
  const plugin = byId(result.json, 'expo-plugin')[0];
  assert.equal(plugin.severity, 'error');
  assert.equal(plugin.fix.file, 'app.json');
  assert.equal(plugin.autofix, 'expo-plugin');
  // The plugin also provides background audio: no second error for it.
  assert.equal(byId(result.json, 'ios-background-audio').length, 0);
});

test('invalid Expo plugin options are errors, unknown ones warnings', (t) => {
  const root = expoBroken(t);
  const result = runCli(['doctor', '--json', '--cwd', root], { cwd: root });
  assert.equal(result.status, 1);
  const issues = byId(result.json, 'expo-plugin-options');
  assert.ok(issues.some((item) => item.severity === 'error'));
  assert.ok(issues.some((item) => item.severity === 'warning'));
  assert.ok(findingsOf(result.json).includes('new-arch-ios'));
});

test("the video option's object takes pictureInPicture, a boolean", (t) => {
  const root = expoGood(t);
  const appJson = JSON.parse(
    fs.readFileSync(path.join(root, 'app.json'), 'utf8')
  );
  const check = (video) => {
    appJson.expo.plugins = [[LIBRARY, { video }]];
    fs.writeFileSync(path.join(root, 'app.json'), JSON.stringify(appJson));
    const result = runCli(['doctor', '--json', '--cwd', root], { cwd: root });
    return byId(result.json, 'expo-plugin-options').map(
      (item) => item.severity
    );
  };
  assert.deepEqual(check({ pictureInPicture: false }), []);
  assert.deepEqual(check({ pip: true }), ['warning']);
  assert.deepEqual(check({ pictureInPicture: 'yes' }), ['error']);
});

test("the car option's object takes ios and android, booleans", (t) => {
  const root = expoGood(t);
  const appJson = JSON.parse(
    fs.readFileSync(path.join(root, 'app.json'), 'utf8')
  );
  const check = (car) => {
    appJson.expo.plugins = [[LIBRARY, { car }]];
    fs.writeFileSync(path.join(root, 'app.json'), JSON.stringify(appJson));
    const result = runCli(['doctor', '--json', '--cwd', root], { cwd: root });
    return byId(result.json, 'expo-plugin-options').map(
      (item) => item.severity
    );
  };
  assert.deepEqual(check(true), []);
  assert.deepEqual(check({ ios: false }), []);
  assert.deepEqual(check({ carplay: false }), ['warning']);
  assert.deepEqual(check({ ios: 'no' }), ['error']);
});

test('deliberate plugin choices are info, not errors', (t) => {
  const root = expoPluginOptions(t);
  const result = runCli(['doctor', '--json', '--cwd', root], { cwd: root });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(byId(result.json, 'ios-background-audio')[0].severity, 'info');
  assert.equal(byId(result.json, 'android-assistant')[0].severity, 'info');
  assert.equal(result.json.summary.errors, 0);
});

test('--json includes the versions the checks used', (t) => {
  const root = expoGood(t);
  const result = runCli(['doctor', '--json', '--cwd', root], { cwd: root });
  assert.equal(result.json.schemaVersion, 1);
  assert.equal(result.json.command, 'doctor');
  assert.equal(result.json.project.reactNative, '0.86.3');
  assert.equal(result.json.project.library.installed, true);
  assert.deepEqual(result.json.urls, []);
  assert.deepEqual(result.json.summary, { errors: 0, warnings: 0, infos: 0 });
});

test('text output is plain when stdout is not a TTY', (t) => {
  const root = expoGood(t);
  const result = runCli(['doctor', '--cwd', root], { cwd: root });
  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stdout, /\u001b\[/);
  assert.match(result.stdout, /No problems found\./);
});

test('the repository examples are clean', () => {
  for (const example of ['example', 'example-expo']) {
    const result = runCli(
      ['doctor', '--json', '--cwd', path.join(repoRoot, example)],
      { cwd: repoRoot }
    );
    assert.equal(result.status, 0, `${example}: ${result.stderr}`);
    assert.equal(
      result.json.summary.errors,
      0,
      JSON.stringify(result.json.findings)
    );
  }
});

test('a directory without package.json fails with a real finding', (t) => {
  const dir = bareGood(t);
  fs.unlinkSync(path.join(dir, 'package.json'));
  const result = runCli(['doctor', '--json', '--cwd', dir], { cwd: dir });
  assert.equal(result.status, 1);
  assert.ok(findingsOf(result.json).includes('project-package-json'));
});

test('a project without the library is an error', (t) => {
  const root = bareGood(t);
  fs.rmSync(path.join(root, 'node_modules'), { recursive: true, force: true });
  const result = runCli(['doctor', '--json', '--cwd', root], { cwd: root });
  assert.equal(result.status, 1);
  const finding = byId(result.json, 'library-installed')[0];
  assert.equal(finding.severity, 'error');
  assert.match(finding.fix.change, /npm install/);
});

test('Cast needs the iOS discovery keys and the pod switch', (t) => {
  const root = bareGood(t);
  fs.appendFileSync(
    path.join(root, 'android/gradle.properties'),
    'rnapCast=true\n'
  );
  const result = runCli(['doctor', '--json', '--cwd', root], { cwd: root });
  assert.equal(result.status, 1);
  const discovery = byId(result.json, 'ios-cast-discovery')[0];
  assert.equal(discovery.severity, 'error');
  assert.match(discovery.message, /_googlecast\._tcp/);
  assert.match(discovery.message, /_CC1AD845\._googlecast\._tcp/);
  assert.equal(byId(result.json, 'ios-cast-pod')[0].severity, 'warning');
});

test('the Expo cast option implies the discovery keys', (t) => {
  const root = expoGood(t);
  const config = JSON.parse(
    fs.readFileSync(path.join(root, 'app.json'), 'utf8')
  );
  config.expo.plugins = [['react-native-anything-player', { cast: true }]];
  fs.writeFileSync(
    path.join(root, 'app.json'),
    `${JSON.stringify(config, null, 2)}\n`
  );
  const result = runCli(['doctor', '--json', '--cwd', root], { cwd: root });
  assert.equal(result.status, 0, JSON.stringify(result.json.findings));
  assert.equal(byId(result.json, 'ios-cast-discovery').length, 0);
});

test('a half-configured Siri setup is an error', (t) => {
  const root = bareGood(t);
  fs.appendFileSync(
    path.join(root, 'ios/App.xcodeproj/project.pbxproj'),
    'RNAPIntents\n'
  );
  const plistFile = path.join(root, 'ios/App/Info.plist');
  fs.writeFileSync(
    plistFile,
    fs
      .readFileSync(plistFile, 'utf8')
      .replace(
        '</dict>\n</plist>',
        '\t<key>NSSiriUsageDescription</key>\n\t<string>Play radio</string>\n</dict>\n</plist>'
      )
  );
  const result = runCli(['doctor', '--json', '--cwd', root], { cwd: root });
  assert.equal(result.status, 1);
  const siri = byId(result.json, 'ios-siri')[0];
  assert.equal(siri.severity, 'error');
  assert.match(siri.message, /INPlayMediaIntent/);
  assert.match(siri.message, /com\.apple\.developer\.siri/);
});

test('half an Assistant setup is an error, none at all a warning', (t) => {
  const root = bareGood(t);
  const manifest = path.join(root, 'android/app/src/main/AndroidManifest.xml');
  fs.writeFileSync(
    manifest,
    fs
      .readFileSync(manifest, 'utf8')
      .replace(
        / {12}<intent-filter>\n {16}<action android:name="android\.media\.action\.MEDIA_PLAY_FROM_SEARCH" \/>\n {16}<category android:name="android\.intent\.category\.DEFAULT" \/>\n {12}<\/intent-filter>\n/,
        ''
      )
  );
  const result = runCli(['doctor', '--json', '--cwd', root], { cwd: root });
  assert.equal(result.status, 1);
  const assistant = byId(result.json, 'android-assistant')[0];
  assert.equal(assistant.severity, 'error');
  assert.match(assistant.fix.change, /MEDIA_PLAY_FROM_SEARCH/);
});

test('an Expo JavaScript config is reported, not guessed at', (t) => {
  const root = expoJsConfig(t);
  const result = runCli(['doctor', '--json', '--cwd', root], { cwd: root });
  assert.equal(result.status, 0, JSON.stringify(result.json.findings));
  const config = byId(result.json, 'expo-config-js');
  assert.equal(config.length, 1);
  assert.equal(config[0].severity, 'info');
  assert.match(config[0].message, /app\.config\.js/);
  assert.equal(byId(result.json, 'expo-plugin').length, 0);
});

test('a Podfile that forces the old architecture is an error', (t) => {
  const root = bareGood(t);
  fs.appendFileSync(
    path.join(root, 'ios/Podfile'),
    "ENV['RCT_NEW_ARCH_ENABLED'] = '0'\n"
  );
  const result = runCli(['doctor', '--json', '--cwd', root], { cwd: root });
  assert.equal(result.status, 1);
  assert.equal(byId(result.json, 'new-arch-ios')[0].severity, 'error');
});
