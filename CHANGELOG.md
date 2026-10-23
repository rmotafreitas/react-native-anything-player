# Changelog

All notable changes to React Native Anything Player (RNAP) are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [Semantic Versioning](https://semver.org/): see
[Versioning and releases](docs/releases.md) for what counts as a breaking
change and how releases are made. Changes not released yet are listed in the
open release pull request.

## [1.2.0](https://github.com/rmotafreitas/react-native-anything-player/compare/v1.1.1...v1.2.0) (2026-10-23)

Short sounds, cars and watches, a sleep timer, and a CLI that sets up the optional parts. Everything is additive except one rule for catalog ids (see **Upgrading**).

### Added

- **Sound API** (`react-native-anything-player/sound`): short sounds for UI clicks and games, preloaded into memory and played with low latency. Several voices at once (the oldest is stolen when all are busy), per-play volume, rate, pan and loop, a handle per voice, and `stopAll()`. It mixes with other audio and has no media session. iOS on AVAudioEngine, Android on one shared SoundPool (32 voices), the web on Web Audio. Opt-in on iOS and Android with the Expo plugin's `sound` option (`rnapSound=true` / `RNAP_SOUND=1` without Expo); always available on the web. New error code `SOUND_UNAVAILABLE`. See [Sound](docs/sound.md).
- **Cars and watches.** Catalog items take a `group` (`"Jazz"`, `"Podcasts/Daily"`), and the catalog becomes a browse tree in CarPlay, Android Auto, Android Automotive OS and Wear OS, with "Recently played" and favorites (`setCatalog(items, { browse })`, `setFavorites(ids)`). A pick plays through the same path as a voice request and is reported as `searchPlay` with `request.origin: 'browse'`. Long folders are split for car screens, and `searchCatalog` / `playFromSearch` filter by group. CarPlay and Android Auto are opt-in with the plugin's `car` option (`rnapCar` / `RNAP_CAR` without Expo); Wear OS needs nothing. See [Cars & watches](docs/cars-and-watches.md).
- **Sleep timer and fades.** `player.sleep({ after, fadeOut })` pauses after a delay, fading out first; `sleep(null)` cancels it, `status.sleepAt` and a `sleep` event report it, and `useSleepTimer()` counts down. Opt-in fades on play, pause and stop (`new Player({ fade: { in, out } })`, `setFade()`), and `fadeTo(volume, seconds)`. The native engine runs them, so they keep working while JavaScript is frozen in the background. 25 new conformance scenarios, passed by all three engines. See [Playback](docs/playback.md#sleep-timer-and-fades).
- **CLI: modules, size, info, migrate.** `npx rnap` is the documented name. `rnap modules`, `rnap add` and `rnap remove` turn the optional parts on and off (HLS, Cast, Siri, Assistant, the iOS background mode, the Sound API, cars) by writing `gradle.properties`, `Podfile.properties.json` or the Expo plugin's options, after showing the diff. `rnap size` shows what each costs in a release APK and a web page. `rnap info` prints a report to paste into a bug report. `rnap migrate` rewrites react-native-track-player, expo-audio and expo-av code to RNAP where the mapping is mechanical, and marks the rest. A write is atomic and refused if the file changed after its diff was shown. `doctor` reports module settings that disagree. See [CLI](docs/cli.md).

### Changed

- **Web: less JavaScript on page load.** The hls.js glue loads when hls.js is registered (`configureHls`), and Google Cast's driver and Firefox's MP4 repackaging only when they are used: about 8 KB a page without them never loads. The Sound API is its own entry, so a page that only streams does not load it.
- The API reference has a `player` and a `sound` section; links to its old paths redirect.

### Upgrading

- **Catalog ids starting with `rnap:` are rejected** with `INVALID_ARGUMENT`, because the browse tree names its folders with that prefix. Rename such ids before upgrading. No other change is needed.

## [1.1.1](https://github.com/rmotafreitas/react-native-anything-player/compare/v1.1.0...v1.1.1) (2026-10-22)


### Fixed

* **android:** no crash when the network is reported as the runtime starts ([f23a5bb](https://github.com/rmotafreitas/react-native-anything-player/commit/f23a5bb981a9dc1816ea5d0f84b8339baab725be))
* **package:** ship only what apps use ([bcefa0f](https://github.com/rmotafreitas/react-native-anything-player/commit/bcefa0f8967fce8760d3bbd35e3272d4679a8d62))
* **package:** ship the Codegen specs and the autolinking config ([877047c](https://github.com/rmotafreitas/react-native-anything-player/commit/877047c86a4fe05ace640225d81915cbc8d4da74))


### Changed

* **android:** leave out of R8-shrunk apps what RNAP does not use ([5f98caf](https://github.com/rmotafreitas/react-native-anything-player/commit/5f98caf130e5e5cf05c9241a1cdf8b9d94e1ecac))
* **web:** load Google Cast and the MP4 repackaging only when used ([808f335](https://github.com/rmotafreitas/react-native-anything-player/commit/808f3350d43b805be613d9136ab75551aa3af959))

## [1.1.0] — 2026-10-22

The player leaves the phone: the same `Player` on the web (Expo web, React Native Web, React DOM, plain pages), on AirPlay and Google Cast receivers, and behind Siri, Google Assistant and Gemini. Every addition is backwards compatible.

### Added

- **Web.** The `Player` API on the web, in Expo web and React Native Web (picked by the bundler, nothing to configure) and in plain pages through `react-native-anything-player/web`, with no React or React Native dependency. The engine is a TypeScript twin of the Swift and Kotlin engines and passes the same conformance scenarios and ICY cases. Live streams are read with `fetch()` into Media Source Extensions: ICY metadata timed to when it is heard, connections closed on release, and a dropped connection that stayed up ≥ 3 s spliced in without stopping (reported as a `discontinuity`). Streams without CORS, or in codecs MSE cannot take, play on the `<audio>` element. Plus the Media Session (lock screen, media keys), a Web Audio visualizer, and recovery fed by connectivity, Network Information and page-visibility events.
- **Web: Firefox reads MP3 and AAC radio through MSE.** Firefox takes them only inside MP4 (`audio/mp4; codecs="mp3"` / `"mp4a.40.2"`), so RNAP wraps the frames in fragmented MP4 with a built-in muxer where the browser does not take the raw type. ICY titles, splices, the visualizer and `liveOffset` now work there as in Chromium and Safari.
- **Web: HLS with hls.js.** `configureHls(Hls)` (or a global `Hls`) registers the optional [hls.js](https://github.com/video-dev/hls.js); browsers without native HLS then play `.m3u8` sources through it, with ID3 titles as `metadata`, source headers, and recovery under the engine's backoff. Without it, HLS fails with `UNSUPPORTED_FORMAT` and a message that says what to install. A no-op on iOS and Android.
- **React without React Native.** `react-native-anything-player/react`: the `Player`, the hooks and `<button>` versions of `<RoutePicker />` / `<CastButton />` for react-dom apps (Vite, Next.js, Create React App); safe to import while rendering on a server. `react` and `react-native` are now optional peer dependencies, so a web-only app does not install React Native. `example-react/` (Vite) runs in the end-to-end suite.
- **Feature matrix** ([docs/features.md](docs/features.md)): what works where, across iOS, Android and the web entries.
- **Siri shortcuts (App Intents, iOS 16+).** "Play ⟨station⟩ in MyApp", Spotlight, the Shortcuts app and the Action button, on the same catalog, alongside the Siri media extension. The Expo plugin's `siri` option adds the template to the app (`{ "siri": { "appIntents": false } }` opts out); `RNAPVoice` is the native API behind it.
- **CLI.** `npx react-native-anything-player doctor` (`rnap doctor` once installed) checks the project setup, the native build and, with `--url`, stream URLs (cleartext rules, ICY, CORS for the web, Cast codecs); `init` applies the safe fixes, each shown as a diff and confirmed. No dependencies.
- **Migration guides** from react-native-track-player 4 and 5, expo-audio and expo-av.
- **Web: local files.** `player.load(file)` takes a `Blob` or `File` (RNAP makes the object URL and revokes it), and `blob:` and `data:` URLs are accepted. Native still rejects them with `INVALID_SOURCE`. New type `BlobInput`.
- `AUTOPLAY_BLOCKED` error code and `interruption.reason: 'autoplay-blocked'`: the browser refused audible playback without a user gesture.
- **Outputs.** `status.route` (`speaker`, `headphones`, `bluetooth`, `airplay`, `cast`, `car`, …, with the device's name) and a `routeChange` event on every platform. `<RoutePicker />` and `showRoutePicker()`: iOS's AirPlay button, Android's Output Switcher, AirPlay in Safari, Remote Playback in Chrome.
- **Google Cast**, opt-in with the plugin's `cast` option (`rnapCast` / `RNAP_CAST=1` without Expo; Chrome on the web): the engine hands the player on the lock screen to a Cast receiver at the same position and keeps its intent, recovers against the receiver with the usual policy, and brings it back paused when casting ends. Radio titles keep flowing from a metadata-only connection on the phone. `<CastButton />`, `showCastPicker()`, `stopCasting()`, `getCastStatus()`, `useCastStatus()`.
- **Voice assistants.** `setCatalog()` stores what the app can play on the device, so "Hey Siri / Hey Google, play X on MyApp" works even with the app closed (Siri through an Intents extension the plugin adds with `siri: true`; Google Assistant and Gemini through Media3's media library and `MEDIA_PLAY_FROM_SEARCH`). One search, specified by shared test cases, on iOS, Android and the web; `searchCatalog()`, `playFromSearch()`, `setSearchHandler()` and a `searchPlay` event.
- `PlayerOptions.id`: a player with an id outlives the JavaScript that created it, and `new Player({ id })` attaches to it (a player Siri started, or one that kept playing across a reload).
- Error codes `ROUTE_PICKER_UNAVAILABLE`, `CAST_UNAVAILABLE`, `CAST_UNSUPPORTED_SOURCE`.
- `NATIVE_MODULE_MISSING` error code: `new Player()` in Expo Go (or in a binary built before installing RNAP) throws it with the development-build steps, instead of the module lookup crashing on import.
- `example-web/`, a plain-web example, and `yarn test:web`: Playwright in Chromium, Firefox and WebKit against the test radio, including the integration scenarios on the Expo example's web export. The test radio sends CORS headers (`?noCors=1` omits them).
- An API reference on the docs site, generated by TypeDoc from the TSDoc on every public export. CI fails when an export, field or method has no doc comment.

### Changed

- The TurboModule is looked up with `TurboModuleRegistry.get`, so importing the package never throws; a missing module is reported when a player is created.
- `react` and `react-native` are optional peer dependencies: a web-only app (React DOM, plain pages) does not install React Native.
- The engine conformance suite grew from 59 to 80 scenarios (output handoffs), run against three engines (Swift, Kotlin, TypeScript), plus 51 catalog-search cases.

## [1.0.0] — 2026-10-20

The first stable release: the version the [Rádio Animu](https://www.animu.moe) app shipped in its v4.0.1 (October 21, 2026), after running it in production. Earlier development versions (named `react-native-airwave`) are not listed.

### Upgrading from react-native-airwave

The package was renamed to React Native Anything Player (RNAP). Update these names:

| Before | After |
|---|---|
| npm package `react-native-airwave` | `react-native-anything-player` |
| Expo plugin `"react-native-airwave"` | `"react-native-anything-player"` |
| CocoaPod `Airwave` | `AnythingPlayer` (run `pod install`) |
| Android namespace `com.radioanimu.airwave` | `com.anythingplayer` |
| Manifest meta-data `com.radioanimu.airwave.FOREGROUND_TIMEOUT_MS` | `com.anythingplayer.FOREGROUND_TIMEOUT_MS` |
| Gradle `airwaveHls`, `airwaveMedia3Version` | `rnapHls`, `rnapMedia3Version` |
| iOS log subsystem `com.radioanimu.airwave` | `com.anythingplayer` |
| logcat tag `Airwave` | `RNAP` |

The JavaScript API (`Player`, hooks, events, errors) is unchanged.

### Added

- `Player` with `load` / `play` / `pause` / `toggle` / `stop` / `reset` / `seekTo` / `setVolume` / `setMuted` / `setRate` / `updateNowPlaying` / `release`, sequence-numbered status snapshots, synchronous `getProgress()`, and typed events (`status`, `stateChange`, `metadata`, `error`, `ended`, `remoteCommand`, `diagnostic`).
- React hooks: `usePlayerStatus`, `usePlaybackState`, `useProgress`, `useStreamMetadata`, `usePlayerEvent`.
- Native playback engine (Swift and Kotlin twins, one shared conformance suite): play-intent state machine, generation-based stale-event rejection, stall / silent-stall / dead-socket detection, jittered backoff, offline probing, network-handoff awareness, live-edge drift policy, paused-stream connection release, give-up limit.
- iOS: AVPlayer driver; app-owned HTTP connections through an in-process loopback proxy (deterministic connection teardown, late requests refused, parallel AVFoundation requests coalesced onto one connection, dropped live connections spliced into the same response with ICY re-framing); audio-session coordinator (interruptions, route loss, media-services reset); Now Playing and remote commands; background keepalive during recovery.
- Android: ExoPlayer (Media3 1.11.1) driver with gapless live continuations; HTTP through Media3's OkHttp data source, with every call cancelled when its item is torn down (dead sockets close at once, no pooled idle connections); Media3 session service with an engine-backed session player; app-wide audio-focus coordinator (incl. Android 15 background rules); network monitor; recovery wake/Wi-Fi locks.
- ICY metadata normalization shared by both platforms (UTF-8 / Windows-1252, mojibake repair, robust field parsing, configurable title format).
- Normalized `PlayerError` codes preserving native error chains.
- Expo config plugin.
- Example apps (bare React Native and Expo), a controllable ICY test server, on-device integration scenarios, and a soak monitor.
- `player.setAudioSampling()` and the `audioSample` event: decoded-audio windows for visualizers. Android: an ExoPlayer audio-sink tap. iOS: an audio tap for files, and for live streams a parallel AudioToolbox decode of the proxied bytes, released against the item's clock.
- `updateNowPlaying({ duration, elapsed })`: song progress on the lock screen / notification for live streams, advanced natively only while audio plays.
- `updateNowPlaying({ live })`: turns the lock screen / notification "live" badge off (or on) regardless of the stream, for a radio between songs.
- The `discontinuity` event: a live stream's audio jumped because playback moved onto a fresh connection of the same source with no state change (Android: a queued continuation or a reload from a new connection; iOS: a spliced upstream). A new Icecast / Shoutcast connection replays the server's burst of recent audio. Reported when the jump becomes audible (once the new connection's audio plays, also after an outage longer than the buffer), with the progress snapshot already on the new connection; on iOS it needs `progressInterval`.
- `progressInterval` option and the `progress` event: readings from a native timer while playing, which also run JS where the app's timers are frozen (Android background).
- System controls answer as soon as a player with a media session exists, even with nothing loaded. A `play` / `togglePlayPause` that finds nothing loaded is forwarded to JS as `remoteCommand`, so an app iOS relaunched from Control Center can load its source and play.

### Fixed

- iOS: `liveOffset` for live HTTP streams, measured from the audio the stream proxy has handed AVPlayer. `bufferedAhead` alone under-read the delay right after connecting (it covers what AVPlayer has parsed, not the whole connect burst): 11.6 s instead of the 17 s actually heard on a 64 kbps AAC+ station, so anything placed on the station's timeline at tune-in ran 5 s ahead.
- iOS: play stuck in loading after a long paused suspension. iOS reclaims a suspended app's sockets, and the stream proxy kept handing AVPlayer its dead listener: every open timed out and reconnected to the same dead port. The listener is now health-checked (a request through it, ~1 ms) before every open and on return to the foreground. A dead one is replaced, on the same port when possible.
- iOS: the audio session is activated on every play. The system deactivates a suspended app's session (`.appWasSuspended`, or silently), and the cached "active" flag skipped re-activation.
- Android: local (`file://`) artwork is now published as image bytes. The system media controls load an artwork URI themselves, cross-process, and could not open the app's private file (`ENOENT`), so the cover was missing.

[1.1.0]: https://github.com/rmotafreitas/react-native-anything-player/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/rmotafreitas/react-native-anything-player/releases/tag/v1.0.0
