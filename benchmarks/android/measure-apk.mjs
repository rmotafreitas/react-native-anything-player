#!/usr/bin/env node
// What each React Native audio library adds to a release APK, with R8 on and
// off, measured by building a real app.
//
//   node benchmarks/android/measure-apk.mjs [--only rnap,rntp5,expoAv] [--keep]
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
// The same bare app again with the Expo modules runtime (`expo` and its
// autolinking, as `npx install-expo-modules` sets a bare app up), measured
// alone and then with expo-audio and expo-av. Those two are recorded against
// the Expo app, not the bare one (`over: 'expo'`): the runtime's own cost is
// the `expoRuntime` row. The app's JS still imports nothing.
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
  {
    id: 'rnapSound',
    label: 'RNAP with Sound',
    install: ['@rnap'],
    gradle: { rnapSound: 'true' },
  },
  {
    id: 'rnapCar',
    label: 'RNAP with Android Auto',
    install: ['@rnap'],
    gradle: { rnapCar: 'true' },
  },
  {
    id: 'rnapVideo',
    label: 'RNAP with video',
    install: ['@rnap'],
    gradle: { rnapVideo: 'true' },
  },
  {
    // Before a decoders release is published, RNAP_DECODERS_DIR names a
    // folder of them (scripts/decoders/build-android.sh).
    id: 'rnapVideoDecoders',
    label: 'RNAP with video and its software decoders',
    install: ['@rnap'],
    gradle: {
      rnapVideo: 'true',
      rnapVideoDecoders: 'true',
      ...(process.env.RNAP_DECODERS_DIR
        ? { rnapDecodersDir: process.env.RNAP_DECODERS_DIR }
        : {}),
    },
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

/** The Expo SDK version this repo pairs React Native with (example-expo). */
const EXPO = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'example-expo/package.json'), 'utf8')
).dependencies.expo;

/**
 * The Expo libraries. `install` may be replaced by the version Expo's own
 * install tool would pick, from expo's bundledNativeModules.json.
 */
const EXPO_LIBRARIES = [
  { id: 'expoAudio', label: 'expo-audio', install: ['expo-audio'] },
  {
    id: 'expoAv',
    label: 'expo-av',
    // Not in this Expo SDK's bundledNativeModules.json (it left the SDK with
    // 54): latest is what `npx expo install` resolves, its prebuilt AAR
    // links against older Expo APIs, so R8 needs -dontwarn rules (what
    // Android Studio suggests a store app to add).
    install: ['expo-av'],
    proguard: [
      '-dontwarn expo.modules.core.interfaces.services.KeepAwakeManager',
      '-dontwarn expo.modules.kotlin.types.AnyTypeProvider',
      '-dontwarn expo.modules.kotlin.types.LazyKType',
    ],
  },
];
const EXPO_IDS = ['expoRuntime', ...EXPO_LIBRARIES.map((l) => l.id)];

/** What orders the merged apk.json rows: bare libraries, then the Expo ones. */
const ORDER = [
  ...LIBRARIES,
  { id: 'expoRuntime' },
  ...EXPO_LIBRARIES,
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
function scaffold(app, expo = false) {
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(
    path.join(app, 'package.json'),
    JSON.stringify(
      {
        name: 'bench',
        version: '0.0.1',
        private: true,
        dependencies: {
          'react': RN.react,
          'react-native': RN['react-native'],
          ...(expo ? { expo: EXPO } : {}),
        },
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
    expo
      ? `package bench

import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

import expo.modules.ReactActivityDelegateWrapper

class MainActivity : ReactActivity() {
  override fun getMainComponentName(): String = "bench"
  override fun createReactActivityDelegate(): ReactActivityDelegate {
    return ReactActivityDelegateWrapper(
          this,
          BuildConfig.IS_NEW_ARCHITECTURE_ENABLED,
          DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled))
  }
}
`
      : `package bench

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
    expo
      ? `package bench

import android.app.Application
import android.content.res.Configuration
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative

import expo.modules.ApplicationLifecycleDispatcher
import expo.modules.ExpoReactHostFactory

class MainApplication : Application(), ReactApplication {
  override val reactHost: ReactHost by lazy {
    ExpoReactHostFactory.getDefaultReactHost(context = applicationContext, packageList = PackageList(this).packages)
  }

  override fun onCreate() {
    super.onCreate()
    loadReactNative(this)
    ApplicationLifecycleDispatcher.onApplicationCreate(this)
  }

  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    ApplicationLifecycleDispatcher.onConfigurationChanged(this, newConfig)
  }
}
`
      : `package bench

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
    expo
      ? // What `npx install-expo-modules` leaves in a bare app: Expo's own
        // settings plugin wraps the React Native one.
        `pluginManagement { includeBuild('../node_modules/@react-native/gradle-plugin')
  def expoPluginsPath = new File(
    providers.exec {
      workingDir(rootDir)
      commandLine("node", "--print", "require.resolve('expo-modules-autolinking/package.json', { paths: [require.resolve('expo/package.json')] })")
    }.standardOutput.asText.get().trim(),
    '../android/expo-gradle-plugin'
  ).absolutePath
  includeBuild(expoPluginsPath)
}

plugins { id('com.facebook.react.settings')
  id('expo-autolinking-settings')
}

extensions.configure(com.facebook.react.ReactSettingsExtension){ ex -> ex.autolinkLibrariesFromCommand(expoAutolinking.rnConfigCommand) }

expoAutolinking.useExpoModules()

rootProject.name = 'bench'

expoAutolinking.useExpoVersionCatalog()

include ':app'
includeBuild(expoAutolinking.reactNativeGradlePlugin)
`
      : s.replace(/rootProject\.name = '[^']+'/, "rootProject.name = 'bench'")
  );
  edit('gradle.properties', (s) =>
    s
      .replace(
        /reactNativeArchitectures=.*/,
        'reactNativeArchitectures=arm64-v8a'
      )
      .replace(/-Xmx\d+m/, '-Xmx4096m')
  );
  if (expo)
    // The Expo settings plugin's companion, what install-expo-modules appends.
    fs.appendFileSync(
      path.join(android, 'build.gradle'),
      'apply plugin: "expo-root-project"\n'
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

/** The package spec without its version range ('expo-audio@~57.0.5' → 'expo-audio'). */
const baseName = (s) => {
  const at = s.startsWith('@') ? s.indexOf('/', 1) + 1 : 0;
  const v = s.indexOf('@', at);
  return v > 0 ? s.slice(0, v) : s;
};

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
  const npmFor = (dir) => (...argv) =>
    run('npm', [...argv, '--no-audit', '--no-fund', '--legacy-peer-deps'], {
      cwd: dir,
    });
  const npm = npmFor(app);
  npm('install');

  const measure = (appDir, label, gradle) => {
    const sizes = {
      r8: build(appDir, true, gradle),
      noR8: build(appDir, false, gradle),
    };
    console.log(
      `  ${label.padEnd(26)} R8 on ${(sizes.r8.apkBytes / 1024).toFixed(0).padStart(7)} KB   R8 off ${(sizes.noR8.apkBytes / 1024).toFixed(0).padStart(7)} KB`
    );
    return sizes;
  };
  const delta = (a, b) =>
    Object.fromEntries(Object.keys(a).map((k) => [k, a[k] - b[k]]));
  const versionOf = (appDir, pkg) =>
    JSON.parse(
      fs.readFileSync(path.join(appDir, 'node_modules', pkg, 'package.json'), 'utf8')
    ).version;
  /** One app: scaffold installs done, an empty measure, then one per library. */
  const measureLibraries = (
    appDir,
    npmFn,
    baselineRef,
    libs,
    { label0 } = {}
  ) => {
    const rows = [];
    if (label0) measure(appDir, label0);
    const proguardFile = path.join(appDir, 'android/app/proguard-rules.pro');
    const proguardOriginal = fs.readFileSync(proguardFile, 'utf8');
    for (const lib of libs) {
      const specs = lib.install.map((s) => (s === '@rnap' ? rnap : s));
      try {
        if (lib.proguard)
          // What a real app would add to ship this library with R8.
          fs.writeFileSync(
            proguardFile,
            `${proguardOriginal}${lib.proguard.join('\n')}\n`
          );
        npmFn('install', ...specs);
        const sizes = measure(appDir, lib.label, lib.gradle);
        const pkg =
          lib.pkg ??
          (lib.install[0] === '@rnap'
            ? 'react-native-anything-player'
            : baseName(lib.install[0]));
        const version = versionOf(appDir, pkg);
        rows.push({
          id: lib.id,
          label: lib.label,
          name: pkg,
          version,
          gradle: lib.gradle ?? {},
          ...(lib.over ? { over: lib.over } : {}),
          r8: delta(sizes.r8, baselineRef.r8),
          noR8: delta(sizes.noR8, baselineRef.noR8),
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
        fs.writeFileSync(proguardFile, proguardOriginal);
        const names = lib.install.map((s) =>
          s === '@rnap' ? 'react-native-anything-player' : baseName(s)
        );
        npmFn('uninstall', ...names);
      }
    }
    return rows;
  };

  let previous = null;
  try {
    previous = JSON.parse(fs.readFileSync(out, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const bare = !only || only.some((id) => LIBRARIES.some((l) => l.id === id));
  const expo = !only || only.some((id) => EXPO_IDS.includes(id));
  // RNAP is packed from this checkout only when it is being measured.
  const wantRnap = bare && !rnapTarball;
  if (wantRnap && !fs.existsSync(path.join(ROOT, 'lib/module/index.js')))
    run('yarn', ['prepare'], { cwd: ROOT });
  let rnap = rnapTarball ? path.resolve(rnapTarball) : null;
  if (!rnap && wantRnap) rnap = packRnap(work);
  // The expoRuntime row is a delta over the bare empty app, so that baseline
  // is also needed when only the Expo ids are requested. When it is not
  // rebuilt, the previous run's stored baseline stands (that row is left
  // untouched by the merge).
  const needBare = bare || only?.includes('expoRuntime');
  let baseline = null;
  if (needBare) {
    console.log('building (empty bare app, arm64-v8a, release):');
    baseline = measure(app, 'empty app');
  } else baseline = previous?.baseline ?? null;
  if (expo && !baseline)
    throw new Error(
      `the Expo runtime row needs the bare baseline; run once without --only, or --only expoRuntime`
    );

  let rows = [];
  if (bare)
    rows.push(
      ...measureLibraries(app, npm, baseline, LIBRARIES.filter((l) => !only || only.includes(l.id)))
    );

  if (expo) {
    const appExpo = path.join(work, 'app-expo');
    console.log(`scaffolding the Expo modules app in ${appExpo} …`);
    scaffold(appExpo, true);
    const npmExpo = npmFor(appExpo);
    npmExpo('install');
    // The runtime the modules come from is measured over the bare empty app…
    console.log('building (Expo modules runtime, arm64-v8a, release):');
    const expoSizes = measure(appExpo, 'Expo modules runtime');
    rows.push({
      id: 'expoRuntime',
      label: 'Expo modules runtime',
      name: 'expo',
      version: versionOf(appExpo, 'expo'),
      gradle: {},
      r8: delta(expoSizes.r8, baseline.r8),
      noR8: delta(expoSizes.noR8, baseline.noR8),
    });
    // …and each Expo module over the Expo app.
    const bundled = JSON.parse(
      fs.readFileSync(
        path.join(appExpo, 'node_modules', 'expo', 'bundledNativeModules.json'),
        'utf8'
      )
    );
    const libs = EXPO_LIBRARIES.map((lib) => ({
      ...lib,
      install: lib.install.map((s) => (bundled[s] ? `${s}@${bundled[s]}` : s)),
      over: 'expo',
    }));
    rows.push(
      ...measureLibraries(appExpo, npmExpo, expoSizes, libs.filter((l) => !only || only.includes(l.id)))
    );
  }

  const merged = [
    ...(previous?.libraries ?? []).filter((p) => !rows.some((r) => r.id === p.id)),
    ...rows,
  ].sort(
    (a, b) =>
      ORDER.findIndex((l) => l.id === a.id) -
      ORDER.findIndex((l) => l.id === b.id)
  );
  fs.writeFileSync(
    out,
    JSON.stringify(
      {
        measuredAt: new Date().toISOString().slice(0, 10),
        method: 'benchmarks/android/measure-apk.mjs',
        reactNative: RN['react-native'],
        abi: 'arm64-v8a',
        baseline: baseline ?? previous?.baseline,
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
