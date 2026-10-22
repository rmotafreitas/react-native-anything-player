<p align="center"><img src="docs/assets/brand/mascot-480.webp" width="200" alt="RNAP's mascot, a fox girl in orange headphones, tapping play on her phone"></p>

# React Native Anything Player (RNAP)

`react-native-anything-player` is a native-first audio player for React Native and the web — files, streams and **internet radio** — that keeps playing correctly in the background, through network loss, interruptions and JavaScript freezes. One API on iOS, Android, Expo web, React Native Web, React (Vite, Next.js) and plain web pages, with AirPlay, Google Cast and the voice assistants.

```ts
import { Player } from 'react-native-anything-player';

const player = new Player();
await player.load('https://radio.example.com/stream');
await player.play();
```

That is the whole integration for a radio that reconnects on its own, survives Wi-Fi ↔ cellular handoffs, respects phone calls and other apps, shows the station and the current song (from ICY metadata) on the lock screen, and releases its connection when paused.

## Why

Playback logic that lives in JavaScript breaks in exactly the situations a player must handle: React Native suspends JS timers in the background, the JS thread can be frozen or reloaded, and native events race JS commands. RNAP keeps the whole player — state machine, recovery, audio focus, interruptions, media session, clocks — in native code. JavaScript sends commands and mirrors native state; it is never required for playback to work.

RNAP was built by [@rmotafreitas](https://github.com/rmotafreitas), developer of the Rádio Animu mobile app and part of the [animu.moe](https://www.animu.moe) team, when React Native Track Player went commercial (v5 needs a paid licence even for a free app from a non-profit) and staying on air through a dropped network, a phone call or a switch to Instagram still took a pile of app code with every available player. [docs/why.md](docs/why.md) has the full story with sources; [docs/recovery.md](docs/recovery.md) lists every recovery rule and the failure behind it.

![What you get out of the box: RNAP, RNTP 5, RNTP 4 and expo-audio compared](docs/assets/charts/capabilities.svg)

Read from each library's published source; sizes, methodology and the gaps RNAP still has are in [Comparison & benchmarks](docs/comparison.md) and the [roadmap](docs/roadmap.md).

## Features

- **Sources**: local files, bundled assets (`require('./a.mp3')`), `content://` URIs, HTTP(S) files, progressive streams, HLS, ICY (Shoutcast/Icecast) radio.
- **Internet radio**: ICY metadata (title/artist/station, charset repair, `StreamUrl` artwork), live-edge recovery, gapless reconnects when a station drops the connection, exactly one connection per stream (verified against a connection-counting server), paused-stream connection release.
- **Recovery**: stall and silent-stall detection, dead-socket re-open, jittered exponential backoff, offline-aware probing, network-handoff awareness, a give-up limit, circuit breakers against connection storms.
- **System integration**: background playback, lock screen / Control Center / notification, headset, Bluetooth, car and Wear controls, Android audio focus (incl. Android 15 rules), iOS interruptions, output disconnects, media-services reset.
- **Correctness**: per-open generations reject stale native events; commands are applied in call order; status snapshots are sequence-numbered; events are ordered after the status they imply.
- **Visualizer**: decoded-audio windows (`audioSample`) on iOS, Android and the web — including live HTTP streams on iOS, where AVPlayer's audio tap never runs.
- **Outputs and casting**: where the audio goes (`status.route`), the system output picker (`<RoutePicker />`: AirPlay, Android's Output Switcher), and Google Cast as a build option (`<CastButton />`), with radio titles kept while casting.
- **Voice assistants**: a catalog stored on the device answers "Hey Siri / Hey Google, play X on MyApp", even with the app closed; Siri shortcuts on iOS 16+; the same search on the web (`playFromSearch`).
- **Song progress for radio**: give the current song's duration and the lock screen shows its progress, advanced natively.
- **Web**: the same API in Expo web, React Native Web, React apps without React Native (`react-native-anything-player/react`: Vite, Next.js) and plain pages (`react-native-anything-player/web`), on a TypeScript twin of the engine that passes the same conformance suite: ICY metadata over fetch + MSE, splices, recovery, the Media Session, the visualizer.
- **Observability**: a native ring buffer of structured engine traces, readable any time with `player.getDiagnostics()`, and a CLI (`doctor`) that checks an app's setup and its stream URLs.
- **Small and fast**: a TurboModule with zero JS dependencies; progress is a synchronous JSI read (~10 µs), so a progress bar needs no events. Opt into `progress` events from a native timer (`progressInterval`) when JS must follow the audio where its own timers are frozen.

## Install

```sh
npm install react-native-anything-player
# or: yarn add react-native-anything-player / pnpm add react-native-anything-player
```

> [!NOTE]
> **Not on npm yet.** Until the first npm release, install the package tarball attached to each [GitHub release](https://github.com/rmotafreitas/react-native-anything-player/releases):
>
> ```sh
> npm install https://github.com/rmotafreitas/react-native-anything-player/releases/latest/download/react-native-anything-player.tgz
> ```
>
> To pin a version, use `releases/download/v1.1.0/react-native-anything-player.tgz`.

Requires React Native **≥ 0.80** with the New Architecture (the default), iOS 15.1+, Android 7.0+ (API 24). On the web: any current browser ([Web](docs/web.md)). Expo Go cannot load native code: use a development build.

**Expo** (development builds / prebuild — not Expo Go):

```json
{ "expo": { "plugins": ["react-native-anything-player"] } }
```

**Bare React Native (iOS)**: add the `audio` background mode to `Info.plist`, then `pod install`:

```xml
<key>UIBackgroundModes</key>
<array><string>audio</string></array>
```

Android needs nothing: the media playback service and permissions are merged from the library manifest.

→ Full guide: [docs/getting-started.md](docs/getting-started.md)

## Usage

```tsx
import { Player, usePlayerStatus, useProgress, useStreamMetadata } from 'react-native-anything-player';

// Create players at module scope: playback does not depend on any component.
export const radio = new Player();

await radio.load({
  uri: 'https://radio.example.com/stream',
  metadata: { title: 'My Radio', artwork: 'https://radio.example.com/logo.png' },
});
await radio.play();

function NowPlaying() {
  const status = usePlayerStatus(radio);      // state, playWhenReady, interruption, error, …
  const progress = useProgress(radio, 500);   // synchronous native reads, no event spam
  const metadata = useStreamMetadata(radio);  // ICY / ID3 / timed metadata, when audible
  return (
    <Button
      title={status.playWhenReady ? 'Pause' : 'Play'}
      onPress={() => radio.toggle()}
    />
  );
}
```

## Documentation

| | |
|---|---|
| [Why RNAP](docs/why.md) | Why this library exists, with sources |
| [Getting started](docs/getting-started.md) | Installation (Expo, bare), first player, permissions |
| [Comparison & benchmarks](docs/comparison.md) | Each library against its own kind: RNTP, expo-audio and the rest on iOS and Android and on Expo web; howler.js, Plyr, Vidstack and the rest on React and plain web pages |
| Migrating: [react-native-track-player](docs/migrating-from-track-player.md), [expo-audio](docs/migrating-from-expo-audio.md), [expo-av](docs/migrating-from-expo-av.md) | API mapping, lock-screen controls, and the recovery code you can delete |
| [Playback](docs/playback.md) | Sources, commands, state model, progress, volume, seeking |
| [Internet radio & ICY](docs/internet-radio.md) | Live streams, ICY metadata, live edge, recovery |
| [Background & system](docs/background-and-system.md) | Background, lock screen, media sessions, interruptions, audio focus, artwork |
| [Events](docs/events.md) | Status, events, ordering and threading guarantees |
| [Feature matrix](docs/features.md) | What works where: iOS, Android and the web, feature by feature |
| [Web](docs/web.md) | Expo web, React Native Web, React (Vite, Next.js), plain pages: setup, CORS, autoplay, browser support |
| [Visualizer](docs/visualizer.md) | Decoded-audio windows for oscilloscopes and meters (iOS streams included) |
| [Errors](docs/errors.md) | Normalized error codes |
| [Configuration](docs/configuration.md) | Every `PlayerOptions` field |
| [Recovery policy](docs/recovery.md) | Every recovery constant and why it exists |
| [Debugging & troubleshooting](docs/debugging.md) | Diagnostics, logs, common problems, FAQ |
| [Architecture](docs/architecture.md) | Design decisions and research |
| [Testing](docs/testing.md) | Test layers, conformance suite, device tests, soak results |
| [CLI](docs/cli.md) | `doctor` and `init`: check and fix an app's setup |
| [Roadmap](docs/roadmap.md) | What RNAP still needs, in priority order |
| [Changelog](CHANGELOG.md), [Versioning & releases](docs/releases.md) | Every release; what a version number promises |

The same pages are published as a site (search included): `yarn docs` runs it locally, `yarn docs:build` builds it. The site also carries an API reference for every export, generated from the TSDoc in `src/` by TypeDoc (`yarn docs:api` writes it to `docs/api/`, which is not committed). Diagrams are PlantUML sources in `docs/diagrams/` (`node scripts/render-diagrams.mjs`); charts come from `benchmarks/` (`node benchmarks/size/measure.mjs && node benchmarks/charts/render.mjs`).

## License

**Source-available**, not OSI open source: [PolyForm Noncommercial 1.0.0](LICENSE). Free for personal, hobby, educational, research, nonprofit and noncommercial open-source use. Commercial use needs a license — see [COMMERCIAL.md](COMMERCIAL.md).

## Quality gates

See [CI and quality policy](docs/quality-gates.md) for local checks, GitHub Actions,
Jenkins, SonarQube, coverage floors, and the native test scope.
