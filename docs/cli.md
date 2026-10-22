# CLI

`rnap` checks a project against what RNAP needs: versions, the New Architecture, the Expo plugin, iOS and Android settings, Pods, and the stream servers you play. It reports; it does not change anything unless you run `init`.

No install:

```sh
npx react-native-anything-player doctor
npx react-native-anything-player init
```

Until the package is on npm, run it from the release tarball:

```sh
npx --package=https://github.com/rmotafreitas/react-native-anything-player/releases/latest/download/react-native-anything-player.tgz rnap doctor
```

Installed (`npm install react-native-anything-player`, or the tarball), the same commands are:

```sh
npx rnap doctor
npx rnap init
```

Node 20 or newer. The CLI has no dependencies and reads files only, except `--url`, which makes one request per URL.

## Options

| Option | |
|---|---|
| `--cwd <dir>` | Project directory. Default: the current directory |
| `--url <url>` | Stream URL to probe. Repeat for several |
| `--package-urls` | Also probe the URLs listed in package.json `rnap.urls` (opt-in: a project's own files never make doctor send requests by themselves) |
| `--json` | Machine-readable report ([schema](#json)) |
| `--yes`, `-y` | `init`: apply every fix without asking |
| `--no-color` | Plain text. Colours are off anyway when the output is not a terminal, or when `NO_COLOR` is set |
| `--help`, `-h` | Usage |
| `--version`, `-v` | CLI version |

Exit codes:

| Code | |
|---|---|
| 0 | No errors. Warnings and info do not fail |
| 1 | At least one error |
| 2 | Bad usage: unknown option, no command, or a `--cwd` that does not exist |

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
| `expo-plugin-options` | error / warning | `backgroundAudio`, `cast`, `siri`, `assistant` are the only options, with the right types | Fix the plugin entry in app.json |
| `expo-config-js` | info | app.config.js/ts cannot be evaluated. Expo checks then read app.json only | Verify by hand |
| `new-arch-ios` | error | New Architecture is not switched off (`Podfile.properties.json`, `RCT_NEW_ARCH_ENABLED`, `newArchEnabled` in app.json) | Enable it, then `pod install` |
| `new-arch-android` | error | `newArchEnabled=true` in `android/gradle.properties` | Enable it, then rebuild |

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

Each URL gets one `GET` with `Icy-MetaData: 1`. The CLI reads the headers and a few KB, then closes the connection. Timeout: 10 s. Redirects are followed. With several URLs an id repeats; the message names the URL.

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

- `project.kind` is `bare` or `expo`. `library` and `expo` are `null` when they do not apply.
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
