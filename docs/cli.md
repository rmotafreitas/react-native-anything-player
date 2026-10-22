# CLI

`rnap` checks a project against what RNAP needs, lists and switches the build modules, estimates their size, reports a bug-ready summary, and rewrites the mechanical part of a migration. Every command that changes a file shows a unified diff first.

| Command | |
|---|---|
| `rnap modules` | the build modules and whether this project has them |
| `rnap add` / `rnap remove` | turn a build module on or off |
| `rnap size` | what the modules add to a release APK and a web page |
| `rnap doctor` | what is wrong with the setup |
| `rnap init` | apply the safe fixes |
| `rnap info` | one report to paste into a bug report |
| `rnap migrate` | rewrite Track Player, expo-audio or expo-av calls |

## Running

No install:

```sh
npx rnap doctor
```

`react-native-anything-player` installs the `rnap` binary, so `npx react-native-anything-player doctor` runs the same CLI. The short name is what the rest of this page uses.

Until the package is on npm, run it from the release tarball:

```sh
npx --package=https://github.com/rmotafreitas/react-native-anything-player/releases/latest/download/react-native-anything-player.tgz rnap doctor
```

Installed (`npm install react-native-anything-player`, or the tarball), the commands are:

```sh
npx rnap doctor
npx rnap modules
npx rnap add cast
```

Node 20 or newer. The bundled CLI has no runtime dependencies and reads files only, except `--url` (one request per URL) and `info` (it runs `npm --version` and `yarn --version`).

## Options

| Option | |
|---|---|
| `--cwd <dir>` | Project directory. Default: the current directory |
| `--json` | Machine-readable report ([shapes](#json)) |
| `--dry-run` | Show the changes and write nothing (`add`, `remove`, `migrate`) |
| `--yes`, `-y` | Apply every change without asking (`init`, `add`, `remove`, `migrate`) |
| `--no-color` | Plain text. Colours are off anyway when the output is not a terminal, or when `NO_COLOR` is set |
| `--help`, `-h` | Usage, or one command's help after the command |
| `--version`, `-v` | CLI version |

Command options:

| Option | Command | |
|---|---|---|
| `--url <url>` | `doctor` | Stream URL to probe. Repeat for several |
| `--package-urls` | `doctor` | Also probe the URLs listed in package.json `rnap.urls` |
| `--from <library>` | `migrate` | `track-player`, `expo-audio` or `expo-av` |

`--json` without `--yes` is a dry run for `init`, `add`, `remove` and `migrate`: the report says what would change, and no file is written.

## Exit codes

| Code | |
|---|---|
| 0 | No errors (`doctor`, `init`), changed, already so, or nothing accepted (`add`, `remove`, `migrate`), a report (`modules`, `size`, `info`) |
| 1 | At least one error (`doctor`, `init`), no package.json here (`modules`, `add`, `remove`, `size`), cannot change the project safely (`add`, `remove`), a file could not be parsed (`migrate`), no measured data (`size`) |
| 2 | Bad usage: unknown command, unknown option, unknown module, no command, or a `--cwd` that does not exist |

`info` always exits 0: it is the report you send when something is wrong.

## Modules

A module is a build-time part of RNAP. `rnap modules` lists them all:

```
  on  hls              default                HLS streams on Android (the Media3 HLS module). iOS plays HLS itself.
                                              64 KB of the default build
  off cast             default                Cast to Chromecast and Google Home devices.
                                              adds 1.4 MB with R8
```

The middle column is where the state comes from: `default`, `android/gradle.properties`, `ios/Podfile.properties.json`, `Info.plist`, `app.json` (the Expo plugin), or `by hand` for a module set up without the CLI. The first column is the state a build produces.

| Module | Platforms | Default | Switch |
|---|---|---|---|
| `hls` | Android | on | `rnapHls` in `android/gradle.properties` |
| `cast` | Android, iOS | off | `rnapCast` (Android), `rnap.cast` in `ios/Podfile.properties.json`, the Cast discovery keys in `Info.plist` |
| `siri` | iOS | off | by hand: an Intents extension, the entitlement and `NSSiriUsageDescription`, or the Expo plugin's `siri` |
| `assistant` | Android | on | by hand: the search intent filter and `AnythingPlayer.handleIntent`, or the Expo plugin's `assistant` |
| `background-audio` | iOS | on | `audio` in `UIBackgroundModes`, or the Expo plugin's `backgroundAudio` |
| `sound` | Android, iOS | off | not in this version yet ([roadmap](roadmap.md)) |
| `car` | Android, iOS | off | not in this version yet ([roadmap](roadmap.md)) |

The defaults describe the Expo plugin and the measured release build. A bare app reads its native files: `rnapHls=false` is off even though HLS is on by default.

`rnap add <module…>` turns modules on, `rnap remove <module…>` turns them off. Both write one change per file, so adding Cast and HLS edits `gradle.properties` once.

- **Bare app:** `android/gradle.properties`, `ios/Podfile.properties.json`, and the app's `Info.plist` for the Cast keys and the background mode. `add cast` also adds `NSLocalNetworkUsageDescription` and the two `NSBonjourServices` entries; `remove cast` drops the Bonjour entries and keeps the usage description.
- **Expo app:** one option in the `react-native-anything-player` entry of `expo.plugins` in app.json. Run `npx expo prebuild` afterwards.
- **app.config.js/ts:** never edited. The exact snippet is printed.
- **Manual modules:** Siri and Assistant print the steps. Turning one off prints a generic "reverse the setup" note; the CLI does not guess what to delete.
- **Planned modules:** Sound and Cars change nothing. `add` says they are not in this version yet; `remove` reports that they are already off.

With no module names and a terminal, `rnap add` opens a picker: space toggles, Enter applies, `q` quits. Outside a terminal it asks for a name and exits 2.

`add` and `remove` exit 1 when there is no package.json or a file cannot be changed safely (a symlink pointing out of the project, an unparsable plist, an unparsable JSON file). The unsafe edit becomes a printed instruction instead.

The doctor reports a `module-conflict` warning when the Expo plugin and a native switch disagree. `expo prebuild` rewrites the native files from app.json, so one of the two would win by accident.

## Doctor

`doctor` only reports. Every finding has an id, a severity (`error`, `warning`, `info`), a message, and — when something can be changed — a fix: the file and what to change there.

### Project

| Id | Severity | What it checks | Fix |
|---|---|---|---|
| `project-package-json` | error | There is a package.json here | Run from the app directory, or pass `--cwd` |
| `react-native-version` | error | `react-native` is 0.80 or newer. RNAP is a TurboModule; the legacy architecture is not supported | Upgrade React Native |
| `expo-sdk` | error / warning | Expo SDK 54 or newer (the first with RN 0.80), and that `expo` is a dependency | Upgrade Expo |
| `library-installed` | error / info | `react-native-anything-player` resolves, in `node_modules` or in a workspace | `npm install react-native-anything-player` |
| `expo-plugin` | error | The plugin is in `expo.plugins` | Add it, then rebuild or `npx expo prebuild` |
| `expo-plugin-options` | error / warning | The options are the ones the registry knows: `backgroundAudio`, `cast`, `siri`, `assistant`. Cast takes `receiverApplicationId` and `localNetworkUsageDescription`; Siri takes `usageDescription` and `appIntents` | Fix the plugin entry in app.json |
| `expo-config-js` | info | app.config.js/ts cannot be evaluated. Expo checks then read app.json only | Verify by hand |
| `new-arch-ios` | error | New Architecture is not switched off (`Podfile.properties.json`, `RCT_NEW_ARCH_ENABLED`, `newArchEnabled` in app.json) | Enable it, then `pod install` |
| `new-arch-android` | error | `newArchEnabled=true` in `android/gradle.properties` | Enable it, then rebuild |
| `module-conflict` | warning | The Expo plugin and an explicitly written native switch disagree | Set the plugin option and the native file to the same value, or let `expo prebuild` write it |

### iOS

| Id | Severity | What it checks | Fix |
|---|---|---|---|
| `ios-info-plist` | error / warning | The app's `Info.plist` exists and parses | Create or repair it |
| `ios-background-audio` | error | `UIBackgroundModes` contains `audio`. Expo: app.json plus the plugin's `backgroundAudio` | Add the mode, or remove `backgroundAudio: false` |
| `ios-scene-lifecycle` | warning | `UIApplicationSceneManifest` is present. iOS 27 traps at launch without the scene life cycle | Move window creation to a `UIWindowSceneDelegate` |
| `ios-cast-discovery` | error | With Cast on: `NSLocalNetworkUsageDescription` and `NSBonjourServices` with `_googlecast._tcp` and `_<receiverId>._googlecast._tcp` | Add the keys, or use `cast: true` |
| `ios-cast-pod` | warning | `ios/Podfile.properties.json` sets `rnap.cast` when Cast is configured | Set it, then `pod install` |
| `ios-siri` | error | With Siri on: the RNAPIntents target, `NSSiriUsageDescription`, `INPlayMediaIntent` in `NSUserActivityTypes`, and the Siri entitlement | Follow [Voice assistants](voice.md#siri) |
| `ios-pods` | error / warning | `ios/Pods` exists, and `Podfile.lock` lists AnythingPlayer | `cd ios && pod install` |
| `ios-pod-version` | error | The pod version equals the library's version | `pod install` |
| `ios-deployment-target` | error | iOS 15.1 or newer in the pbxproj and Podfile | Raise the deployment target |

### Android

| Id | Severity | What it checks | Fix |
|---|---|---|---|
| `android-minsdk` | error | `minSdkVersion` 24 or newer | Raise it |
| `android-compilesdk` | warning | `compileSdkVersion` 36 or newer, what RNAP compiles against | Raise it |
| `android-cast` | warning | `rnapCast=true` when Cast is on for iOS or in the plugin | Add the property, then rebuild |
| `android-assistant` | error / warning | The main activity has the `MEDIA_PLAY_FROM_SEARCH` filter and calls `AnythingPlayer.handleIntent` in `onCreate` and `onNewIntent`. Expo: the plugin does it unless `assistant: false` | Follow [Voice assistants](voice.md#google-assistant-gemini) |

### Streams

`--url`, plus `rnap.urls` in package.json with `--package-urls`. Redirects are followed up to five times, only to `http(s)` URLs, and never from a public host to a private address (loopback, private ranges, link-local metadata endpoints):

```json
{
  "rnap": { "urls": ["https://radio.example/live.mp3"] }
}
```

Each URL gets one `GET` with `Icy-MetaData: 1`. The CLI reads the headers and a few KB, then closes the connection. Timeout: 10 s. With several URLs an id repeats; the message names the URL.

| Id | Severity | What it checks | Fix |
|---|---|---|---|
| `url-invalid` | error | The URL is http(s) | Use `http://` or `https://` |
| `url-ios-ats` | error | Cleartext http is allowed: `NSAllowsArbitraryLoads`, `NSAllowsLocalNetworking` for local hosts, or an `NSExceptionDomains` entry | Add the exception, or use https |
| `url-android-cleartext` | error / info | Cleartext is allowed by `usesCleartextTraffic` or a network security config. Info when the manifest uses a build placeholder, or before a prebuild | Add a domain-config, or use https |
| `url-request` | error | The server answers 2xx | Fix the URL or the server |
| `url-redirect` | warning / info | Redirects are named; a final http hop after https is a warning | Serve https at the final URL |
| `url-cast` | warning | MP3, AAC or HLS, which every Cast receiver decodes | Serve one of them |
| `url-icy` | info | `icy-metaint` present (titles available) | — |
| `url-cors` | warning / info | `Access-Control-Allow-Origin`, and `icy-metaint` in `Access-Control-Expose-Headers` when ICY is sent. A warning when the project can run on the web, else info | Send the headers ([Web](web.md#what-the-stream-server-must-send)) |

## Size

`rnap size` prints two tables. The first is the release Android APK, with R8 and without: the default build, this project with the modules it has on, and one line per module. A module that is not measured says so instead of guessing. The second is the web page, gzipped: the first load and the total, plus anything loaded later.

The numbers are measured once on a React Native release build and bundled into the CLI. They are estimates for this app: other libraries share Media3 and OkHttp, and R8 results change with your rules. The last lines of the output name the measurement.

`size` exits 1 when there is no package.json or the measured data is missing (a broken install), and 2 for bad usage.

## Info

`rnap info` prints one report for a bug report: CLI and library versions, the project kind, React Native, Expo SDK, Media3, the New Architecture, iOS and Android levels, the modules that are on and off, the tools on the machine (Node, npm, yarn), and the doctor's findings. Paths under your home directory print as `~/…`; no environment variables are dumped.

It works in any directory and always exits 0. Without a package.json, the report says so through the doctor's `project-package-json` finding.

## Migrate

`rnap migrate` rewrites the mechanical part of a migration from Track Player, expo-audio or expo-av. It parses each file and replaces exact source ranges, so the rest of the formatting survives.

```sh
npx rnap migrate --dry-run
npx rnap migrate src App.tsx --from expo-av
```

Paths are files or directories. The default is the whole project, skipping `node_modules`, `ios`, `android`, build outputs, `lib` and dot directories. `--from` is detected from the imports when it is omitted.

What moves:

- **Imports:** the old package's import is rewritten. Names with an RNAP equivalent move to `react-native-anything-player`; names without one stay in the old import. An import with nothing left is removed.
- **Track Player:** `TrackPlayer.play()` and the other one-to-one commands become `player.play()`; `seekBy(n)`, `getVolume()`, `getState()` and the hooks get the equivalents the [guide](migrating-from-track-player.md) describes; `State.Playing` becomes `'playing'`.
- **expo-audio:** `createAudioPlayer()` becomes `const player = new Player()` plus `player.load(source)`; `volume = …` and `muted = …` become `setVolume()` and `setMuted()`; `replace`, `seekTo`, `setPlaybackRate` and `useAudioPlayerStatus` are renamed.
- **expo-av:** `Audio.Sound.createAsync()` becomes `await player.load(source)`, the `sound.*Async()` calls become player calls, and `Audio.setAudioModeAsync()` is deleted (the constructor options cover it).

What stops the rewrite:

- Track Player: one command without a mechanical mapping (`setupPlayer`, `addEventListener`, the queue calls) keeps `TrackPlayer` where it is, and only the hooks and state constants move.
- expo-audio: a `useAudioPlayer()` hook in the file is left alone (it creates a player tied to a component).
- expo-av: anything except `const { sound } = await Audio.Sound.createAsync(…)` in a single-variable declaration is left alone.

A file with something left to do gets a header that names the guide sections:

```ts
// rnap-migrate: what still needs a human, from docs/migrating-from-expo-av.md
//  - Audio.Sound.createAsync() became one module-scope player… (…)
//  - The added `import { player } from './player'` must point at the module that creates `new Player()`.
```

A second run changes nothing: the header is merged, not repeated.

Exit codes: 0 rewrote or found nothing, 1 at least one file could not be parsed, 2 an unknown `--from`, a path that does not exist, or a path outside the project. A parse failure is listed by file and does not stop the other files.

## Init

`init` computes the fixes it can make safely and shows each one as a unified diff. Answer `y` to apply it, `n` to skip. `--yes` applies all.

| Fix id | Applied to |
|---|---|
| `ios-background-audio` | The app's `Info.plist`: adds `audio` to `UIBackgroundModes` (bare) |
| `ios-new-arch` | `ios/Podfile.properties.json`: sets `newArchEnabled` to `"true"` |
| `android-new-arch` | `android/gradle.properties`: sets `newArchEnabled=true` |
| `expo-plugin` | app.json: adds `"react-native-anything-player"` to `expo.plugins` |
| `expo-new-arch` | app.json: sets `expo.newArchEnabled` to `true` |

Everything else is printed with its manual fix: app.config.js/ts is never rewritten (JavaScript configs are reported only), and choices that belong to you (Cast, Siri, ATS exceptions, network security configs, SDK levels, Pods) are not changed.

Files are only written inside the project directory. A second run applies nothing. When errors remain, `init` exits 1 and lists them.

## JSON

Every `--json` report starts with `schemaVersion: 1` and the `command` that printed it. Unknown fields may be added in a minor release; existing fields keep their meaning.

`doctor --json` prints one object:

```json
{
  "schemaVersion": 1,
  "command": "doctor",
  "cwd": "/absolute/project/path",
  "ok": false,
  "project": {
    "kind": "expo",
    "reactNative": "0.86.3",
    "library": {
      "version": "1.1.0",
      "installed": true,
      "path": "node_modules/react-native-anything-player"
    },
    "expo": { "sdk": 57, "configFile": "app.json" },
    "platforms": { "ios": false, "android": false }
  },
  "findings": [
    {
      "id": "expo-plugin",
      "severity": "error",
      "message": "The RNAP config plugin is not listed…",
      "fix": { "file": "app.json", "change": "add \"react-native-anything-player\"…" },
      "autofix": "expo-plugin"
    }
  ],
  "urls": [
    {
      "url": "https://radio.example/live.mp3",
      "finalUrl": "https://radio.example/live.mp3",
      "status": 200,
      "statusText": "OK",
      "contentType": "audio/mpeg",
      "codec": "mp3",
      "icyMetaInt": "16000",
      "headers": { "access-control-allow-origin": "*" },
      "redirects": [],
      "bytesRead": 4096
    }
  ],
  "summary": { "errors": 1, "warnings": 0, "infos": 0 }
}
```

- `project.kind` is `bare`, `expo`, or `both` (Expo with native projects on disk). `library` and `expo` are `null` when they do not apply.
- `findings[].fix` is `null` for info findings.
- `findings[].autofix` is the fix id `init` can apply, or `null`.
- `urls[]` carries `{ url, error, redirects }` instead of the probe fields when the request failed.
- `ok` is `true` when there are no errors. `summary` counts findings by severity.

`init --json` prints the same shape for its own command:

```json
{
  "schemaVersion": 1,
  "command": "init",
  "cwd": "/absolute/project/path",
  "dryRun": false,
  "ok": true,
  "applied": [{ "id": "expo-plugin", "file": "app.json", "change": "…" }],
  "skipped": [],
  "findings": [],
  "summary": { "errors": 0, "warnings": 0, "infos": 0 }
}
```

Without `--yes`, `init --json` is a dry run: `applied` is empty and no file changes. `findings` and `summary` describe the project after the run (or before, for a dry run).

`modules --json`:

```json
{
  "schemaVersion": 1,
  "command": "modules",
  "cwd": "/absolute/project/path",
  "project": { "kind": "bare", "ios": true, "android": true },
  "modules": [
    {
      "id": "hls",
      "label": "HLS",
      "description": "HLS streams on Android (the Media3 HLS module). iOS plays HLS itself.",
      "defaultOn": true,
      "platforms": ["android"],
      "effective": true,
      "source": "default",
      "expo": null,
      "android": true,
      "ios": null,
      "docs": "docs/configuration.md#build-time-options",
      "size": { "r8": 65536, "noR8": 98304 },
      "sizeNote": null
    }
  ],
  "summary": { "on": 3, "total": 7 }
}
```

`expo`, `android` and `ios` are the state in each place, or `null` when the place does not apply. `effective` is what a build produces. `size` is `null` when the module is not measured; `sizeNote` says why.

`add --json` and `remove --json`:

```json
{
  "schemaVersion": 1,
  "command": "add",
  "cwd": "/absolute/project/path",
  "dryRun": false,
  "picked": false,
  "modules": [
    { "id": "cast", "was": false, "now": true, "changed": true, "already": false }
  ],
  "applied": [
    {
      "modules": ["cast"],
      "file": "android/gradle.properties",
      "change": "set `rnapCast=true`",
      "diff": "--- a/android/gradle.properties…"
    }
  ],
  "skipped": [],
  "manual": [],
  "nextSteps": ["rebuild the app (npx expo run:ios / run:android, or your own build)"]
}
```

`was` and `now` are the module state before and after; `changed` says whether a file changed; `already` says the project was already in the requested state. `manual` is `[{ module, step }]` for steps the CLI cannot make safely. `dryRun` is `true` for `--dry-run`, and for `--json` without `--yes`.

`size --json`:

```json
{
  "schemaVersion": 1,
  "command": "size",
  "cwd": "/absolute/project/path",
  "measured": {
    "at": "2026-10-22",
    "reactNative": "0.86.3",
    "abi": "arm64-v8a",
    "version": "1.1.1",
    "method": "benchmarks/android/measure-apk.mjs"
  },
  "note": "Measured on a React Native 0.86.3 arm64-v8a release build…",
  "android": {
    "base": { "r8": 1204382, "noR8": 3847757 },
    "total": { "r8": 2672113, "noR8": 11239208 },
    "modules": [
      {
        "id": "cast",
        "label": "Google Cast",
        "enabled": true,
        "defaultOn": false,
        "measured": true,
        "cost": { "r8": 1467731, "noR8": 7391451 },
        "note": null
      }
    ]
  },
  "web": [
    {
      "id": "rnWeb",
      "title": "Expo web and React Native Web",
      "initialGzipBytes": 30189,
      "totalGzipBytes": 36138,
      "later": [
        { "name": "hls.js", "gzipBytes": 188659, "when": "HLS outside Safari (the app adds it)" }
      ]
    }
  ]
}
```

`base` is the default build; `total` adds the modules whose `enabled` differs from `defaultOn`.

`info --json`:

```json
{
  "schemaVersion": 1,
  "command": "info",
  "cwd": "/absolute/project/path",
  "cli": { "version": "1.1.1" },
  "collectedAt": "2026-10-22T12:00:00Z",
  "environment": {
    "os": "Darwin 25.0.0 (arm64)",
    "node": "v24.0.0",
    "npm": "11.0.0",
    "yarn": "4.0.0"
  },
  "project": {
    "kind": "bare",
    "reactNative": "0.86.3",
    "library": { "version": "1.1.0", "installed": true, "path": "node_modules/react-native-anything-player" },
    "expo": null,
    "media3Version": "1.11.1",
    "newArchitecture": true,
    "ios": { "deploymentTarget": "15.1" },
    "android": { "minSdk": 24, "compileSdk": 36, "targetSdk": null },
    "modules": { "on": ["hls", "assistant", "background-audio"], "off": ["cast", "siri", "sound", "car"] }
  },
  "doctor": {
    "ok": true,
    "summary": { "errors": 0, "warnings": 0, "infos": 0 },
    "findings": []
  }
}
```

`cwd` and `library.path` are display paths: a path under your home directory prints as `~/…`.

`migrate --json`:

```json
{
  "schemaVersion": 1,
  "command": "migrate",
  "cwd": "/absolute/project/path",
  "from": "auto",
  "dryRun": false,
  "files": [
    { "file": "src/audio.ts", "source": "expo-audio", "notes": ["…"] }
  ],
  "applied": ["src/audio.ts"],
  "skipped": [],
  "unparsed": [{ "file": "src/broken.ts", "reason": "could not parse: Unexpected token (2:10)" }]
}
```

`from` is `auto` when it was detected, else the `--from` value. `notes` are the guide lines that go into the `// rnap-migrate:` header. `skipped` carries `{ file, reason: "not applied" }` for a dry run or a declined change; `unparsed` is why a file could not be read.
