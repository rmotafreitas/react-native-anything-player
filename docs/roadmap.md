# Roadmap: what RNAP needs to be the default

RNAP's goal is to be the audio library React Native developers pick first: **lightweight, bulletproof, best DX**. This page records where it stands against the alternatives as of October 2026 ([comparison](comparison.md)) and what closes each gap, in priority order.

## Where RNAP already wins

- **Bulletproof streaming.** It is the only library that recovers a stream on its own: dead-socket and silent-stall detection, backoff, offline probing, Wi-Fi ↔ cellular handoff, and live-edge re-open. All of it is native, so it keeps working while JS is frozen. RNTP 5, RNTP 4 and expo-audio leave every one of these to app code ([matrix](comparison.md#what-you-get-out-of-the-box)).
- **Correctness under races.** Generations, sequence-numbered snapshots and ordered events, checked by 80 shared conformance scenarios run against all three engines (Swift, Kotlin, TypeScript).
- **Radio.** ICY metadata timed to when it is *heard*, charset repair, one connection per stream, paused-stream release, song progress on the lock screen, and a visualizer for iOS live streams (no one else has one).
- **Everywhere.** One engine and one API on iOS, Android, Expo web, React Native Web, React (Vite, Next.js) and plain web pages, with AirPlay, Google Cast and the voice assistants ([feature matrix](features.md)).
- **Lean.** Media3 and MediaRouter on Android (Google Cast only when opted in), no framework requirement, zero runtime JS dependencies.

## Gaps, in priority order

### P0 — adoption blockers

| Gap | Why it matters | Proposal |
|---|---|---|
| **Licence** | RNTP 5 went commercial (€99/month per app). RNAP's PolyForm Noncommercial licence is *also* not free for commercial apps, so today it competes with RNTP 5 on price and loses on features. The free alternatives (RNTP 4 Apache-2.0, expo-audio MIT) are what most teams will choose. | Decide the model. Either MIT core plus paid add-ons or support (the "obvious free choice" position RNTP gave up), or keep source-available and compete on features, which needs P1 shipped first. This decision drives the rest of the roadmap. |
| **Queue** | Music, podcast and audiobook apps need next/previous, gapless transitions and repeat. RNTP and expo-audio have them. "Load the next item on `ended`" (today's answer) leaves a gap, and on iOS it does not run at all while JS is suspended. | A **native queue** in the engine: `player.queue.set(items, { startIndex })`, `add/insert/remove/move`, `skipToNext/Previous/Index`, `repeat: 'off' \| 'one' \| 'all'`, `shuffle`. The next item is preloaded and played gaplessly (ExoPlayer playlist, AVQueuePlayer-style hand-off), and it auto-advances while JS is frozen. Lock-screen next/previous are handled natively when a queue exists. It is opt-in, so radio apps never pay for it. |
| **Migration guides** | Switching costs are the real moat of RNTP and expo-audio. | **Done:** [from react-native-track-player 4 & 5](migrating-from-track-player.md), [from expo-audio](migrating-from-expo-audio.md) and [from expo-av](migrating-from-expo-av.md), with API mapping tables and the recovery code you get to delete. |
| **Published device benchmarks** | "Bulletproof" needs proof. | Run the [protocol in benchmarks/README.md](../benchmarks/README.md#on-device-benchmarks-protocol) on real devices and publish the charts: drop recovery, outage recovery, handoff silence, connection hygiene. |

### P1 — the features people search for

| Gap | Proposal |
|---|---|
| **Short sounds (SFX, UI clicks, game audio)** | A separate, tiny `Sound` API (`react-native-anything-player/sound`). It preloads into memory, plays with low latency and polyphony, has no media session and no focus, and mixes with other audio by default. Android uses `SoundPool`; iOS uses an `AVAudioEngine` player-node pool. It is a different job from `Player` and is installable on its own (below). react-native-sound is the incumbent and barely maintained. |
| **Modular install** | Native code cannot be tree-shaken from JS, so modularity has to happen at build time. Step 1, build flags, which are cheap: `rnapHls` exists; add `rnapVisualizer`, `rnapStreaming` (drops the OkHttp data source, the iOS stream proxy and the network monitor for apps that play local files only) and `rnapMediaSession`. Expose them through the Expo plugin, e.g. `["react-native-anything-player", { "features": ["files"] }]`. Step 2, split packages: `@rnap/sound`, `@rnap/queue` and `@rnap/cache` each carry their own podspec and Gradle module, so an app compiles only what it installs. Publish the APK / IPA delta of each profile. |
| **CLI: `npx rnap doctor`** | **Done:** [`doctor` and `init`](cli.md) check the project setup (background audio, the New Architecture, the Expo plugin, the iOS 27 scene life cycle, Cast / Siri / Assistant wiring), the native build, and stream URLs (cleartext rules, ICY, CORS, Cast codecs); `init` applies the safe fixes after showing each diff. |
| **Cache & preload** | Media3 `SimpleCache` + `CacheDataSource` on Android; on iOS the stream proxy already owns the bytes, so it can write them to disk. `cache: { maxSizeBytes }`, plus `preload(source)`, which the queue uses for the next item. |
| **Sleep timer & fades** | **Done:** `player.sleep({ after, fadeOut })`, `status.sleepAt`, opt-in fades on play, pause and stop, and `fadeTo`, run by the engine (held to the conformance suite) so they work while JS is frozen. See [Sleep timer and fades](playback.md#sleep-timer-and-fades). |

### P2 — platform reach

In order: web first, then outputs, casting and voice, then cars (CarPlay and Android Auto reuse the voice catalog).

| Gap | Status / proposal |
|---|---|
| **Web** | **Done.** A TypeScript twin of the engine, held to the same conformance suite, for Expo web, React Native Web and plain pages (`react-native-anything-player/web`): ICY over fetch + MSE, splices, Media Session, a Web Audio visualizer, `AUTOPLAY_BLOCKED`. See [Web](web.md). |
| **Expo Go** | **Done:** it cannot load native code, so `new Player()` throws `NATIVE_MODULE_MISSING` with the development-build steps instead of crashing. |
| **Watches** | **Documented:** Apple Watch and Wear OS control the phone's media session; to be checked on hardware. A watch app of its own is out of scope. |
| **Output picker & AirPlay** | **Done:** `status.route` and `routeChange` everywhere; `<RoutePicker />` (iOS's AirPlay button, Android's Output Switcher, AirPlay in Safari, Remote Playback in Chrome). See [Casting & AirPlay](routes-and-casting.md). |
| **Chromecast** | **Done**, opt-in (`cast` plugin option): the engine hands a player to a Cast receiver and back (held to the conformance suite), on Android (Media3 Cast), iOS (Google Cast SDK) and Chrome (Cast Web Sender). Radio titles keep flowing from the phone. |
| **Siri / Google Assistant / Gemini** | **Done:** a catalog stored on the device (`setCatalog`), searched the same way on every platform, answers "play X on MyApp" even with the app closed; `playFromSearch()` on the web. See [Voice assistants](voice.md). |
| **Siri shortcuts** | **Done:** App Intents and App Shortcuts (iOS 16+) on the same catalog, alongside the Siri media extension. |
| **Web: Firefox, HLS, local files** | **Done:** MP3/AAC remuxed to fragmented MP4 where a browser's MSE needs it (Firefox gets ICY titles, splices and the visualizer); hls.js through `configureHls`; `File` / `Blob` and `blob:` / `data:` sources. |
| CarPlay / Android Auto browsing | Next: a browse tree over the same catalog, on the Media3 `MediaLibraryService` (already serving the catalog to Assistant) and `CPListTemplate`. Needed by car-first radio apps. |
| Recording | Out of scope. expo-audio and react-native-audio-api cover it; staying a player keeps RNAP small. |

## Hardware verification

RNAP runs in production in the Rádio Animu app since 1.0.0. These behaviours have not yet been checked deliberately on real devices:

- Exercise on hardware what [Testing](testing.md) lists as unverified: real calls, Siri (transport and "play X on MyApp", including a cold start), Google Assistant and Gemini, Bluetooth / AirPods, CarPlay / Android Auto, wired-headset unplug, AirPlay, Google Cast (Android, iOS, Chrome), cellular handoff, Apple Watch and Wear OS controls.
