# Getting started

## Requirements

| | Minimum | Tested with |
|---|---|---|
| React Native | 0.80, New Architecture | 0.86.2 |
| iOS | 15.1 | iOS 27 simulator |
| Android | 7.0 (API 24) | Android 16 (API 36) emulator |
| Expo | SDK with RN ≥ 0.80, development build | SDK 57 |

Airwave is a TurboModule. The legacy architecture (bridge) is not supported.

## Install

```sh
npm install react-native-airwave
```

(`yarn add` / `pnpm add` work the same; the package has no JS dependencies.)

### Expo

Airwave contains native code, so it **does not run in Expo Go**. Use a [development build](https://docs.expo.dev/develop/development-builds/introduction/) or `npx expo prebuild`.

Add the config plugin to `app.json` / `app.config.js`:

```json
{
  "expo": {
    "plugins": ["react-native-airwave"]
  }
}
```

The plugin adds the iOS `audio` background mode. Pass `["react-native-airwave", { "backgroundAudio": false }]` if you only play in the foreground. Then rebuild (`npx expo run:ios`, `npx expo run:android`, or EAS Build).

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
| `AirwavePlaybackService` (`mediaPlayback`) | the media notification, lock screen and hardware controls |

No `POST_NOTIFICATIONS` request is needed: media-session notifications are exempt.

Dependencies: Media3 (ExoPlayer, session, HLS, OkHttp data source). The OkHttp data source requires OkHttp 4.12, so Gradle resolves your app's OkHttp (React Native ships 4.9.x) to 4.12, a compatible 4.x release. Set `airwaveHls=false` in `gradle.properties` to leave out HLS support.

## First player

```ts
import { Player } from 'react-native-airwave';

export const player = new Player();

await player.load('https://example.com/song.mp3'); // resolves when ready
await player.play();
```

Create players at **module scope** (or in a store), not inside components. A player keeps playing when the component that created it unmounts; call `player.release()` when you are done with it for good.

### Reacting to state

```tsx
import { usePlayerStatus, useProgress } from 'react-native-airwave';

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
