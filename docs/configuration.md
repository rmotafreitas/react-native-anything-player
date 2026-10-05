# Configuration

Everything is optional; the defaults are what most apps want.

```ts
const player = new Player({
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
});
```

Options are fixed for the player's lifetime. The audio-session configuration (iOS category/mode) follows the player that last requested playback.

## Build-time options

| Where | Option | Effect |
|---|---|---|
| `android/gradle.properties` | `rnapHls=false` | drop Media3's HLS module (~300 KB) |
| root `build.gradle` `ext` | `rnapMedia3Version = "1.x.y"` | pin a Media3 version (default 1.11.1) |
| `AndroidManifest.xml` `<application>` | `<meta-data android:name="com.anythingplayer.FOREGROUND_TIMEOUT_MS" android:value="…"/>` | how long a paused session stays in the foreground (Media3 default and max: 10 min) |
| Expo config plugin | `["react-native-anything-player", { "backgroundAudio": false }]` | do not add the iOS `audio` background mode |

The recovery timings that are *not* configurable are fixed on purpose; [recovery.md](recovery.md) explains each.
