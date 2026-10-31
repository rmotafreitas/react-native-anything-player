# Roadmap: what RNAP needs to be the default

RNAP's goal is to be the audio library React Native developers pick first: **lightweight, bulletproof, best DX**. This page records where it stands against the alternatives as of October 2026 ([comparison](comparison.md)) and what closes each gap, in priority order.

## Where RNAP already wins

- **Bulletproof streaming.** Of the libraries compared, only RNAP recovers a stream on its own on iOS and Android (on the web, icecast-metadata-player reconnects too, [comparison](comparison.md)): dead-socket and silent-stall detection, backoff, offline probing, Wi-Fi ↔ cellular handoff, and live-edge re-open. All of it is native, so it keeps working while JS is frozen. RNTP 5, RNTP 4 and expo-audio leave every one of these to app code ([matrix](comparison.md#what-you-get-out-of-the-box)).
- **Correctness under races.** Generations, sequence-numbered snapshots and ordered events, checked by 185 shared conformance scenarios run against all three engines (Swift, Kotlin, TypeScript).
- **Radio.** ICY metadata timed to when it is *heard*, charset repair, one connection per stream, paused-stream release, song progress on the lock screen, and a visualizer for iOS live streams (no one else has one).
- **Everywhere.** One engine and one API on iOS, Android, Expo web, React Native Web, React (Vite, Next.js) and plain web pages, with AirPlay, Google Cast, the voice assistants, CarPlay and Android Auto ([feature matrix](features.md)). Desktop apps built on a web view (Electron, Tauri) run the web engine ([Desktop](desktop.md)).
- **More than streams.** A sleep timer and fades run by the engine, and a [Sound API](sound.md) for short effects (a pool of voices per clip, volume, rate and pan), both from the same package.
- **Lean.** Media3 and MediaRouter on Android, with Google Cast, Siri, the Sound API and cars opt-in ([`npx rnap add`](cli.md#modules)); no framework requirement, zero runtime JS dependencies, about 56 KB of JS on a web page (25 KB of it video).

## Gaps, in priority order

### P0: adoption blockers

| Gap | Why it matters | Proposal |
|---|---|---|
| **Licence** | RNTP 5 went commercial (€99/month per app). RNAP's PolyForm Noncommercial licence is *also* not free for commercial apps, so today it competes with RNTP 5 on price and loses on features. The free alternatives (RNTP 4 Apache-2.0, expo-audio MIT) are what most teams will choose. | Decide the model. Either MIT core plus paid add-ons or support (the "obvious free choice" position RNTP gave up), or keep source-available and compete on features, which needs P1 shipped first. This decision drives the rest of the roadmap. |
| **Queue** | Music, podcast and audiobook apps need next/previous, gapless transitions and repeat. RNTP and expo-audio have them. "Load the next item on `ended`" (today's answer) leaves a gap, and on iOS it does not run at all while JS is suspended. | A **native queue** in the engine: `player.queue.set(items, { startIndex })`, `add/insert/remove/move`, `skipToNext/Previous/Index`, `repeat: 'off' \| 'one' \| 'all'`, `shuffle`. The next item is preloaded and played gaplessly (ExoPlayer playlist, AVQueuePlayer-style hand-off), and it auto-advances while JS is frozen. Lock-screen next/previous are handled natively when a queue exists. It is opt-in, so radio apps never pay for it. |
| **Migration guides** | Switching costs are the real moat of RNTP and expo-audio. | **Done:** [from react-native-track-player 4 & 5](migrating-from-track-player.md), [from expo-audio](migrating-from-expo-audio.md) and [from expo-av](migrating-from-expo-av.md), with API mapping tables and the recovery code you get to delete. |
| **Published device benchmarks** | "Bulletproof" needs proof. | Run the [protocol in benchmarks/README.md](../benchmarks/README.md#on-device-benchmarks-protocol) on real devices and publish the charts: drop recovery, outage recovery, handoff silence, connection hygiene. |

### P1: the features people search for

| Gap | Proposal |
|---|---|
| **Short sounds (SFX, UI clicks, game audio)** | **Done:** the [Sound API](sound.md) (`react-native-anything-player/sound`) preloads into memory and plays with low latency and polyphony, with per-play volume, rate, pan and loop, no media session and no focus, mixing with other audio. iOS uses an `AVAudioEngine` player-node pool, Android `SoundPool`, the web Web Audio. Opt-in on native (`npx rnap add sound`). |
| **Modular install** | **Done (step 1):** opt-in modules (Cast, Siri, the Sound API, cars) and HLS are build switches, and [`npx rnap add` / `remove`](cli.md#modules) writes them, showing each one's measured size. Visualizer, local-files-only and media-session switches were [measured and left out](configuration.md#modules). Step 2, if the package grows: split packages (`@rnap/sound`, `@rnap/queue`, `@rnap/cache`), each with its own podspec and Gradle module. |
| **CLI: `npx rnap`** | **Done:** [`modules`, `add`, `remove`, `size`, `info` and `migrate`](cli.md) list and switch the build modules with their measured size, print a bug-ready report and rewrite a Track Player, expo-audio or expo-av migration; `doctor` and `init` check the project setup (background audio, the New Architecture, the Expo plugin, the iOS 27 scene life cycle, Cast / Siri / Assistant wiring), the native build, and stream URLs (cleartext rules, ICY, CORS, Cast codecs), and `init` applies the safe fixes after showing each diff. |
| **Cache & preload** | Media3 `SimpleCache` + `CacheDataSource` on Android; on iOS the stream proxy already owns the bytes, so it can write them to disk. `cache: { maxSizeBytes }`, plus `preload(source)`, which the queue uses for the next item. |
| **Video** | **In progress** ([design](video-design.md)): a video is a `Player` with a picture, on the same engine and recovery. OS players with remux for MKV/WebM/TS, HLS/DASH, separate quality files switched without a spinner, subtitles (SubRip, WebVTT, TTML, CEA-608/708, basic ASS) in one overlay, Picture in Picture, fullscreen, AirPlay and Cast video, an audio-only fallback on bad networks, DRM, opt-in software decoders (built and published for Android; iOS and web not built). Not built yet: HDR filtering, and reading a rendition's height and bitrate from the file's headers (today they are given, or the playing file's height is learned). Opt-in on native (`npx rnap add video`). |
| **Sleep timer & fades** | **Done:** `player.sleep({ after, fadeOut })`, `status.sleepAt`, opt-in fades on play, pause and stop, and `fadeTo`, run by the engine (held to the conformance suite) so they work while JS is frozen. See [Sleep timer and fades](playback.md#sleep-timer-and-fades). |

### P2: platform reach

In order: web first, then outputs, casting and voice, then cars (CarPlay and Android Auto reuse the voice catalog), then [desktop](#desktop).

| Gap | Status / proposal |
|---|---|
| **Web** | **Done.** A TypeScript twin of the engine, held to the same conformance suite, for Expo web, React Native Web and plain pages (`react-native-anything-player/web`): ICY over fetch + MSE, splices, Media Session, a Web Audio visualizer, `AUTOPLAY_BLOCKED`. See [Web](web.md). |
| **Expo Go** | **Done:** it cannot load native code, so `new Player()` throws `NATIVE_MODULE_MISSING` with the development-build steps instead of crashing. |
| **Watches** | **Done:** Apple Watch shows Now Playing and its controls; Wear OS lists the phone's browse tree and controls its session. To be checked on hardware. A watch app of its own is out of scope. See [Cars & watches](cars-and-watches.md). |
| **Output picker & AirPlay** | **Done:** `status.route` and `routeChange` everywhere; `<RoutePicker />` (iOS's AirPlay button, Android's Output Switcher, AirPlay in Safari, Remote Playback in Chrome). See [Casting & AirPlay](routes-and-casting.md). |
| **Chromecast** | **Done**, opt-in (`cast` plugin option): the engine hands a player to a Cast receiver and back (held to the conformance suite), on Android (Media3 Cast), iOS (Google Cast SDK) and Chrome (Cast Web Sender). Radio titles keep flowing from the phone. |
| **Siri / Google Assistant / Gemini** | **Done:** a catalog stored on the device (`setCatalog`), searched the same way on every platform, answers "play X on MyApp" even with the app closed; `playFromSearch()` on the web. See [Voice assistants](voice.md). |
| **Siri shortcuts** | **Done:** App Intents and App Shortcuts (iOS 16+) on the same catalog, alongside the Siri media extension. |
| **Web: Firefox, HLS, local files** | **Done:** MP3/AAC remuxed to fragmented MP4 where a browser's MSE needs it (Firefox gets ICY titles, splices and the visualizer); hls.js through `configureHls`; `File` / `Blob` and `blob:` / `data:` sources. |
| **CarPlay / Android Auto browsing** | **Done**, opt-in (`car` plugin option): one browse tree from the catalog's `group`s, served by the Media3 `MediaLibraryService` (Android Auto, Android Automotive OS, Wear OS) and a CarPlay audio scene (`CPTabBarTemplate` of lists, Now Playing). Checked with a media client on the emulator; head units, CarPlay and watches are on the hardware list. See [Cars & watches](cars-and-watches.md). |
| **Live quality switches lined up** | **Android done:** a switch between live renditions (Icecast mounts at different bitrates) plays the new connection muted, faster or slower, until it is at the same point of the program, then takes over ([playback](playback.md#qualities)). iOS and the web still switch as soon as the new mount is ready (planned: a byte trim in the stream proxy, then a hold, on iOS; `playbackRate`, then a hold, on the web) ([#82](https://github.com/rmotafreitas/react-native-anything-player/issues/82)). |
| Recording | Out of scope. expo-audio and react-native-audio-api cover it; staying a player keeps RNAP small. |

### Desktop

Today a desktop app gets RNAP through a web view: Electron and Tauri run the web engine ([Desktop](desktop.md)). Expo has no desktop target. Native desktop is the next platform step, smallest first. The engine logic carries over: the Swift core (`ios/Core`) imports only Foundation, so each step is a host layer around an existing engine, held to the same conformance suite.

| Step | Proposal |
|---|---|
| **1. Electron and Tauri, tested** | Make web-view desktop a tested target instead of an expected one. Skip the Cast SDK download where Cast cannot work (Electron, Tauri), so `castState` is `unavailable` at once and no request goes to Google. Run the plain-web example in Electron in CI (Playwright drives Electron) with the web scenarios. Then mark the Desktop rows of the [feature matrix](features.md) as tested, with what Electron adds over a tab: autoplay without a gesture, no background throttling, the OS media controls. |
| **2. Mac from the iOS build** | Apple silicon Macs run iPhone and iPad apps, and Mac Catalyst builds them for the Mac. Guard what the Mac does not have (CarPlay, parts of `AVAudioSession`, the Siri media extension), check the stream proxy, Now Playing and the remote commands there, and add a Mac run of the example to the test plan. |
| **3. react-native-macos** | An AppKit host for the same Swift engine: AVPlayer and the stream proxy, `MPNowPlayingInfoCenter` and `MPRemoteCommandCenter` (both exist on macOS), AirPlay through `AVRoutePickerView`, no audio session. A macOS platform in the podspec and an example app. |
| **4. react-native-windows** | The largest step: a Windows host on `Windows.Media.Playback.MediaPlayer` with the System Media Transport Controls (media keys, the Windows media flyout), and the engine running there. Either a fourth twin in C++ or C#, held to the conformance suite like the others, or the TypeScript engine driving a native `MediaPlayer`. To be decided when the work starts. |

## Hardware verification

RNAP runs in production in the Rádio Animu app since 1.0.0. These behaviours have not yet been checked deliberately on real devices:

- Exercise on hardware what [Testing](testing.md) lists as unverified: real calls, Siri (transport and "play X on MyApp", including a cold start), Google Assistant and Gemini, Bluetooth / AirPods, CarPlay and an Android Auto head unit (browse tree included), Android Automotive OS, wired-headset unplug, AirPlay, Google Cast (Android, iOS, Chrome), cellular handoff, Apple Watch and Wear OS controls and the Wear OS browse tree, the Sound API on iOS and Android devices, and the sleep timer with the screen locked.
- Add a Sound screen to the example apps, so the Sound API runs in the on-device scenarios as `Player` does.
