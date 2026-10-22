// Fixture projects for the CLI tests. Each builder writes a throwaway app in a
// temp directory: no fixture lives in the repository, so the tests cannot rot
// with the examples.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile as execFileCallback, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

export const execFile = promisify(execFileCallback);

export const CLI = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../bin/rnap.mjs'
);

export const LIBRARY = 'react-native-anything-player';

const INFO_PLIST_HEAD = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
`;

export function plist(entries) {
  return `${INFO_PLIST_HEAD}${entries}</dict>\n</plist>\n`;
}

export function backgroundAudio(value = 'audio') {
  return `\t<key>UIBackgroundModes</key>
\t<array>
\t\t<string>${value}</string>
\t</array>
`;
}

export const SCENE_MANIFEST = `\t<key>UIApplicationSceneManifest</key>
\t<dict>
\t\t<key>UIApplicationSupportsMultipleScenes</key>
\t\t<false/>
\t</dict>
`;

export function write(root, relative, contents) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  return file;
}

export function read(root, relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

export function makeDir(t, prefix = 'rnap-cli-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function nodeModulesLibrary(root, version = '0.1.0') {
  write(
    root,
    'node_modules/react-native-anything-player/package.json',
    JSON.stringify({ name: LIBRARY, version })
  );
}

const ANDROID_MANIFEST = (
  assistant = true
) => `<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application android:name=".MainApplication">
        <activity android:name=".MainActivity" android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>${
              assistant
                ? `
            <intent-filter>
                <action android:name="android.media.action.MEDIA_PLAY_FROM_SEARCH" />
                <category android:name="android.intent.category.DEFAULT" />
            </intent-filter>`
                : ''
            }
        </activity>
    </application>
</manifest>
`;

const MAIN_ACTIVITY = (assistant = true) => `package com.example

import android.os.Bundle
import com.facebook.react.ReactActivity${
  assistant ? '\nimport com.anythingplayer.AnythingPlayer' : ''
}

class MainActivity : ReactActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)${
      assistant ? '\n    AnythingPlayer.handleIntent(this, intent)' : ''
    }
  }
${
  assistant
    ? `
  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    AnythingPlayer.handleIntent(this, intent)
  }`
    : ''
}
}
`;

const PODFILE = `platform :ios, '15.1'
target 'App' do
  config = use_native_modules!
  use_react_native!(:path => config[:reactNativePath])
end
`;

function podfileLock(version) {
  return `PODS:
  - AnythingPlayer (${version}):
    - React-Core

DEPENDENCIES:
  - AnythingPlayer (from \`../node_modules/react-native-anything-player\`)
`;
}

/** Bare React Native, everything configured. */
export function bareGood(t) {
  const root = makeDir(t);
  write(
    root,
    'package.json',
    JSON.stringify(
      {
        name: 'bare-app',
        dependencies: { 'react-native': '0.86.3', [LIBRARY]: '0.1.0' },
      },
      null,
      2
    )
  );
  nodeModulesLibrary(root);
  write(root, 'ios/Podfile', PODFILE);
  write(root, 'ios/Podfile.lock', podfileLock('0.1.0'));
  fs.mkdirSync(path.join(root, 'ios/Pods'), { recursive: true });
  write(
    root,
    'ios/App/Info.plist',
    plist(
      `\t<key>CFBundleDisplayName</key>
\t<string>Bare App</string>
\t<key>RCTNewArchEnabled</key>
\t<true/>
${backgroundAudio()}${SCENE_MANIFEST}`
    )
  );
  write(
    root,
    'ios/App.xcodeproj/project.pbxproj',
    'IPHONEOS_DEPLOYMENT_TARGET = 15.1;\n'
  );
  write(root, 'android/gradle.properties', 'newArchEnabled=true\n');
  write(
    root,
    'android/build.gradle',
    'ext {\n  minSdkVersion = 24\n  compileSdkVersion = 36\n}\n'
  );
  write(root, 'android/app/src/main/AndroidManifest.xml', ANDROID_MANIFEST());
  write(
    root,
    'android/app/src/main/java/com/example/MainActivity.kt',
    MAIN_ACTIVITY()
  );
  return root;
}

/** Bare React Native with every common mistake at once. */
export function bareBroken(t) {
  const root = makeDir(t);
  write(
    root,
    'package.json',
    JSON.stringify(
      {
        name: 'bare-broken',
        dependencies: { 'react-native': '0.79.2', [LIBRARY]: '0.1.0' },
      },
      null,
      2
    )
  );
  nodeModulesLibrary(root);
  write(root, 'ios/Podfile', PODFILE);
  write(root, 'ios/Podfile.lock', podfileLock('0.0.9'));
  write(
    root,
    'ios/App/Info.plist',
    plist(`\t<key>CFBundleDisplayName</key>
\t<string>Broken</string>
`)
  );
  write(
    root,
    'ios/Podfile.properties.json',
    '{\n  "newArchEnabled": "false"\n}\n'
  );
  write(
    root,
    'ios/App.xcodeproj/project.pbxproj',
    'IPHONEOS_DEPLOYMENT_TARGET = 14.0;\n'
  );
  write(root, 'android/gradle.properties', 'newArchEnabled=false\n');
  write(
    root,
    'android/build.gradle',
    'ext {\n  minSdkVersion = 21\n  compileSdkVersion = 33\n}\n'
  );
  write(
    root,
    'android/app/src/main/AndroidManifest.xml',
    ANDROID_MANIFEST(false)
  );
  write(
    root,
    'android/app/src/main/java/com/example/MainActivity.kt',
    MAIN_ACTIVITY(false)
  );
  return root;
}

function expoPackageJson(extra = {}) {
  return JSON.stringify(
    {
      name: 'expo-app',
      dependencies: {
        'expo': '~57.0.31',
        'react-native': '0.86.3',
        [LIBRARY]: '0.1.0',
        ...extra,
      },
    },
    null,
    2
  );
}

function expoAppJson(plugins, extra = {}) {
  return JSON.stringify(
    {
      expo: {
        name: 'Expo App',
        slug: 'expo-app',
        ios: { bundleIdentifier: 'com.example.app' },
        plugins,
        ...extra,
      },
    },
    null,
    2
  );
}

/** Expo, plugin listed, nothing to report. */
export function expoGood(t) {
  const root = makeDir(t);
  write(root, 'package.json', expoPackageJson());
  nodeModulesLibrary(root);
  write(
    root,
    'app.json',
    `${expoAppJson([LIBRARY], {
      ios: {
        bundleIdentifier: 'com.example.app',
        infoPlist: {
          UIApplicationSceneManifest: {
            UIApplicationSupportsMultipleScenes: false,
          },
        },
      },
    })}\n`
  );
  return root;
}

/** Expo without the plugin: `init` can add it. */
export function expoNoPlugin(t) {
  const root = makeDir(t);
  write(root, 'package.json', expoPackageJson());
  nodeModulesLibrary(root);
  write(
    root,
    'app.json',
    `${JSON.stringify(
      {
        expo: {
          name: 'Expo App',
          slug: 'expo-app',
          // Unrelated keys must survive `init` untouched.
          userInterfaceStyle: 'dark',
          ios: { bundleIdentifier: 'com.example.app' },
          extra: { apiUrl: 'https://example.test' },
        },
      },
      null,
      2
    )}\n`
  );
  return root;
}

/** Expo with New Architecture off and invalid plugin options. */
export function expoBroken(t) {
  const root = makeDir(t);
  write(root, 'package.json', expoPackageJson());
  nodeModulesLibrary(root);
  write(
    root,
    'app.json',
    `${expoAppJson([[LIBRARY, { cast: 'yes', unknownOption: true }]], {
      newArchEnabled: false,
    })}\n`
  );
  return root;
}

/** Expo whose plugin is off for background audio too. */
export function expoPluginOptions(t) {
  const root = makeDir(t);
  write(root, 'package.json', expoPackageJson());
  nodeModulesLibrary(root);
  write(
    root,
    'app.json',
    `${expoAppJson([[LIBRARY, { backgroundAudio: false, assistant: false }]])}\n`
  );
  return root;
}

/** Expo with a JavaScript config: checks must report, not guess. */
export function expoJsConfig(t) {
  const root = makeDir(t);
  write(root, 'package.json', expoPackageJson());
  nodeModulesLibrary(root);
  write(
    root,
    'app.config.js',
    "module.exports = { expo: { name: 'JS', plugins: ['react-native-anything-player'] } };\n"
  );
  return root;
}

/** Expo with an http URL and iOS local networking allowed, for URL checks. */
export function expoHttpLocal(t) {
  const root = expoGood(t);
  const config = JSON.parse(read(root, 'app.json'));
  config.expo.ios.infoPlist = {
    ...config.expo.ios.infoPlist,
    NSAppTransportSecurity: { NSAllowsLocalNetworking: true },
  };
  write(root, 'app.json', `${JSON.stringify(config, null, 2)}\n`);
  return root;
}

/** Bare project that does not allow cleartext HTTP. */
export function bareNoCleartext(t) {
  const root = bareGood(t);
  write(
    root,
    'android/app/src/main/AndroidManifest.xml',
    ANDROID_MANIFEST().replace(
      '<application android:name=".MainApplication">',
      '<application android:name=".MainApplication" android:usesCleartextTraffic="false">'
    )
  );
  return root;
}

/** Runs the CLI. `--no-color` keeps assertions free of escapes. */
export function runCli(args, { cwd, input } = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args, '--no-color'], {
    cwd: cwd ?? process.cwd(),
    input,
    encoding: 'utf8',
    timeout: 30000,
  });
  return withJson(args, result);
}

/**
 * Async variant for tests that serve HTTP from the same process: spawnSync
 * would block the event loop and the server could never answer.
 */
export async function runCliAsync(args, { cwd } = {}) {
  try {
    const { stdout, stderr } = await execFile(
      process.execPath,
      [CLI, ...args, '--no-color'],
      {
        cwd: cwd ?? process.cwd(),
        encoding: 'utf8',
        timeout: 30000,
      }
    );
    return withJson(args, { status: 0, stdout, stderr });
  } catch (error) {
    return withJson(args, {
      status: typeof error.code === 'number' ? error.code : 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
    });
  }
}

function withJson(args, result) {
  let json = null;
  if (args.includes('--json') && result.stdout)
    json = JSON.parse(result.stdout);
  return { ...result, json };
}

export function findingsOf(report) {
  return report.findings.map((finding) => finding.id);
}
