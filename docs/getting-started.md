# Getting started

## Requirements

| | Minimum | Tested with |
|---|---|---|
| React Native | 0.80, New Architecture | 0.86.3 |
| iOS | 15.1 | iOS 27 simulator |
| Android | 7.0 (API 24) | Android 16 (API 36) emulator |
| Expo | SDK with RN ≥ 0.80, development build (or Expo web) | SDK 57 |
| Web | a browser with Media Source Extensions for ICY metadata | Chromium, Firefox, WebKit ([Web](web.md)) |
| React without React Native | React 18+ (react-dom: Vite, Next.js) | React 19.2, Vite 8 ([Web](web.md#react-dom)) |
| CLI (`modules`, `doctor`, `migrate`) | Node 20 | Node 24 |

RNAP is a TurboModule. The legacy architecture (bridge) is not supported.

## Install

```sh
npm install react-native-anything-player
```

> [!NOTE]
> **Not on npm yet.** Until the first npm release, install the package tarball attached to each [GitHub release](https://github.com/rmotafreitas/react-native-anything-player/releases):
>
> ```sh
> npm install https://github.com/rmotafreitas/react-native-anything-player/releases/latest/download/react-native-anything-player.tgz
> ```
>
> To pin a version, use `releases/download/v1.3.1/react-native-anything-player.tgz`.

(`yarn add` / `pnpm add` work the same; the package has no JS dependencies.)

### Expo

RNAP contains native code, so it **does not run in Expo Go** (see [below](#expo-go)). Use a [development build](https://docs.expo.dev/develop/development-builds/introduction/) or `npx expo prebuild`. Expo web needs no native code: see [Web](web.md).

Add the config plugin to `app.json` / `app.config.js`:

```json
{
  "expo": {
    "plugins": ["react-native-anything-player"]
  }
}
```

The plugin adds the iOS `audio` background mode and lets Google Assistant and Gemini reach the app. Options, as `["react-native-anything-player", { … }]`:

| Option | Default | |
|---|---|---|
| `backgroundAudio` | `true` | iOS `audio` background mode. `false` if you only play in the foreground (video with Picture in Picture still adds it) |
| `cast` | off | `true` (or `{ "receiverApplicationId": "…" }`) builds Google Cast in ([Casting & AirPlay](routes-and-casting.md#google-cast)) |
| `sound` | off | `true` builds the [Sound API](sound.md#enabling-it) in (short effects with low latency) |
| `siri` | off | `true` adds the Siri capability and the extension that hands "play X on MyApp" to the app ([Voice assistants](voice.md#siri)) |
| `assistant` | `true` | the Android intent filter and `MainActivity` hook for Google Assistant and Gemini ([Voice assistants](voice.md#google-assistant-and-gemini)) |
| `car` | off | `true` builds Android Auto and the CarPlay scene in; `{ "ios": false }` or `{ "android": false }` leaves one out ([Cars & watches](cars-and-watches.md)) |
| `video` | off | `true` (or `{ "pictureInPicture": false }`) builds [video](video.md#enabling-it) in, with Picture in Picture |
| `videoDecoders` | off | `true` adds Android's [software decoders](video.md#software-decoders) (Dolby, DTS and MPEG audio, VP9, AV1) |
| `catalog` | none | the path of a JSON file with what the app passes to `setCatalog`, bundled so that voice requests and cars work on a fresh install, before the app was opened ([Voice assistants](voice.md#a-catalog-the-app-bundles)) |

Then rebuild (`npx expo run:ios`, `npx expo run:android`, or EAS Build).

### Expo Go

Expo Go ships a fixed set of native modules and cannot load RNAP's. There, `new Player()` throws a `PlayerError` with code `NATIVE_MODULE_MISSING` that says what to do instead of crashing on import:

```sh
npx expo run:ios        # or run:android: builds a development client with RNAP
```

A bare app that throws it was not rebuilt after installing RNAP (run `pod install` on iOS, then rebuild).

### Bare React Native

iOS: add the background mode to `ios/<App>/Info.plist` and install pods.

```xml
<key>UIBackgroundModes</key>
<array>
  <string>audio</string>
</array>
```

```sh
cd ios && pod install
```

Android: nothing to do. The library manifest is merged into your app and declares:

| Entry | Why |
|---|---|
| `INTERNET`, `ACCESS_NETWORK_STATE` | streams; offline / handoff detection |
| `WAKE_LOCK` | keep the CPU and Wi-Fi awake while streaming with the screen off |
| `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MEDIA_PLAYBACK` | background playback |
| `AnythingPlayerPlaybackService` (`mediaPlayback`) | the media notification, lock screen and hardware controls |

No `POST_NOTIFICATIONS` request is needed: media-session notifications are exempt.

Dependencies: Media3 (ExoPlayer, session, HLS, OkHttp data source). The OkHttp data source requires OkHttp 4.12, so Gradle resolves your app's OkHttp (React Native ships 4.9.x) to 4.12, a compatible 4.x release. Set `rnapHls=false` in `gradle.properties` to leave out HLS support.

## First player

```ts
import { Player } from 'react-native-anything-player';

export const player = new Player();

await player.load('https://example.com/song.mp3'); // resolves when ready
await player.play();
```

Create players at **module scope** (or in a store), not inside components. A player keeps playing when the component that created it unmounts; call `player.release()` when you are done with it for good.

### Reacting to state

```tsx
import { usePlayerStatus, useProgress } from 'react-native-anything-player';

function Controls() {
  const status = usePlayerStatus(player);
  const { position, duration } = useProgress(player, 250);
  return (
    <>
      <Text>{status.state}</Text>
      <Button title={status.playWhenReady ? 'Pause' : 'Play'} onPress={() => player.toggle()} />
      <Text>{Math.floor(position)} / {duration ?? 'live'}</Text>
    </>
  );
}
```

Show the play/pause button from `status.playWhenReady` (the *intent*), and a spinner when `state` is `loading`, `buffering` or `reconnecting`.

## Next steps

- [Playback](playback.md): sources, commands, state model.
- [Internet radio](internet-radio.md): ICY metadata and live streams.
- [Background & system](background-and-system.md): lock screen, interruptions, audio focus.
- [Web](web.md): Expo web, React Native Web, React (Vite, Next.js) and plain web pages.
- [Feature matrix](features.md): what works where.
