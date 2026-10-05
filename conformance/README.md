# Engine conformance suite

The playback engine exists twice — `ios/Core/PlaybackEngine.swift` and
`android/src/main/java/com/anythingplayer/core/PlaybackEngine.kt` — because
native code must own playback (see `docs/architecture.md`) and each platform's
native code is written in its own language. These scenarios are the single
executable specification both implementations must satisfy:

- iOS: `cd ios && swift test` (`ConformanceTests.swift`)
- Android: `./gradlew :react-native-anything-player:testDebugUnitTest` (`ConformanceTest.kt`)

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

Command formats: `open(gen=N,start=-|S.S,play=B)`, `play`, `pause`,
`seek(S.S)`, `release`, `unload`, `volume(V.VV)`, `rate(R.RR)`.

The fake jitter source returns 0.5, so backoff delays are exactly
1000, 2000, 4000, 8000, 16000, 30000 ms.
