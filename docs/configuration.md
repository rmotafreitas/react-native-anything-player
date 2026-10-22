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
  diagnostics: false,        // stream engine traces as 'diagnostic' events and to the native log
  progressInterval: 0,       // ms between 'progress' events from a native timer while playing; 0 = off
});
```

Options are fixed for the player's lifetime. The audio-session configuration (iOS category/mode) follows the player that last requested playback.

With an `id`, a player outlives the JavaScript that created it, and `new Player({ id })` attaches to the native player with that id (one Siri or Google Assistant started, or one that kept playing across a reload), keeping its options. See [Voice assistants](voice.md#playing-a-request).

App-wide settings live outside `Player`: the voice catalog (`setCatalog`, [Voice assistants](voice.md)), Cast (`configureCast` on the web, [Casting & AirPlay](routes-and-casting.md)) and hls.js on the web (`configureHls`, [Web](web.md#hls)).

## Build-time options

| Where | Option | Effect |
|---|---|---|
| `android/gradle.properties` | `rnapHls=false` | drop Media3's HLS module (~300 KB) |
| root `build.gradle` `ext` | `rnapMedia3Version = "1.x.y"` | pin a Media3 version (default 1.11.1) |
| `AndroidManifest.xml` `<application>` | `<meta-data android:name="com.anythingplayer.FOREGROUND_TIMEOUT_MS" android:value="…"/>` | how long a paused session stays in the foreground (Media3 default and max: 10 min) |
| `android/gradle.properties` | `rnapCast=true` | build Google Cast in (Media3 Cast and the Cast framework) |
| `AndroidManifest.xml` `<application>` | `<meta-data android:name="com.anythingplayer.CAST_RECEIVER_ID" android:value="…"/>` | your own Cast receiver (default: the Default Media Receiver) |
| `pod install` | `RNAP_CAST=1` (or `"rnap.cast": "true"` in `ios/Podfile.properties.json`) | build Google Cast in on iOS |
| `Info.plist` | `RNAPCastReceiverId` | your own Cast receiver on iOS |
| Expo config plugin | `["react-native-anything-player", { "backgroundAudio": false }]` | do not add the iOS `audio` background mode |
| Expo config plugin | `cast`, `siri`, `assistant` | Google Cast, Siri (extension and shortcuts), Google Assistant / Gemini: see [Getting started](getting-started.md#expo) |

The recovery timings that are *not* configurable are fixed on purpose; [recovery.md](recovery.md) explains each.
