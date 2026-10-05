# Roadmap: what Airwave needs to be the default

Airwave's goal is to be the audio library React Native developers pick first: **lightweight, bulletproof, best DX**. This page records where it stands against the alternatives as of October 2026 ([comparison](comparison.md)) and what closes each gap, in priority order.

## Where Airwave already wins

- **Bulletproof streaming.** It is the only library that recovers a stream on its own: dead-socket and silent-stall detection, backoff, offline probing, Wi-Fi ↔ cellular handoff, and live-edge re-open. All of it is native, so it keeps working while JS is frozen. RNTP 5, RNTP 4 and expo-audio leave every one of these to app code ([matrix](comparison.md#what-you-get-out-of-the-box)).
- **Correctness under races.** Generations, sequence-numbered snapshots and ordered events, checked by 59 shared conformance scenarios run against both engines.
- **Radio.** ICY metadata timed to when it is *heard*, charset repair, one connection per stream, paused-stream release, song progress on the lock screen, and a visualizer for iOS live streams (no one else has one).
- **Lean.** Media3 only on Android, no framework requirement, zero runtime JS dependencies.

## Gaps, in priority order

### P0 — adoption blockers

| Gap | Why it matters | Proposal |
|---|---|---|
| **Licence** | RNTP 5 went commercial (€99/month per app). Airwave's PolyForm Noncommercial licence is *also* not free for commercial apps, so today it competes with RNTP 5 on price and loses on features. The free alternatives (RNTP 4 Apache-2.0, expo-audio MIT) are what most teams will choose. | Decide the model. Either MIT core plus paid add-ons or support (the "obvious free choice" position RNTP gave up), or keep source-available and compete on features, which needs P1 shipped first. This decision drives the rest of the roadmap. |
| **Queue** | Music, podcast and audiobook apps need next/previous, gapless transitions and repeat. RNTP and expo-audio have them. "Load the next item on `ended`" (today's answer) leaves a gap, and on iOS it does not run at all while JS is suspended. | A **native queue** in the engine: `player.queue.set(items, { startIndex })`, `add/insert/remove/move`, `skipToNext/Previous/Index`, `repeat: 'off' \| 'one' \| 'all'`, `shuffle`. The next item is preloaded and played gaplessly (ExoPlayer playlist, AVQueuePlayer-style hand-off), and it auto-advances while JS is frozen. Lock-screen next/previous are handled natively when a queue exists. It is opt-in, so radio apps never pay for it. |
| **Migration guides** | Switching costs are the real moat of RNTP and expo-audio. | Docs pages "From react-native-track-player" and "From expo-audio" with an API mapping table and the recovery code you get to delete. |
| **Published device benchmarks** | "Bulletproof" needs proof. | Run the [protocol in benchmarks/README.md](../benchmarks/README.md#on-device-benchmarks-protocol) on real devices and publish the charts: drop recovery, outage recovery, handoff silence, connection hygiene. |

### P1 — the features people search for

| Gap | Proposal |
|---|---|
| **Short sounds (SFX, UI clicks, game audio)** | A separate, tiny `Sound` API (`react-native-airwave/sound`). It preloads into memory, plays with low latency and polyphony, has no media session and no focus, and mixes with other audio by default. Android uses `SoundPool`; iOS uses an `AVAudioEngine` player-node pool. It is a different job from `Player` and is installable on its own (below). react-native-sound is the incumbent and barely maintained. |
| **Modular install** | Native code cannot be tree-shaken from JS, so modularity has to happen at build time. Step 1, build flags, which are cheap: `airwaveHls` exists; add `airwaveVisualizer`, `airwaveStreaming` (drops the OkHttp data source, the iOS stream proxy and the network monitor for apps that play local files only) and `airwaveMediaSession`. Expose them through the Expo plugin, e.g. `["react-native-airwave", { "features": ["files"] }]`. Step 2, split packages: `@airwave/sound`, `@airwave/queue` and `@airwave/cache` each carry their own podspec and Gradle module, so an app compiles only what it installs. Publish the APK / IPA delta of each profile. |
| **CLI: `npx airwave doctor`** | Checks the setup errors in [Debugging](debugging.md): the iOS `audio` background mode, ATS and Android cleartext rules for each station URL, the New Architecture, the RN version, the Expo plugin, and the iOS 27 scene life cycle. `npx airwave init` applies the fixes. This is the biggest DX lever after the docs. |
| **Cache & preload** | Media3 `SimpleCache` + `CacheDataSource` on Android; on iOS the stream proxy already owns the bytes, so it can write them to disk. `cache: { maxSizeBytes }`, plus `preload(source)`, which the queue uses for the next item. |
| **Sleep timer & fades** | `player.sleep({ after: 1800, fadeOut: 10 })` and fade-in / fade-out on play / pause, scheduled natively so they run while JS is frozen. |

### P2 — platform reach

| Gap | Proposal |
|---|---|
| CarPlay / Android Auto browsing | A browse tree (`setBrowseTree`) on the Media3 `MediaLibraryService` and `CPListTemplate`. Needed by car-first radio apps. |
| Cast / AirPlay picker | An `AVRoutePickerView` component and Media3 Cast. |
| Web | An `HTMLAudioElement` engine with the same `Player` API, for Expo web and React Native Web. |
| Recording | Out of scope. expo-audio and react-native-audio-api cover it; staying a player keeps Airwave small. |

## Before 1.0

- Exercise on hardware what [Testing](testing.md) lists as unverified: real calls, Siri, Bluetooth / AirPods, CarPlay / Android Auto, wired-headset unplug, AirPlay, cellular handoff.
- Generate an API reference from the TypeScript types (TypeDoc) and publish it in the docs site.
