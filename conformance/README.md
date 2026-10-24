# Engine conformance suite

The playback engine exists three times — `ios/Core/PlaybackEngine.swift`,
`android/src/main/java/com/anythingplayer/core/PlaybackEngine.kt` and
`src/web/engine/PlaybackEngine.ts` — because the platform must own playback
(see `docs/architecture.md`) and each platform's code is written in its own
language. These scenarios are the single executable specification every
implementation must satisfy:

- iOS: `cd ios && swift test` (`ConformanceTests.swift`)
- Android: `./gradlew :react-native-anything-player:testDebugUnitTest` (`ConformanceTest.kt`)
- Web: `yarn test src/web` (`src/web/__tests__/conformance.test.ts`)

Every scenario runs against a fake monotonic clock and a recording driver, so
timing is exact and nothing sleeps.

## Format

Each file holds an array of scenarios:

```jsonc
{
  "name": "unique, human readable",
  "options": { "giveUpAfterMs": 60000 },   // optional EngineOptions overrides
  "steps": [ /* executed in order */ ]
}
```

### Steps

| Step | Meaning |
| --- | --- |
| `{"call": "load", "uri": "...", "live": true, "autoplay": true, "start": 12}` | `engine.load`. `live`/`autoplay`/`start` optional |
| `{"call": "play" \| "pause" \| "stop" \| "reset" \| "release"}` | commands |
| `{"call": "seek", "value": 30}` / `volume` / `muted` / `rate` | value commands |
| `{"call": "duck", "value": true}` | OS ducking |
| `{"call": "fadeTo", "value": 0.6, "ms": 200}` | `engine.fadeTo` (its completion counts in `fades`) |
| `{"call": "sleep", "after": 1000, "fadeOut": 200}` | `engine.sleep` (ms; `"after": null` cancels, `fadeOut` optional) |
| `"throws": "CODE"` on any call | the call must throw this error code |
| `{"focus": "granted" \| "delayed" \| "denied"}` | result of the next focus requests |
| `{"native": "ready", "duration": 120, "live": false, "seekable": true}` | item ready (`duration` omitted ⇒ unknown) |
| `{"native": "playing" \| "buffering" \| "ended"}` | native observations |
| `{"native": "failed", "code": "NETWORK_ERROR", "recoverable": true}` | failure |
| `{"native": "pausedExternally", "reason": "system"}` | the platform paused by itself |
| `"gen": 1` or `"gen": "prev"` on native steps | generation the event belongs to (default: current) |
| `{"driver": "flowing" \| "frozen" \| "trickle"}` | fake playhead: advances 1 s/s / stops / only the buffer grows (0.5 s/s) |
| `{"driver": "loaded", "value": 60}` | the whole file is buffered (to `value` s): the playhead advances 1 s/s, the buffer stays |
| `{"driver": "reentrant"}` | the fake driver reports ready/playing synchronously from inside `open`/`play` (as ExoPlayer can) |
| `{"driver": "position", "value": 42}` | set the fake playhead |
| `{"interruption": "began", "reason": "interruption", "resumable": true}` | system pause |
| `{"interruption": "ended", "shouldResume": true}` | system resume hint |
| `{"network": "online" \| "offline"}` / `{"network": "online", "handoff": true}` | connectivity |
| `{"route": "bluetooth", "name": "AirPods"}` | the local output changed (`routeChanged`; `name` optional) |
| `{"call": "handoff", "route": "cast", "name": "TV", "output": "cast:tv", "resume": true}` | the audio moves to another output (`handoff`) |
| `{"call": "load", …, "renditions": [{"uri": "…", "height": 480, "bitrate": 1200000, "audioOnly": false}]}` | separate files of one video (`height`, `bitrate`, `audioOnly` optional) |
| `{"call": "load", …, "refreshable": true, "expiresIn": 120000}` | a source the app can refresh; it expires this many ms from now |
| `{"call": "background"}` / `{"call": "foreground"}` | the app left / came back (`appBackgrounded`, `appForegrounded`) |
| `{"call": "selectQuality", "id": "r1"}` | pin a quality (`null`: automatic) |
| `{"call": "listenOnly", "value": true}` / `{"call": "loop", "value": true}` | listen-only, loop |
| `{"call": "seek", "value": 30, "exact": true}` | a frame-accurate seek |
| `{"call": "sourceRefreshed", "uri": "…"}` / `{"call": "sourceRefreshFailed"}` | the app's answer to a refresh request for the current load |
| `{"view": {"attached": true, "visible": true, "width": 0, "height": 0}}` | the view changed (`attached`, `visible` default `true`; pixels, 0 = unknown) |
| `{"pip": true}` | Picture in Picture started / stopped |
| `{"networkCost": {"metered": true, "saveData": false}}` | the network's cost |
| `{"native": "bandwidth", "bps": 800000}` | a bandwidth estimate |
| `{"native": "variants", "variants": [{"id": "v720", "height": 720, "bitrate": 2500000, "audioOnly": false}]}` | an adaptive source's qualities |
| `{"native": "videoInfo", "width": 1920, "height": 1080, "hdr": false, "variant": "v720"}` | the picture's facts |
| `{"native": "firstFrame"}` | the first frame was shown |
| `{"native": "tracks", "tracks": [{"id": "track:0", "kind": "audio", "language": "jpn", "default": true}]}` | the source's own tracks (`kind`: `audio`, `subtitles`, `captions`; `forced`, `default`, `sdh`, `describesVideo` optional) |
| `{"call": "appTracks", "tracks": […]}` | the app's subtitle files |
| `{"call": "selectAudioTrack", "id": "…"}` / `{"call": "selectTextTrack", "id": null}` | the app's pick (`null` audio: automatic; `null` text: off) |
| `{"call": "subtitleDelay", "value": 0.5}` | the subtitle delay |
| `{"system": {"languages": ["en-US"], "captions": false, "audioDescriptions": false}}` | the OS's languages and accessibility settings |
| `{"fullscreen": true}` | fullscreen started / ended |
| `{"native": "failed", …, "httpStatus": 403}` | a failure with the server's status |
| `{"platformReset": true}` | media services were reset |
| `{"advance": 1500}` | advance the clock, firing due wake-ups in order |
| `{"expect": {...}}` | assertions (below) |

`native: "playing"` also switches the fake playhead to `flowing`; `buffering`,
`failed` and `ended` switch it to `frozen`.

### Expectations

All keys optional. Recorded lists (`commands`, `loads`, `errors`) are compared
exactly and then cleared at every `expect`, so each expect sees only what
happened since the previous one.

| Key | Value |
| --- | --- |
| `state`, `playWhenReady`, `isLive`, `seekable`, `duration` | status fields |
| `interruption` | reason string or `null`; `interruptionResumable` bool |
| `error` | status error code or `null` |
| `reconnectAttempt` | attempt number or `null` |
| `commands` | driver calls, e.g. `["open(gen=2,start=-,play=true)", "pause"]` |
| `loads` | load settlements, e.g. `["1:ready", "2:superseded", "3:failed:TIMEOUT"]` |
| `errors` | emitted errors, e.g. `["NETWORK_ERROR:recoverable", "TIMEOUT:fatal"]` |
| `ended` | number of `ended` events since the previous expect |
| `wantsKeepalive`, `needsAudioFocus` | engine queries |
| `volume` | `status.volume` (the app's volume, never the faded one) |
| `sleepAt` | `status.sleepAt` minus the fake wall clock's base: the monotonic ms the timer fires at, or `null` |
| `sleeps`, `fades` | sleep timers fired / `fadeTo` calls settled since the previous expect |
| `orderedCommands` | ordered driver commands, each entry matched by string prefix at or after the previous match (subsequence): a fade-out that lands on a pause must send its last `volume(0.00)` before the `pause` |
| `route`, `routeName` | `status.route.kind` / `status.route.name` |
| `video` | `null`, or the listed fields of `status.video` (`width`, `height`, `hdr`, `firstFrame`, `audioOnly`, `pictureInPicture`, `quality`, `selectedQuality`, `audioTrack`, `textTrack`, `subtitleDelay`, `fullscreen`, and `qualities` and `tracks` as lists of ids) |
| `wantsMediaSession`, `wantsScreenAwake` | engine queries |
| `refreshes` | refresh requests since the previous expect, `loadId:reason` |
| `gen` | the current generation |
| `stats` | the listed fields of `engine.stats` (`startupMs`, `rebufferCount`, `rebufferMs`, `qualitySwitches`, `audioOnlySwitches`) |

Command formats: `open(gen=N,start=-|S.S,play=B)`, `play`, `pause`,
`seek(S.S)`, `release`, `unload`, `volume(V.VV)`, `rate(R.RR)`,
`switchOutput(ID)`; for video `open(…,r=N)` (a rendition), `open(…,swap)` (a
quality switch prepared behind the current item), `seek(S.S,exact)`,
`video(on|off)`, `quality(maxH=H|-,maxBps=B|-,pin=ID|-,audioOnly=B)`,
`loop(B)`, `cancelSwap(gen=N)`, `tracks(audio=ID|-,text=ID|-)`. The fake driver's playhead freezes on
`switchOutput`. A swap's `open` leaves the current playhead alone; the swap's
`playing` makes its start position the playhead.

## Event/status ordering invariant

Every scenario runs on a harness whose recorder holds the platform engine to
one rule independent of the steps: a discrete event (`ended`, `error`,
`sleep`) is never delivered before the status that implies it. `ended` needs
a state of `ended`, a fatal error an `error` state, and a `sleep` event a
status with `sleepAt` back to `null` — the timer always leaves the player
paused, so that status also has `playWhenReady` false (asserted on every
engine; a playing player is paused, a paused one stays paused). Breaches are
reported through the recorder's `violations` list, and every scenario fails
unless it is empty. Sequence details a single scenario can pin down beyond
this — such as the last fade-out volume command landing on the driver before
its pause — use the `orderedCommands` expectation above.

## Outputs (`route.json`)

`handoff(route, outputId, resume)` moves the audio to another output (a Cast
receiver, or back to the device): a loaded item is unloaded from the old output,
the driver switches (`switchOutput`), the volume is re-applied and, when the
item was active, it re-opens on the new output at the same position with
`play = resume && playWhenReady`. An inactive item (stopped, ended, failed, or
a paused stream whose connection was released) re-opens at the next `play()`.
While the route is `cast`, the device's rules are off: no audio focus, no
ducking, interruptions and media-services resets ignored, the phone's
connectivity does not reload the receiver, and the position-based silent-stall
check is off (a receiver's position is interpolated) — only the state the
receiver reports, and a stall longer than `STALL_MAX_MS`, drive recovery.

## Video, refresh, loop and stats (`video.json`)

`options.video` is `true` (every default) or a partial video policy
(`whenBackgrounded`, `ambient`, `keepAwake`, `focusWhenMuted`, `fallback`:
`true` or partial thresholds, `quality`: `maxHeight`, `maxBitrate`,
`cellularMaxHeight`, `cellularMaxBitrate`, `startQuality`, `followDataSaver`,
`capToView`). The rules, in short:

- **Background**: `pause` pauses (`background`, not resumable); `audio` turns
  the picture off and asks for audio only; `pip` keeps playing while Picture in
  Picture is up, and pauses `PIP_GRACE_MS` after the background (or after
  closing it in the background) otherwise. Cast and AirPlay play on.
- **Ambient**: never asks for focus or a media session; pauses off screen
  (`offscreen`) and in the background, both resumable, and resumes when shown.
- **No view**: `VIEW_DETACH_GRACE_MS` without a view sends `video(off)`.
- **Muted**: no focus and no media session unless `focusWhenMuted`; unmuting
  asks, and a refusal pauses.
- **Adaptive sources**: `quality(…)` after every open and on every change of
  the caps (cellular, data saver at 480, the view's height rounded up to a
  standard height, none in Picture in Picture), the pin, or audio only.
- **Renditions**: the engine picks (start: the lowest ≥ 480p without a
  bandwidth reading), steps down on a stall (to what fits 0.7 × the bandwidth,
  or one step after 2 stalls in 30 s), after 10 s under the current bitrate,
  and up after 30 s above 1.5 × the next one. A switch while playing opens the
  new file with `swap` under a new generation (generations come from one
  counter, so a cancelled switch's number is never reused); `playing` for it
  makes it current. A failure or `SWAP_TIMEOUT_MS` drops it (`cancelSwap`) and
  the file sits out `FAILED_RENDITION_MS`; a pause, a seek or a new open
  cancels it, and the heartbeat tries again. Paused or loading: a plain
  re-open. On a Cast receiver: a plain re-open.
- **Audio-only fallback**: below the lowest video quality, after 10 s under
  1.2 × its bitrate or 2 stalls in 30 s, with an audio-only variant or
  rendition; back after 30 s above 1.5 ×, or after 60 s without a stall when
  nothing measures the bandwidth.
- **Refresh**: a 401/403 on a refreshable source asks for a new one and waits
  `REFRESH_TIMEOUT_MS` (`reconnecting` while playback is wanted), then the
  backoff; `expiresIn` asks `REFRESH_AHEAD_MS` ahead without interrupting, and
  a later 401/403 uses the new source at once.
- **Loop**: an item that ends while looping restarts (`seek(0.0)`, `play`)
  without `ended`.
- **Tracks**: the source's tracks then the app's subtitle files; the
  automatic choice is `tracks/select.json`'s, the app's pick wins (a text pick
  of `null` stays off). The driver is told only about the source's own tracks
  (`tracks(…)`, an app file is `text=-`), once per item: again after every
  open and quality switch. A load clears the tracks, the picks and the delay.

## Subtitles and tracks (`subtitles/`, `tracks/`)

`subtitles/parse.json` (text → cues, TypeScript only: every platform parses
in JS), `subtitles/charset.json` (bytes → encoding), `subtitles/schedule.json`
(the cues showing at a position with a delay, and the next change) and
`tracks/select.json` (tracks and preferences → the starting audio and text
tracks) are run by `src/__tests__/subtitles.test.ts`, `SubtitleTest.kt` and
`SubtitleTests.swift`.

## DASH to HLS (`dash/`)

Each manifest (`<name>.mpd`) and the HLS playlists iOS makes of it
(`<name>.hls/`), compared by `DashToHlsTests.swift`; `RNAP_WRITE_GOLDEN=1`
rewrites them. Android plays DASH with ExoPlayer, the web with Shaka.

## Remux (`remux/`)

Matroska, WebM, MPEG-TS and M2TS files (`generate.sh` makes them with ffmpeg
and mkvmerge) and, in `<file>.out/`, what the remuxer makes of them: the
tracks (`tracks.json`), the subtitle cues (`cues.json`), the fragmented MP4
of the picture with the default sound (`main.mp4`) and of each other sound
(`audio-<id>.mp4`). The TypeScript twin writes them
(`RNAP_WRITE_GOLDEN=1 npx jest containerRemux`, which also checks that any
chunking gives the same bytes); `RemuxTests.swift` must match them byte for
byte, and `RemuxHlsTests.swift` checks that segments read on their own (from
a Cues entry, or a bitrate guess read again from earlier) hold exactly the
whole file's fragments.

## Fades and the sleep timer (`fades.json`)

`options` may set `fadeInMs` and `fadeOutMs`. The driver's volume is the
app's volume × duck × gain × sleep attenuation (0 when muted), sent as
`volume(V.VV)` only when it changed, every `FADE_TICK_MS` (50 ms) while a
fade moves, so a 200 ms fade records four volume commands. A fade-out keeps
the state `playing` with `playWhenReady` false until it lands, then pauses or
stops. Fades and `fadeTo` are instant on a Cast receiver, where the sleep
timer pauses without a fade-out. `sleepAt` counts in the engine's clock and
fires in `onWakeup`. When a fade-out lands on a pause, the last
`volume(0.00)` reaches the driver before the `pause`; scenarios that pin
this down use the `orderedCommands` expectation.

## Catalog search (`catalog/`)

`catalog/normalize.json` (`text` → `tokens`) and `catalog/search.json` (a
catalog and `request` → ranked `expect` ids, plus `emptyQuery`) specify the
voice catalog's matcher: `src/core/catalog.ts`, `ios/Core/CatalogSearch.swift`,
`android/.../core/CatalogSearch.kt`. The pipeline and scores are documented at
the top of `src/core/catalog.ts`.

The fake jitter source returns 0.5, so backoff delays are exactly
1000, 2000, 4000, 8000, 16000, 30000 ms.
