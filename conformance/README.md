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
| `"throws": "CODE"` on any call | the call must throw this error code |
| `{"focus": "granted" \| "delayed" \| "denied"}` | result of the next focus requests |
| `{"native": "ready", "duration": 120, "live": false, "seekable": true}` | item ready (`duration` omitted ⇒ unknown) |
| `{"native": "playing" \| "buffering" \| "ended"}` | native observations |
| `{"native": "failed", "code": "NETWORK_ERROR", "recoverable": true}` | failure |
| `{"native": "pausedExternally", "reason": "system"}` | the platform paused by itself |
| `"gen": 1` or `"gen": "prev"` on native steps | generation the event belongs to (default: current) |
| `{"driver": "flowing" \| "frozen" \| "trickle"}` | fake playhead: advances 1 s/s / stops / only the buffer grows (0.5 s/s) |
| `{"driver": "reentrant"}` | the fake driver reports ready/playing synchronously from inside `open`/`play` (as ExoPlayer can) |
| `{"driver": "position", "value": 42}` | set the fake playhead |
| `{"interruption": "began", "reason": "interruption", "resumable": true}` | system pause |
| `{"interruption": "ended", "shouldResume": true}` | system resume hint |
| `{"network": "online" \| "offline"}` / `{"network": "online", "handoff": true}` | connectivity |
| `{"route": "bluetooth", "name": "AirPods"}` | the local output changed (`routeChanged`; `name` optional) |
| `{"call": "handoff", "route": "cast", "name": "TV", "output": "cast:tv", "resume": true}` | the audio moves to another output (`handoff`) |
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
| `route`, `routeName` | `status.route.kind` / `status.route.name` |

Command formats: `open(gen=N,start=-|S.S,play=B)`, `play`, `pause`,
`seek(S.S)`, `release`, `unload`, `volume(V.VV)`, `rate(R.RR)`,
`switchOutput(ID)`. The fake driver's playhead freezes on `switchOutput`.

## Outputs (`route.json`)

`handoff(route, outputId, resume)` moves the audio to another output (a Cast
receiver, or back to the device): the item is unloaded from the old output,
the driver switches (`switchOutput`), the volume is re-applied and, when the
item was active, it re-opens on the new output at the same position with
`play = resume && playWhenReady`. An inactive item (stopped, ended, failed, or
a paused stream whose connection was released) re-opens at the next `play()`.
While the route is `cast`, the device's rules are off: no audio focus, no
ducking, interruptions and media-services resets ignored, the phone's
connectivity does not reload the receiver, and the position-based silent-stall
check is off (a receiver's position is interpolated) — only the state the
receiver reports, and a stall longer than `STALL_MAX_MS`, drive recovery.

## Catalog search (`catalog/`)

`catalog/normalize.json` (`text` → `tokens`) and `catalog/search.json` (a
catalog and `request` → ranked `expect` ids, plus `emptyQuery`) specify the
voice catalog's matcher: `src/core/catalog.ts`, `ios/Core/CatalogSearch.swift`,
`android/.../core/CatalogSearch.kt`. The pipeline and scores are documented at
the top of `src/core/catalog.ts`.

The fake jitter source returns 0.5, so backoff delays are exactly
1000, 2000, 4000, 8000, 16000, 30000 ms.
