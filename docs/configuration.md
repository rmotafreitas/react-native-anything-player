# Configuration

Everything is optional; the defaults are what most apps want.

```ts
const player = new Player({
  id: 'main',                // optional: a stable id; attaches to a native player that already has it
  recovery: {
    reconnect: true,         // reconnect after recoverable failures while playing
    giveUpAfterMs: 600_000,  // stop recovering after 10 min without stable playback; null = never
    liveMaxDriftMs: 5_000,   // live drift (pauses + stalls) re-opened at the live edge on resume
  },
  interruptions: {
    autoResume: true,        // resume when the system ends a transient interruption
  },
  mediaSession: {
    enabled: true,           // lock screen / notification / hardware controls
    commands: [],            // extra commands forwarded to JS: 'next' | 'previous' | 'skipForward' | 'skipBackward'
  },
  audio: {
    contentType: 'music',    // 'speech' pauses for navigation prompts instead of ducking (iOS: spokenAudio mode)
    mixWithOthers: false,    // play alongside other apps (no focus, no interruptions; iOS: no lock screen)
  },
  metadata: {
    streamTitleFormat: 'artist-title',      // 'title-artist' | 'title'
    useStreamMetadataForNowPlaying: true,   // show ICY/ID3 titles on the lock screen
  },
  android: {
    stopOnTaskRemoved: false, // stop when the app is swiped away from recents
  },
  fade: {
    in: 0,                   // s: play() fades in from silence; 0 = off
    out: 0,                  // s: pause() and stop() fade out first; also the sleep timer's default fade-out
  },
  diagnostics: false,        // stream engine traces as 'diagnostic' events and to the native log
  progressInterval: 0,       // ms between 'progress' events from a native timer while playing; 0 = off
});
```

Options are fixed for the player's lifetime, except `fade`, which `setFade()` replaces ([Sleep timer and fades](playback.md#sleep-timer-and-fades)). The audio-session configuration (iOS category/mode) follows the player that last requested playback.

With an `id`, a player outlives the JavaScript that created it, and `new Player({ id })` attaches to the native player with that id (one Siri or Google Assistant started, or one that kept playing across a reload), keeping its options. See [Voice assistants](voice.md#playing-a-request).

App-wide settings live outside `Player`: the voice catalog and its browse tree (`setCatalog`, `setFavorites`, [Voice assistants](voice.md), [Cars & watches](cars-and-watches.md)), Cast (`configureCast` on the web, [Casting & AirPlay](routes-and-casting.md)) and hls.js on the web (`configureHls`, [Web](web.md#hls)).

## Modules

Some parts of RNAP are chosen at build time, not at runtime: HLS, Cast, Siri, Assistant, the iOS background mode, the Sound API and the car integrations. `npx rnap modules` prints each one with the state of this project, `npx rnap add` and `npx rnap remove` write the switch, and [CLI](cli.md#modules) has the table with the platforms and the defaults.

The switch is a native file — `android/gradle.properties`, `ios/Podfile.properties.json`, the app's `Info.plist` — or an option of the Expo config plugin, described in [Build-time options](#build-time-options). `rnap add sound` and `rnap add car` write the Sound API and Android Auto / CarPlay switches ([Sound](sound.md#enabling-it), [Cars & watches](cars-and-watches.md)); CarPlay's entitlement and scene stay with the app, and the CLI prints them.

## Build-time options

| Where | Option | Effect |
|---|---|---|
| `android/gradle.properties` | `rnapHls=false` | drop Media3's HLS module (64 KB of a release APK with R8, 96 KB without) |
| root `build.gradle` `ext` | `rnapMedia3Version = "1.x.y"` | pin a Media3 version (default 1.11.1) |
| `AndroidManifest.xml` `<application>` | `<meta-data android:name="com.anythingplayer.FOREGROUND_TIMEOUT_MS" android:value="…"/>` | how long a paused session stays in the foreground (Media3 default and max: 10 min) |
| `android/gradle.properties` | `rnapCast=true` | build Google Cast in (Media3 Cast and the Cast framework: 1.4 MB more in a release APK with R8) |
| `AndroidManifest.xml` `<application>` | `<meta-data android:name="com.anythingplayer.CAST_RECEIVER_ID" android:value="…"/>` | your own Cast receiver (default: the Default Media Receiver) |
| `android/gradle.properties` | `rnapCar=true` | declare the app a media app for Android Auto ([Cars & watches](cars-and-watches.md#android-auto)); the browse tree itself needs no option |
| `pod install` | `RNAP_CAST=1` (or `"rnap.cast": "true"` in `ios/Podfile.properties.json`) | build Google Cast in on iOS |
| `pod install` | `RNAP_CAR=1` (or `"rnap.car": "true"` in `ios/Podfile.properties.json`) | build the CarPlay scene in; needs Apple's CarPlay audio entitlement ([Cars & watches](cars-and-watches.md#carplay)) |
| `Info.plist` | `RNAPCastReceiverId` | your own Cast receiver on iOS |
| `android/gradle.properties` | `rnapSound=true` | build the [Sound API](sound.md) in (a `SoundPool`: no extra library) |
| `pod install` | `RNAP_SOUND=1` (or `"rnap.sound": "true"` in `ios/Podfile.properties.json`) | build the Sound API in on iOS |
| Expo config plugin | `["react-native-anything-player", { "backgroundAudio": false }]` | do not add the iOS `audio` background mode |
| Expo config plugin | `cast`, `siri`, `assistant`, `sound`, `car` | Google Cast, Siri (extension and shortcuts), Google Assistant / Gemini, the Sound API, CarPlay and Android Auto: see [Getting started](getting-started.md#expo) |

The recovery timings that are *not* configurable are fixed on purpose; [recovery.md](recovery.md) explains each.

### Release builds and R8

Nothing to add to your R8 (ProGuard) rules: RNAP's own are applied to the app automatically. Turn R8 on for release builds (`minifyEnabled true` and `shrinkResources true` in `android/app/build.gradle`) and it removes most of what RNAP's libraries ship and RNAP does not use. RNAP builds ExoPlayer with only the audio and metadata renderers, so the video, subtitle and image code goes, and Android compiles only the C++ of RNAP's module, not that of the iOS-only AirPlay button.

Measured in a React Native 0.86 release APK (arm64-v8a), RNAP adds 1,176 KB with R8 and 3,758 KB without it. [Comparison & benchmarks](comparison.md#added-to-a-release-apk) has the other libraries.
