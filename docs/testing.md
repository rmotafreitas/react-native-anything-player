# Testing

Airwave is tested at five layers. Everything below runs locally; the device layers need the iOS simulator / Android emulator (or devices) and the test stream server.

| Layer | What | Command |
|---|---|---|
| Engine conformance (iOS) | the Swift engine against the shared scenarios + ICY cases + ICY de-interleave / re-frame / splice fuzzing | `yarn test:ios` (`cd ios && swift test`) |
| Engine conformance (Android) | the Kotlin engine against the same scenarios + ICY cases | `yarn test:android` |
| JS | `Player`, hooks, errors, source validation, against a fake native module (coverage threshold enforced) | `yarn test --coverage` |
| On-device integration | the real native player in the example apps against the controllable server | see below |
| System & soak | background, lock screen, media keys, focus, Doze, connectivity; long-running memory/connection sampling | see below |

## Engine conformance

`conformance/*.json` is the executable specification of the engine: 59 scenarios driven by a fake clock and a recording driver — command races (`load` A/B/C, play/pause storms), stale events, stalls (native, silent, trickling, sub-debounce), dead sockets, offline probing, restore and handoff edges, backoff and its reset, give-up, live drift, paused-stream release, interruptions and focus results, media-services reset, and re-entrant driver callbacks. Both engines must produce exactly the same driver commands, states and events. A recorder-level invariant also checks that `ended`/`error` are never delivered before the status that implies them. `conformance/metadata/icy.json` holds the ICY normalization cases (charsets, quoting, malformed blocks, splitting). See [conformance/README.md](../conformance/README.md) for the format.

## On-device integration scenarios

The example apps contain `example/src/scenarios.ts`: scenarios that run the real native player against `scripts/stream-server/server.mjs` and assert behaviour, including the server's own connection counts.

```sh
scripts/stream-server/generate-media.sh       # once (ffmpeg)
node scripts/stream-server/server.mjs          # port 8765

# iOS simulator (launch argument, no URL prompt):
xcrun simctl launch booted airwave.example -AirwaveTest all
# Android emulator:
adb shell am start -S -W -f 0x10008000 -a android.intent.action.VIEW -d "airwave-example://test/all" airwave.example
# results:
xcrun simctl spawn booted log stream --predicate 'category == "javascript"' | grep AirwaveTest
adb logcat ReactNativeJS:V '*:S' | grep AirwaveTest
```

Run one platform at a time: the connection-count assertions read a server shared by both.

The Expo example (`example-expo/`, bundle id `airwave.expo.example`) runs the same scenarios against the package installed from its npm tarball, exactly as a consumer would. Sync it with `scripts/sync-expo-example.sh`, then `npx expo prebuild` and build. Its local config plugins give it the same cleartext policy as the bare example and adopt the iOS 27 scene life cycle.

| Scenario | Asserts |
|---|---|
| `local-file` | bundled asset: ready, duration, seekable, progress advances, seek lands, `ended` after the status, replay restarts |
| `icy-metadata` | live detection, `NOT_SEEKABLE`, ≥ 2 metadata changes, raw fields kept |
| `icy-latin1-malformed` | Latin-1 titles decoded, corrupted blocks never break playback |
| `race-load` | `load` A/B/C without awaiting: C plays, exactly **one** connection remains |
| `race-play-pause` | 10 interleaved play/pause: last wins, settles, one connection |
| `stale-slow-load` | a slow first open (server delays 4 s) never disturbs the second source; it is abandoned |
| `http-404` | `SOURCE_NOT_FOUND`, not recoverable, stays in `error` |
| `cleartext-blocked` | cleartext HTTP to a host the app does not allow (ATS / network-security config): `INVALID_SOURCE`, not recoverable |
| `server-outage-recovers` | server refuses connections: `reconnecting` with growing attempts, recovers when it returns |
| `reconnect-drop` | server drops every 5 s for 20 s: audio keeps coming back over exactly one connection (iOS: spliced inside the response, state stays `playing`; Android: gapless continuation) |
| `flapping-server-no-storm` | server accepts and closes every 0.3 s: bounded connection rate |
| `stall-recovers` | a socket that goes silent forever is replaced, audio returns, and the dead socket is closed within 2 s (it used to linger until Android's 10 s read timeout) |
| `pause-releases-connection` | a paused live stream closes its connection (~30 s), resume re-opens |
| `song-progress` | `updateNowPlaying({ duration, elapsed })` on a live stream (inspected: iOS Now Playing log, Android `dumpsys media_session`: advances while playing, frozen while paused, not seekable) |
| `audio-sampling` | sampling enabled mid-stream: ≥ 20 windows in 3 s at the requested size, carrying audio, none after disabling |
| `bench-sync-reads` | cost of the synchronous JSI reads (`getProgress()`, `refresh()`) while a stream plays; `getProgress` p50 < 100 µs, p99 < 5 ms |
| `release-frees-resources` | `release()` closes the connection, rejects later commands, clears listeners |
| `invalid-sources` | empty / unsupported URIs, `NO_SOURCE`, non-finite arguments |
| `probe-stop-closes`, `probe-release-closes` | time from `stop()` / `release()` to the server seeing the socket closed |

### Results (this release)

Release builds, iOS 27 simulator and Android 16 emulator:

| | iOS | Android |
|---|---|---|
| Bare example, 20 scenarios (incl. `song-progress`, `audio-sampling`) | 20 / 20 | 20 / 20 |
| Expo example (package installed from its tarball), the 18 scenarios before those two | 18 / 18 | 18 / 18 |
| Connection closed after `stop()` / `release()` | 7–32 ms | 34–51 ms |
| `getProgress()` p50 / p99 | 5–10 µs / 22–28 µs | 11–20 µs / 270–600 µs |
| `refresh()` (status + metadata) p50 | 20–23 µs | 92–100 µs |

Debug builds of the bare example passed the 16 scenarios that existed before the iOS stream proxy (`cleartext-blocked` and `bench-sync-reads` were added with it).

## System behaviour (manual, scripted with adb / simctl)

Verified on the Android 16 emulator:

- background playback with the app backgrounded; foreground service of type `mediaPlayback`, media notification (category transport), session `PLAYING` with ICY title/artist/station;
- hardware media keys (`MEDIA_PAUSE`, `MEDIA_PLAY`, `HEADSETHOOK`) from the background, routed through the engine (a resume after > 5 s re-opens at the live edge);
- 90 s of forced deep Doze with the screen off: still playing, same single connection, no state change;
- Wi-Fi and mobile data off for 30 s: buffer plays out, stall confirmed, offline probes, immediate re-open and playback 0.6 s after connectivity returns;
- another app (YouTube Music) taking transient audio focus: paused with `audio-focus-loss-transient`; when it stops, automatic resume (re-opened at the live edge);
- resume from the background after the paused session left the foreground.

Verified on the iOS 27 simulator:

- background playback (app backgrounded behind Settings/Safari) with ICY metadata continuing;
- Now Playing publications (title/artist from ICY, live flag, rate, artwork attached asynchronously), read from the unified log;
- five JS reloads while playing: no crash, old players released (a crash on reload was found and fixed here — events emitted into a torn-down TurboModule).

**Not verified (no physical devices available):** real phone calls, Siri, Bluetooth/AirPods/CarPlay/Android Auto hardware, wired-headset unplug, AirPlay, cellular handoff on a real radio. The code paths are covered by the conformance scenarios (interruptions, focus, output-disconnect, handoff) and follow the platform APIs, but they should be exercised on hardware before a 1.0.

## Soak

`scripts/soak/monitor.sh <minutes> <csv>` samples, once a minute, Android PSS, the iOS simulator process RSS and thread count, the session state and the server's connection counts while both example apps stream.

### Soak results

45 minutes, Release builds, both bare example apps in the background, playing the test station that **drops the connection every 15 s** (so the whole run exercises recovery: iOS proxy splicing, Android gapless continuations):

| | iOS 27 simulator | Android 16 emulator |
|---|---|---|
| Playback | playing throughout (sampled every minute); still playing at 87 min, ~350 splices | `PLAYING` throughout |
| Connections | never more than one per app (server-side count, every sample); 262 connections for both apps over 45 min, against 360 server drops | |
| Memory | RSS 240 → 119 MB (trimmed when backgrounded), 82 MB at 87 min | PSS 79 → 103 MB, see below |
| Threads | 11–16, no growth | |

Android memory, investigated: the Java heap stayed flat (9–10 MB). The growth was in anonymous memory, where Hermes keeps its heap segments, and native heap. A follow-up 20-minute run logged Hermes' own statistics (`[AirwaveMem]` lines from the example app). Live JS memory after each old-generation collection stayed at 4–6 MB (a sawtooth, no upward trend); the heap reservation plateaued at 25–29 MB and native allocations at ~40 MB. No leak was found. The rise is the JS heap growing to its steady-state size.

After the Android HTTP layer moved to OkHttp (see `stall-recovers`), a further 20-minute Android soak on the same station stayed `PLAYING` with at most one connection; PSS grew at the same rate as before (Hermes heap growth) and the native heap was lower (18.8 MB).

Two behaviours explain fewer connections than drops. Both are expected and bounded:

- each connection delivers the server's 2 s burst, so buffers grow. AVPlayer then pauses downloading on its own (closes its connection and re-requests later; the proxy opens a fresh upstream at the live edge). Android defers the next continuation while two items are already queued.
- JS timers do not run while an Android app is in the background, which is why every timer that matters for playback is native. The soak played through that.
