# Testing

RNAP is tested at six layers. Everything below runs locally; the device layers need the iOS simulator / Android emulator (or devices) and the test stream server.

| Layer | What | Command |
|---|---|---|
| Engine conformance (iOS) | the Swift engine against the shared scenarios + ICY cases + catalog search cases + ICY de-interleave / re-frame / splice fuzzing | `yarn test:ios` (`cd ios && swift test`; the core also runs on Linux in the `swift` Docker image) |
| Engine conformance (Android) | the Kotlin engine against the same scenarios + ICY and catalog cases; the platform layer's pure parts (catalog store, intents, routes, the Cast receiver mapping), and the browse tree of cars and watches | `yarn test:android` |
| Engine conformance (web) and JS | the TypeScript engine against the same scenarios + ICY cases; `Player`, hooks, errors, source validation against a fake native module; the browser layer against a scripted fake browser; the React DOM entry, including server rendering (coverage threshold enforced) | `yarn test --coverage` |
| Web end-to-end | the browser engine in Chromium, Firefox and WebKit against the controllable server, including the integration scenarios below on Expo web | `yarn test:web` |
| On-device integration | the real native player in the example apps against the controllable server | see below |
| System & soak | background, lock screen, media keys, focus, Doze, connectivity; long-running memory/connection sampling | see below |

## Engine conformance

`conformance/*.json` is the executable specification of the engine: 127 scenarios driven by a fake clock and a recording driver — command races (`load` A/B/C, play/pause storms), stale events, stalls (native, silent, trickling, sub-debounce, recovering on their own), dead sockets, open timeouts with and without play intent, late callbacks after a stop, offline probing, restore and handoff edges, backoff and its reset, give-up, live drift, paused-stream release, interruptions and focus results, media-services reset, and re-entrant driver callbacks, output handoffs to and from a Cast receiver with the rules that hold while casting, and fades and the sleep timer. The Swift, Kotlin and TypeScript engines must produce exactly the same driver commands, states and events. A recorder-level invariant also checks that `ended`/`error` are never delivered before the status that implies them. `conformance/metadata/icy.json` holds the ICY normalization cases (charsets, quoting, malformed blocks, splitting), and `conformance/catalog/` the voice catalog's text normalization and search ranking (accents, Turkish i, final sigma, ß, CJK, typos, filler words, structured requests). See [conformance/README.md](../conformance/README.md) for the format.

## On-device integration scenarios

The example apps contain `example/src/scenarios.ts`: scenarios that run the real native player against `scripts/stream-server/server.mjs` and assert behaviour, including the server's own connection counts.

```sh
scripts/stream-server/generate-media.sh       # once (ffmpeg)
node scripts/stream-server/server.mjs          # port 8765

# iOS simulator (launch argument, no URL prompt):
xcrun simctl launch booted anythingplayer.example -RNAPTest all
# Android emulator:
adb shell am start -S -W -f 0x10008000 -a android.intent.action.VIEW -d "anythingplayer-example://test/all" anythingplayer.example
# results:
xcrun simctl spawn booted log stream --predicate 'category == "javascript"' | grep RNAPTest
adb logcat ReactNativeJS:V '*:S' | grep RNAPTest
```

Run one platform at a time: the connection-count assertions read a server shared by both.

The Expo example (`example-expo/`, bundle id `anythingplayer.expo.example`) runs the same scenarios against the package installed from its npm tarball, exactly as a consumer would. Sync it with `scripts/sync-expo-example.sh`, then `npx expo prebuild` and build. Its local config plugins give it the same cleartext policy as the bare example and adopt the iOS 27 scene life cycle.

| Scenario | Asserts |
|---|---|
| `local-file` | bundled asset: ready, duration, seekable, progress advances, seek lands, `ended` after the status, replay restarts |
| `icy-metadata` | live detection, `NOT_SEEKABLE`, ≥ 2 metadata changes, raw fields kept |
| `icy-latin1-malformed` | Latin-1 titles decoded, corrupted blocks never break playback |
| `race-load` | `load` A/B/C without awaiting: C plays, exactly **one** connection remains |
| `race-play-pause` | 10 interleaved play/pause: last wins, settles, one connection |
| `stale-slow-load` | a slow first open (server delays 4 s) never disturbs the second source; it is abandoned |
| `http-404` | `SOURCE_NOT_FOUND`, not recoverable, stays in `error` |
| `cleartext-blocked` | cleartext HTTP to a host the app does not allow (ATS / network-security config): `INVALID_SOURCE`, not recoverable (native only: a web page follows the browser's mixed-content rules) |
| `server-outage-recovers` | server refuses connections: `reconnecting` with growing attempts, recovers when it returns |
| `reconnect-drop` | server drops every 5 s for 20 s: audio keeps coming back over exactly one connection (iOS: spliced inside the response, state stays `playing`; Android: gapless continuation) |
| `flapping-server-no-storm` | server accepts and closes every 0.3 s: bounded connection rate |
| `stall-recovers` | a socket that goes silent forever is replaced, audio returns, and the dead socket is closed within 2 s (it used to linger until Android's 10 s read timeout) |
| `pause-releases-connection` | a paused live stream closes its connection (~30 s), resume re-opens |
| `song-progress` | `updateNowPlaying({ duration, elapsed })` on a live stream (inspected: iOS Now Playing log, Android `dumpsys media_session`: advances while playing, frozen while paused, not seekable) |
| `audio-sampling` | sampling enabled mid-stream: ≥ 20 windows in 3 s at the requested size, carrying audio, none after disabling |
| `progress-events` | `progressInterval: 250` on a live stream: ≥ 6 readings in 2 s, each fresh, finite `bufferedAhead`, none while paused |
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

Shrunk with R8, as a store build ships (`./gradlew assembleRelease -Pr8=true`: minify, resource shrinking, the optimizing rules), the bare example passes all 23 scenarios on the Android 16 emulator. That run checks RNAP's keep rules, the audio-only renderers and the autolinking setup that leaves out the iOS-only component's C++.

On the web, the Expo example's export (React Native Web, Chromium) passes all 23 scenarios of this release, `cleartext-blocked` skipped as native-only; `yarn test:web` runs them on every change.

Debug builds of the bare example passed the 16 scenarios that existed before the iOS stream proxy (`cleartext-blocked` and `bench-sync-reads` were added with it).

## Web end-to-end

`yarn test:web` builds the library, the Expo example's web export (`scripts/build-expo-web.sh`) and the React example (`example-react/`, Vite), starts the test radio, and runs Playwright (`e2e/`) in Chromium, Firefox and WebKit:

- the plain-web example (`example-web/`, served from its own origin so the radio is cross-origin): ICY over MSE with titles timed to the audio and the Media Session, the plain `<audio>` fallback without CORS, file seeking, a dropped connection spliced without a state change (one connection on the server), recovery from an outage, the Web Audio visualizer, and the autoplay policy (`AUTOPLAY_BLOCKED`, then playback from a tap);
- outputs and Cast (`e2e/cast.spec.ts`): a scripted Cast SDK whose receiver fetches from the test radio, so the handoff, the titles-only connection and the return to the device are counted server-side; the output picker's availability; `playFromSearch` from a search box and from speech;
- the React example (`example-react/`, react-dom and Vite, no React Native): hooks rendering the player's state, pause, and a search result;
- the Expo example's integration scenarios on React Native Web (Chromium).

Firefox's MSE does not take raw MP3 or AAC, so RNAP repackages the frames as fragmented MP4 there; a test forces that path in all three browsers. HLS runs through native HLS where a browser has it and through hls.js elsewhere, against the test radio's `/hls/` playlists. CI needs `ffmpeg` for the test media, and an audio output: on a machine with no sound device (a CI runner), Firefox never starts playback, so CI runs a PulseAudio null sink.

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

**Not verified (no physical devices available):** real phone calls, Siri, Bluetooth/AirPods/CarPlay/Android Auto hardware (CarPlay's Swift is compiled by CI only), wired-headset unplug, AirPlay, Google Cast receivers, cellular handoff on a real radio, Now Playing on an Apple Watch and media controls on Wear OS. Hardware checklist for outputs and voice:

- AirPlay: pick a receiver from `<RoutePicker />` while a stream plays (`status.route.kind === 'airplay'`); lock the phone; pick the phone again.
- Google Cast (Android, iOS, Chrome): cast a playing radio stream and a file mid-way; check position, titles (from the phone), lock-screen controls, volume, a receiver-side stop, Wi-Fi loss on the phone only, and stopping from the phone (returns paused).
- Siri: "play ⟨station⟩ on ⟨app⟩" with the app in the foreground, backgrounded and force-quit; "play something on ⟨app⟩"; a name only the search handler knows. Check first that iOS delivers the extension's "handle in app" to `application(_:handle:completionHandler:)` on the iOS versions you support: Apple documents that path for media intents but lists the delegate method as iOS 11–14, and developers have reported it not being called on some versions.
- Siri shortcuts (App Intents, iOS 16+), after a `setCatalog` and one launch: "Play ⟨item⟩ in ⟨app⟩" and "Play ⟨app⟩" with the app in the foreground, backgrounded and force-quit (`searchPlay` with `origin: 'siri'`); a new item's phrase after a second `setCatalog`; the shortcuts in Spotlight and in the Shortcuts app (the *Play* action's picker searches the catalog); one on the Action button (iPhone 15 Pro and later); and which path answers "play ⟨item⟩ on ⟨app⟩" when the extension is installed too. CI only compiles the template (`build-ios` builds it into the bare example, with the Intents extension as an embedded target); Siri's phrase recognition, Spotlight and the Action button need a device.
- Google Assistant and Gemini: the same requests, on a phone where each is the default assistant; and `adb shell am start -a android.media.action.MEDIA_PLAY_FROM_SEARCH -e query "⟨station⟩" ⟨package⟩`.

The code paths are covered by the conformance scenarios (interruptions, focus, output-disconnect, handoff) and follow the platform APIs. They are exercised on hardware as devices become available; the [roadmap](roadmap.md#hardware-verification) tracks what is left.


## Browse tree

The browse tree of cars and watches (`docs/cars-and-watches.md`) is checked in three layers:

- `BrowseTreeTest` (`yarn test:android`) and `BrowseTreeTests` (`swift test`) build trees from `conformance/catalog/browse.json` and compare ids, titles, order, tab overflow, slices of long folders, reserved ids, styles and folder artwork; `catalog.test.ts` runs the group helpers and the group-filtered search from the same file.
- `BrowseTreeLibraryTest` is an instrumented test: it writes a grouped catalog, connects to `AnythingPlayerPlaybackService` the way Android Auto and Wear OS do (a media client), lists the root and the folders, reads the content-style hints, lists a 250-item folder whole and by pages, plays an item by its id and finds it in "Recently played". Run it on its own (the catalog is read once per process), with the stream files on the host:

```sh
python3 -m http.server 18765   # serving jazz.wav and news.wav
cd example/android && ./gradlew :app:connectedDebugAndroidTest \
  -Pandroid.testInstrumentationRunnerArguments.class=anythingplayer.example.BrowseTreeLibraryTest
```

- The `catalog-groups` scenario checks `setCatalog` with groups, `setFavorites` and the group filter from JavaScript, natively and on the web.

Checked on the Android 16 emulator: the 104 Kotlin unit tests pass; `BrowseTreeLibraryTest` passes 4 of 4 (a root of Favorites, Podcasts, Music, Zoo and More in that order; Music holding the Jazz subfolder before its own item; grid hint on the station folders and list hint on the podcast folder; a 250-item folder whole, and page 0 and page 2 of 100 when asked; `playFromMediaId` starts the item and "Recently played" then opens the root); `VoiceLibraryTest` still passes 4 of 4. The R8-shrunk release build of the bare example (`-Pr8=true`, with `rnapCar=true`) passes all 24 scenarios, `catalog-groups` included. The merged manifest has the Android Auto meta-data with `rnapCar=true` (alone, or with `rnapCast=true`) and none without it.

It cannot be a real car: the instrumented client is not Android Auto, so the car-only rules (folders only at the root, four tabs, folders cut into slices of 100) are held by the unit tests. A head unit, CarPlay, Android Automotive OS and a watch are on the hardware list below.

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

Android memory, investigated: the Java heap stayed flat (9–10 MB). The growth was in anonymous memory, where Hermes keeps its heap segments, and native heap. A follow-up 20-minute run logged Hermes' own statistics (`[RNAPMem]` lines from the example app). Live JS memory after each old-generation collection stayed at 4–6 MB (a sawtooth, no upward trend); the heap reservation plateaued at 25–29 MB and native allocations at ~40 MB. No leak was found. The rise is the JS heap growing to its steady-state size.

After the Android HTTP layer moved to OkHttp (see `stall-recovers`), a further 20-minute Android soak on the same station stayed `PLAYING` with at most one connection; PSS grew at the same rate as before (Hermes heap growth) and the native heap was lower (18.8 MB).

Two behaviours explain fewer connections than drops. Both are expected and bounded:

- each connection delivers the server's 2 s burst, so buffers grow. AVPlayer then pauses downloading on its own (closes its connection and re-requests later; the proxy opens a fresh upstream at the live edge). Android defers the next continuation while two items are already queued.
- JS timers do not run while an Android app is in the background, which is why every timer that matters for playback is native. The soak played through that.
