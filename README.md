<p align="center"><img src="docs/assets/brand/mascot-480.webp" width="200" alt="RNAP's mascot, a fox girl in orange headphones, tapping play on her phone"></p>

# React Native Anything Player (RNAP)

`react-native-anything-player` is a native-first audio player for React Native — files, streams and **internet radio** — that keeps playing correctly in the background, through network loss, interruptions and JavaScript freezes.

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
- **Visualizer**: decoded-audio windows (`audioSample`) on both platforms — including live HTTP streams on iOS, where AVPlayer's audio tap never runs.
- **Song progress for radio**: give the current song's duration and the lock screen shows its progress, advanced natively.
- **Observability**: a native ring buffer of structured engine traces, readable any time with `player.getDiagnostics()`.
- **Small and fast**: a TurboModule with zero JS dependencies; progress is a synchronous JSI read (~10 µs), so a progress bar needs no events. Opt into `progress` events from a native timer (`progressInterval`) when JS must follow the audio where its own timers are frozen.

## Install

```sh
npm install react-native-anything-player
# or: yarn add react-native-anything-player / pnpm add react-native-anything-player
```

Requires React Native **≥ 0.80** with the New Architecture (the default), iOS 15.1+, Android 7.0+ (API 24).

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
| [Comparison & benchmarks](docs/comparison.md) | RNAP against RNTP, expo-audio and the rest: capabilities, install size |
| [Playback](docs/playback.md) | Sources, commands, state model, progress, volume, seeking |
| [Internet radio & ICY](docs/internet-radio.md) | Live streams, ICY metadata, live edge, recovery |
| [Background & system](docs/background-and-system.md) | Background, lock screen, media sessions, interruptions, audio focus, artwork |
| [Events](docs/events.md) | Status, events, ordering and threading guarantees |
| [Visualizer](docs/visualizer.md) | Decoded-audio windows for oscilloscopes and meters (iOS streams included) |
| [Errors](docs/errors.md) | Normalized error codes |
| [Configuration](docs/configuration.md) | Every `PlayerOptions` field |
| [Recovery policy](docs/recovery.md) | Every recovery constant and why it exists |
| [Debugging & troubleshooting](docs/debugging.md) | Diagnostics, logs, common problems, FAQ |
| [Architecture](docs/architecture.md) | Design decisions and research |
| [Testing](docs/testing.md) | Test layers, conformance suite, device tests, soak results |
| [Roadmap](docs/roadmap.md) | What RNAP still needs, in priority order |

The same pages are published as a site (search included): `yarn docs` runs it locally, `yarn docs:build` builds it. Diagrams are PlantUML sources in `docs/diagrams/` (`node scripts/render-diagrams.mjs`); charts come from `benchmarks/` (`node benchmarks/size/measure.mjs && node benchmarks/charts/render.mjs`).

## License

**Source-available**, not OSI open source: [PolyForm Noncommercial 1.0.0](LICENSE). Free for personal, hobby, educational, research, nonprofit and noncommercial open-source use. Commercial use needs a license — see [COMMERCIAL.md](COMMERCIAL.md).
