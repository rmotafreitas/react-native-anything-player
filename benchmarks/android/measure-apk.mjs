#!/usr/bin/env node
// What each React Native audio library adds to a release APK, with R8 on and
// off, measured by building a real app.
//
//   node benchmarks/android/measure-apk.mjs [--only rnap,rntp5] [--keep]
//   # writes benchmarks/results/apk.json
//   node benchmarks/android/measure-apk.mjs --only rnap --rnap old.tgz --out /tmp/old.json
//   # another RNAP tarball (a release, to compare), written elsewhere
//
// One bare React Native app (the example's Android project, emptied), built
// for arm64-v8a: once alone, then once per library. A library's cost is the
// difference with the empty app. "R8 on" is a release build as Android Studio
// sets it up for a store app (`minifyEnabled` + `shrinkResources`, the
// optimizing default rules, R8 full mode); "R8 off" ships every class every
// dependency declares. The app's JS does not import the library, so this is the
// native side only: the JS bundle cost is in size.json.
//
// Needs the Android SDK (ANDROID_HOME), JDK 17+, npm and network access.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..'
);
const OUT = path.join(ROOT, 'benchmarks/results/apk.json');
const RN = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'example/package.json'), 'utf8')
).dependencies;

/**
 * The libraries. `install`: what goes in the app's package.json (the library
 * and the native peers it needs to build). `gradle`: properties for this build.
 */
const LIBRARIES = [
  { id: 'rnap', label: 'RNAP', install: ['@rnap'] },
  {
    id: 'rnapNoHls',
    label: 'RNAP without HLS',
    install: ['@rnap'],
    gradle: { rnapHls: 'false' },
  },
  {
    id: 'rnapCast',
    label: 'RNAP with Cast',
    install: ['@rnap'],
    gradle: { rnapCast: 'true' },
  },
  { id: 'rntp5', label: 'RNTP 5', install: ['@rntp/player'] },
  { id: 'rntp4', label: 'RNTP 4', install: ['react-native-track-player@4'] },
  { id: 'video', label: 'react-native-video', install: ['react-native-video'] },
  {
    id: 'audioPro',
    label: 'react-native-audio-pro',
    install: ['react-native-audio-pro', 'zustand'],
  },
  {
    id: 'nitroSound',
    label: 'react-native-nitro-sound',
    install: ['react-native-nitro-sound', 'react-native-nitro-modules'],
  },
  {
    id: 'audioApi',
    label: 'react-native-audio-api',
    install: ['react-native-audio-api'],
  },
  { id: 'sound', label: 'react-native-sound', install: ['react-native-sound'] },
];

const args = process.argv.slice(2);
const only = args.includes('--only')
  ? args[args.indexOf('--only') + 1].split(',')
  : null;
const keep = args.includes('--keep');
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const rnapTarball = option('--rnap');
const out = option('--out') ? path.resolve(option('--out')) : OUT;

const run = (cmd, argv, opts = {}) =>
  execFileSync(cmd, argv, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
  });

/** The example's Android project, without RNAP or anything else in it. */
function scaffold(app) {
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(
    path.join(app, 'package.json'),
    JSON.stringify(
      {
        name: 'bench',
        version: '0.0.1',
        private: true,
        dependencies: { 'react': RN.react, 'react-native': RN['react-native'] },
        devDependencies: {
          '@babel/core': '^7.25.2',
          '@babel/preset-env': '^7.25.3',
          '@babel/runtime': '^7.29.10',
          '@react-native-community/cli': '20.2.0',
          '@react-native-community/cli-platform-android': '20.2.0',
          '@react-native/babel-preset': RN['react-native'],
          '@react-native/metro-config': RN['react-native'],
        },
      },
      null,
      2
    )
  );
  fs.writeFileSync(
    path.join(app, 'index.js'),
    "import { AppRegistry } from 'react-native';\nAppRegistry.registerComponent('bench', () => () => null);\n"
  );
  fs.writeFileSync(
    path.join(app, 'babel.config.js'),
    "module.exports = { presets: ['module:@react-native/babel-preset'] };\n"
  );
  fs.writeFileSync(
    path.join(app, 'metro.config.js'),
    "const { getDefaultConfig } = require('@react-native/metro-config');\nmodule.exports = getDefaultConfig(__dirname);\n"
  );
  fs.writeFileSync(
    path.join(app, 'app.json'),
    '{ "name": "bench", "displayName": "bench" }\n'
  );

  const android = path.join(app, 'android');
  fs.cpSync(path.join(ROOT, 'example/android'), android, {
    recursive: true,
    filter: (src) =>
      !/[\\/](build|\.gradle|\.cxx|androidTest|debug)$/.test(src) &&
      !/res[\\/]xml$/.test(src),
  });
  const edit = (file, fn) =>
    fs.writeFileSync(
      path.join(android, file),
      fn(fs.readFileSync(path.join(android, file), 'utf8'))
    );
  const java = path.join(android, 'app/src/main/java');
  fs.rmSync(java, { recursive: true, force: true });
  fs.mkdirSync(path.join(java, 'bench'), { recursive: true });
  fs.writeFileSync(
    path.join(java, 'bench/MainActivity.kt'),
    `package bench

import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

class MainActivity : ReactActivity() {
  override fun getMainComponentName(): String = "bench"
  override fun createReactActivityDelegate(): ReactActivityDelegate =
      DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)
}
`
  );
  fs.writeFileSync(
    path.join(java, 'bench/MainApplication.kt'),
    `package bench

import android.app.Application
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost

class MainApplication : Application(), ReactApplication {
  override val reactHost: ReactHost by lazy {
    getDefaultReactHost(context = applicationContext, packageList = PackageList(this).packages)
  }

  override fun onCreate() {
    super.onCreate()
    loadReactNative(this)
  }
}
`
  );
  edit('app/src/main/AndroidManifest.xml', (s) =>
    s
      .replace(
        /\s*<intent-filter>\s*<action android:name="android.intent.action.VIEW" \/>[\s\S]*?<\/intent-filter>/,
        ''
      )
      .replace(/\s*<!-- Google Assistant[\s\S]*?<\/intent-filter>/, '')
      .replace(/\s*android:networkSecurityConfig="[^"]*"/, '')
      .replace(
        'android:usesCleartextTraffic="${usesCleartextTraffic}"',
        'android:usesCleartextTraffic="true"'
      )
  );
  edit('app/build.gradle', (s) =>
    s
      .replace(
        'def enableProguardInReleaseBuilds = false',
        'def enableProguardInReleaseBuilds = (findProperty("r8") ?: "true").toBoolean()'
      )
      .replace(/namespace "[^"]+"/, 'namespace "bench"')
      .replace(/applicationId "[^"]+"/, 'applicationId "rnap.bench"')
      .replace(
        'minifyEnabled enableProguardInReleaseBuilds\n',
        'minifyEnabled enableProguardInReleaseBuilds\n            shrinkResources enableProguardInReleaseBuilds\n'
      )
      .replace(
        'getDefaultProguardFile("proguard-android.txt")',
        'getDefaultProguardFile("proguard-android-optimize.txt")'
      )
      .replace(
        /\n\s*\/\/ Device tests[^\n]*\n(\s*androidTestImplementation\([^\n]*\n)+/,
        '\n'
      )
  );
  edit('settings.gradle', (s) =>
    s.replace(/rootProject\.name = '[^']+'/, "rootProject.name = 'bench'")
  );
  edit('gradle.properties', (s) =>
    s
      .replace(
        /reactNativeArchitectures=.*/,
        'reactNativeArchitectures=arm64-v8a'
      )
      .replace(/-Xmx\d+m/, '-Xmx4096m')
  );
}

/** RNAP packed from this checkout, as it would be published. */
function packRnap(work) {
  const out = run(
    'npm',
    ['pack', '--json', '--ignore-scripts', '--pack-destination', work],
    { cwd: ROOT }
  );
  return path.join(work, JSON.parse(out.slice(out.search(/^\[/m)))[0].filename);
}

/** Sizes inside the APK, by what they are (compressed, as stored). */
function apkSizes(apk) {
  const listing = run('unzip', ['-lv', apk]);
  const sizes = {
    apkBytes: fs.statSync(apk).size,
    dexBytes: 0,
    nativeBytes: 0,
    resourceBytes: 0,
    otherBytes: 0,
  };
  for (const line of listing.split('\n')) {
    const m = /^\s*\d+\s+\S+\s+(\d+)\s+\S+\s+\S+\s+\S+\s+\S+\s+(.+)$/.exec(
      line
    );
    if (!m || m[2] === 'Name') continue;
    const [bytes, name] = [Number(m[1]), m[2].trim()];
    if (/^classes\d*\.dex$/.test(name)) sizes.dexBytes += bytes;
    else if (name.startsWith('lib/')) sizes.nativeBytes += bytes;
    else if (name.startsWith('res/') || name === 'resources.arsc')
      sizes.resourceBytes += bytes;
    else sizes.otherBytes += bytes;
  }
  return sizes;
}

function build(app, r8, gradle = {}) {
  const props = [
    `-Pr8=${r8}`,
    // What one phone downloads (a store serves one ABI per device).
    '-PreactNativeArchitectures=arm64-v8a',
    ...Object.entries(gradle).map(([k, v]) => `-P${k}=${v}`),
  ];
  run('./gradlew', ['assembleRelease', '--console=plain', '-q', ...props], {
    cwd: path.join(app, 'android'),
  });
  return apkSizes(
    path.join(app, 'android/app/build/outputs/apk/release/app-release.apk')
  );
}

function main() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rnap-apk-'));
  const app = path.join(work, 'app');
  console.log(`scaffolding the app in ${app} …`);
  scaffold(app);
  if (!fs.existsSync(path.join(ROOT, 'lib/module/index.js')))
    run('yarn', ['prepare'], { cwd: ROOT });
  const rnap = rnapTarball ? path.resolve(rnapTarball) : packRnap(work);
  const npm = (...argv) =>
    run('npm', [...argv, '--no-audit', '--no-fund', '--legacy-peer-deps'], {
      cwd: app,
    });
  npm('install');

  const measure = (label, gradle) => {
    const sizes = {
      r8: build(app, true, gradle),
      noR8: build(app, false, gradle),
    };
    console.log(
      `  ${label.padEnd(26)} R8 on ${(sizes.r8.apkBytes / 1024).toFixed(0).padStart(7)} KB   R8 off ${(sizes.noR8.apkBytes / 1024).toFixed(0).padStart(7)} KB`
    );
    return sizes;
  };
  console.log('building (arm64-v8a, release):');
  const baseline = measure('empty app');
  const rows = [];
  for (const lib of LIBRARIES.filter((l) => !only || only.includes(l.id))) {
    const specs = lib.install.map((s) => (s === '@rnap' ? rnap : s));
    try {
      npm('install', ...specs);
      const sizes = measure(lib.label, lib.gradle);
      const pkg =
        lib.install[0] === '@rnap'
          ? 'react-native-anything-player'
          : lib.install[0].replace(/@\d+$/, '');
      const version = JSON.parse(
        fs.readFileSync(
          path.join(app, 'node_modules', pkg, 'package.json'),
          'utf8'
        )
      ).version;
      const delta = (a, b) =>
        Object.fromEntries(Object.keys(a).map((k) => [k, a[k] - b[k]]));
      rows.push({
        id: lib.id,
        label: lib.label,
        name: pkg,
        version,
        gradle: lib.gradle ?? {},
        r8: delta(sizes.r8, baseline.r8),
        noR8: delta(sizes.noR8, baseline.noR8),
      });
    } catch (error) {
      console.warn(
        `  ${lib.label}: build failed\n${String(error.stderr ?? error)
          .split('\n')
          .filter((l) => /error|What went wrong|FAILURE/i.test(l))
          .slice(0, 8)
          .join('\n')}`
      );
      rows.push({ id: lib.id, label: lib.label, failed: true });
    } finally {
      const names = lib.install.map((s) =>
        s === '@rnap' ? 'react-native-anything-player' : s.replace(/@\d+$/, '')
      );
      npm('uninstall', ...names);
    }
  }

  const previous = fs.existsSync(out)
    ? JSON.parse(fs.readFileSync(out, 'utf8')).libraries
    : [];
  const merged = [
    ...previous.filter((p) => !rows.some((r) => r.id === p.id)),
    ...rows,
  ].sort(
    (a, b) =>
      LIBRARIES.findIndex((l) => l.id === a.id) -
      LIBRARIES.findIndex((l) => l.id === b.id)
  );
  fs.writeFileSync(
    out,
    JSON.stringify(
      {
        measuredAt: new Date().toISOString().slice(0, 10),
        method: 'benchmarks/android/measure-apk.mjs',
        reactNative: RN['react-native'],
        abi: 'arm64-v8a',
        baseline,
        libraries: merged,
      },
      null,
      2
    ) + '\n'
  );
  console.log(`wrote ${path.relative(ROOT, out)}`);
  if (!keep) fs.rmSync(work, { recursive: true, force: true });
  else console.log(`kept ${work}`);
}

main();
