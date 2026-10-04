# Background playback & system integration

## Background playback

Playback continues with the app in the background, the screen locked, and (Android) in Doze. The engine, its timers and the media session are native, so suspended JavaScript timers or a frozen JS thread change nothing. When JavaScript resumes, `player.status` and `getProgress()` already reflect native truth (players refresh on `AppState` → `active`).

**iOS** requires the `audio` background mode ([getting started](getting-started.md)). iOS suspends an app a few seconds after it stops producing audio, which would also freeze recovery during a network outage. While a backgrounded player wants audio but has none (loading, stalled, reconnecting), Airwave renders a near-silent signal (±1 LSB dither, about −90 dBFS) through `AVAudioEngine` so the app stays alive and recovers when the network returns. It never runs while audio flows, and stops when recovery gives up.

**Android** runs a `mediaPlayback` foreground service while playback is engaged, managed by Media3. Streaming holds a partial wake lock and a Wi-Fi lock (screen-off power saving otherwise starves the stream), and Airwave holds its own bounded locks between reconnect attempts, when ExoPlayer holds none.

A paused session leaves the foreground after 10 minutes (Media3 default). Apps can shorten it:

```xml
<!-- android/app/src/main/AndroidManifest.xml, inside <application> -->
<meta-data android:name="com.radioanimu.airwave.FOREGROUND_TIMEOUT_MS" android:value="60000" />
```

Swiping the app away from recents keeps playing music (like most media apps) unless `android.stopOnTaskRemoved: true`.

## Lock screen, notification and hardware controls

Players with `mediaSession.enabled` (default) appear on the iOS lock screen / Control Center and the Android media notification / lock screen. The most recently started such player owns the controls.

Play, pause, play/pause toggle, stop and (for seekable sources) scrubbing are handled **natively**, so headset buttons, Bluetooth, the notification and the lock screen work while JavaScript is frozen. Extra commands are opt-in and forwarded to JS:

```ts
const player = new Player({ mediaSession: { commands: ['next', 'previous', 'skipForward', 'skipBackward'] } });
player.on('remoteCommand', ({ command, position }) => { … });
```

Tapping the Android notification opens the app.

### What the lock screen shows

For each field, the first available value wins:

1. `player.updateNowPlaying({...})` overrides (cleared by the next `load`; pass `{}` to clear),
2. stream metadata (ICY/ID3/HLS), unless `metadata.useStreamMetadataForNowPlaying: false`,
3. the source's `metadata`.

The album line falls back to the station name. Live sources show as live (no scrubber).

### Artwork

`artwork` may be a remote URL, a `file://` URI or `require('./cover.png')`. Artwork never blocks playback or metadata: the info is published immediately and the image is attached when it arrives (10 s timeout), only if it is still the current artwork.

- iOS: downloaded by a dedicated `URLSession` (20 MB disk cache) plus an in-memory cache of 8 images; concurrent requests for the same URL share one download.
- Android: Media3 loads and caches it in-process, so app-private `file://` artwork works (the system UI never has to open the file).

## Audio focus and interruptions

The system's decisions are respected; playback is never resumed against the user's or the system's will.

| Event | Android | iOS | Result |
|---|---|---|---|
| Another app takes over for good | `AUDIOFOCUS_LOSS` | – | paused, `interruption: { reason: 'audio-focus-loss', resumable: false }` |
| Call, voice assistant, short clip | `AUDIOFOCUS_LOSS_TRANSIENT` | interruption began | paused, `resumable: true` |
| It ends | `AUDIOFOCUS_GAIN` | ended with `.shouldResume` and no other app now primary | resumes (live streams at the live edge if the pause outlasted the drift budget) |
| It ends without permission to resume | – | ended without `.shouldResume`, or `secondaryAudioShouldBeSilencedHint` | stays paused, `resumable: false` |
| Navigation prompt | ducked by the system (API 26+) | – | unchanged; `audio.contentType: 'speech'` pauses instead |
| Headphones / Bluetooth disconnected | `AUDIO_BECOMING_NOISY` | route `oldDeviceUnavailable` | paused, `reason: 'output-disconnected'` — never continues on the loudspeaker |
| `play()` during a call | focus denied | session activation fails | rejects `AUDIO_FOCUS_DENIED` |
| Start requested while in the background without a foreground service (Android 15+ denies focus) | – | – | kept as `audio-focus-delayed`; the service is promoted and focus retried for 4 s |

- A user pause during an interruption cancels the pending resume.
- A stale "interruption began" that iOS delivers for a session it deactivated while the app was suspended is ignored.
- `interruptions.autoResume: false` keeps the player paused after every interruption.
- `audio.mixWithOthers: true` opts out of focus and interruptions entirely (and, on iOS, out of lock-screen controls — iOS shows Now Playing only for non-mixable sessions).

## iOS media services reset

When iOS resets its media services, every `AVPlayer` dies. Airwave rebuilds its players, reconfigures the session and re-opens what was loaded with the same intent.
