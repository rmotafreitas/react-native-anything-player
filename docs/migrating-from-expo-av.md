# Migrating from expo-av

This guide moves audio playback from `expo-av` (`Audio.Sound`) to RNAP. It was written against `expo-av` 16.0.8, read from its published npm package. Its changelog records that Expo AV is deprecated ("Expo AV has now been deprecated"), and that its `Video` component carries a deprecation warning.

RNAP is an audio player. It does not record and it does not play video, so those parts of expo-av need another library ([below](#what-differs-or-is-missing)).

## Why switch

- **Streams recover by themselves.** expo-av reports `isLoaded: false` with an `error` string and leaves the rest to you. RNAP detects dead sockets and silent stalls, backs off, probes while offline, handles Wi-Fi ↔ cellular switches and re-opens at the live edge, natively ([recovery policy](recovery.md)).
- **A lock screen.** A search of expo-av's iOS and Android sources finds no Now Playing, media session or remote-command code, so an expo-av player has no lock-screen or notification controls. RNAP has them on by default.
- **Real background playback.** expo-av's `staysActiveInBackground` is a flag on the audio mode. RNAP runs a media foreground service on Android and keeps recovering on iOS while the app is in the background ([background playback](background-and-system.md#background-playback)).
- **Radio metadata.** expo-av's `setOnMetadataUpdate` is iOS-only and carries a `title` and nothing else (`AVMetadata`). RNAP publishes ICY title, artist, station and genre on both platforms, when they are *heard* ([internet radio](internet-radio.md)).

> **Licence.** expo-av is MIT. RNAP is PolyForm Noncommercial: free for personal, educational, non-profit and other noncommercial use, and it needs a commercial licence otherwise ([roadmap, P0 licence](roadmap.md#p0-—-adoption-blockers), [COMMERCIAL.md](../COMMERCIAL.md)). Check which applies to you before you move. If you are leaving expo-av because it is deprecated, [expo-audio](migrating-from-expo-audio.md) is its MIT successor.

## Install and setup

RNAP is a TurboModule that needs React Native 0.80 or later with the New Architecture, and an Expo development build ([requirements](getting-started.md#requirements)). The `expo` package is not required.

```sh
npm uninstall expo-av        # keep it if you still use Video or Audio.Recording
npm install react-native-anything-player
```

RNAP is not on npm yet: until it is, install the release tarball ([Getting started](getting-started.md#install)).

```diff
 // app.json
 {
   "expo": {
     "plugins": [
-      ["expo-av", { "microphonePermission": false }],
+      "react-native-anything-player"
     ]
   }
 }
```

expo-av's plugin only manages the microphone permission, so a background-audio app set `UIBackgroundModes` by hand (for example `ios.infoPlist`). The RNAP plugin adds the `audio` background mode for you; remove your manual entry if you like. Then rebuild (`npx expo run:ios`, `npx expo run:android` or EAS Build). In Expo Go, `new Player()` throws `NATIVE_MODULE_MISSING` with the steps ([Expo Go](getting-started.md#expo-go)).

## The mental model changes

`Audio.Sound` is an object you create per sound, load, and unload. A RNAP `Player` is created once at module scope, and `load()` swaps what it plays:

```ts
// player.ts
import { Player } from 'react-native-anything-player';
export const player = new Player();
```

You do not unload on unmount. Call `player.release()` only when you are done with the player for good. A paused or playing player survives screen changes.

## API mapping

| expo-av | RNAP |
|---|---|
| `const { sound } = await Audio.Sound.createAsync(source, initialStatus, onStatus, downloadFirst)` | `await player.load(source, { autoplay, startPosition })` |
| `new Audio.Sound()` + `sound.loadAsync(source, initialStatus)` | `player.load(source)` |
| `AVPlaybackSource`: `require()` number, `{ uri, headers, overrideFileExtensionAndroid }`, `Asset` | `SourceInput`: string, `require()` number, or `{ uri, headers, live, metadata }`. No extension override; the platform sniffs the format |
| `initialStatus.shouldPlay: true` | `load(source, { autoplay: true })` |
| `initialStatus.positionMillis` | `load(source, { startPosition })` in **seconds** |
| `sound.playAsync()` | `player.play()` |
| `sound.pauseAsync()` | `player.pause()`; `player.toggle()` |
| `sound.stopAsync()` | `player.stop()`: releases network and decoder, keeps the source. Files restart from the beginning on `play()` |
| `sound.replayAsync()` | `player.seekTo(0)` then `player.play()` |
| `sound.setPositionAsync(ms, tolerance)` | `player.seekTo(seconds)` (no tolerance) |
| `sound.setVolumeAsync(volume, audioPan)` | `player.setVolume(volume)`; no pan |
| `status.isMuted` / `setStatusAsync({ isMuted })` | `player.setMuted(bool)` |
| `sound.setRateAsync(rate, shouldCorrectPitch, quality)` | `player.setRate(rate)`; no pitch options |
| `sound.setIsLoopingAsync(bool)` | none. `player.on('ended', () => player.play())` restarts a finished file |
| `sound.setProgressUpdateIntervalAsync(ms)` | `useProgress(player, ms)`, or `new Player({ progressInterval })` for native `progress` events |
| `sound.getStatusAsync()` | `player.status` (synchronous), `player.getProgress()` |
| `sound.unloadAsync()` | `player.reset()` unloads; `player.release()` frees the player |
| `sound.setOnPlaybackStatusUpdate(fn)` | `player.on('status', fn)`, or `usePlayerStatus(player)` |
| `sound.setOnMetadataUpdate(fn)` (iOS) | `player.on('metadata', fn)` or `useStreamMetadata(player)` (iOS and Android) |
| `sound.setOnAudioSampleReceived(fn)` | `player.setAudioSampling({ enabled: true })` and the `audioSample` event ([visualizer](visualizer.md)) |
| `Audio.setIsEnabledAsync(false)` | none; `player.pause()` or `player.release()` |
| `Audio.setAudioModeAsync(mode)` | constructor options, see [below](#audio-mode) |
| `Audio.Recording` | none: recording is [out of scope](roadmap.md#p2-—-platform-reach) |
| `Video` component | none: RNAP plays audio only |

## Status and events

expo-av delivers an `AVPlaybackStatus` through `setOnPlaybackStatusUpdate`: every status call and every `progressUpdateIntervalMillis`. It is a union. `isLoaded: false` carries an `error?: string`; `isLoaded: true` carries the position and flags. RNAP has one snapshot, `PlayerStatus`, pushed on change only ([status](events.md#status)). Positions are **seconds**, not milliseconds.

| expo-av `AVPlaybackStatus` | RNAP |
|---|---|
| `isLoaded: false` | `status.state === 'idle'` (nothing loaded), or `'error'` |
| `error` (string) | `status.error: { code, message, recoverable, … }`, and the `error` event with `{ fatal }` ([errors](errors.md)) |
| `shouldPlay` | `status.playWhenReady` |
| `isPlaying` | `status.state === 'playing'` |
| `isBuffering` | `status.state` is `buffering`, `loading` or `reconnecting` |
| `didJustFinish` | `player.on('ended', …)` or `status.state === 'ended'` |
| `positionMillis` | `getProgress().position` (seconds) |
| `durationMillis` | `getProgress().duration` (seconds; `null` for live or unknown) |
| `playableDurationMillis` | `getProgress().buffered` |
| `rate` | `status.rate` |
| `volume`, `isMuted` | `status.volume`, `status.muted` |
| `isLooping` | none |
| `uri` | the `Source` you passed to `load()` |
| `audioPan` | none |

An expo-av status callback usually became a `useState` that was updated every 500 ms. In RNAP, `usePlayerStatus(player)` re-renders only when something changed, and `useProgress(player, ms)` polls native state for the progress bar:

```tsx
const status = usePlayerStatus(player);                  // state, playWhenReady, error, …
const { position, duration } = useProgress(player, 250); // seconds
```

Show the play/pause button from `status.playWhenReady`. It is the intent, so it does not flicker through a stall or a reconnect.

## Audio mode

`Audio.setAudioModeAsync` is global. RNAP's equivalents are per-player options, set once in the constructor ([configuration](configuration.md)).

| expo-av `AudioMode` | RNAP |
|---|---|
| `staysActiveInBackground: true` | nothing to call. Background playback is on; the iOS `audio` background mode comes from the plugin ([bare React Native](getting-started.md#bare-react-native)) |
| `playsInSilentModeIOS: true` | nothing to call: RNAP uses the iOS playback category, which plays with the ringer switch on silent |
| `interruptionModeIOS`, `interruptionModeAndroid`: `DoNotMix` | the default: RNAP holds audio focus and pauses on calls and other apps, then resumes |
| `...DuckOthers` | the system ducks for navigation prompts. `audio: { contentType: 'speech' }` pauses instead |
| `...MixWithOthers` | `audio: { mixWithOthers: true }`. It disables focus handling and, on iOS, the lock-screen controls |
| `shouldDuckAndroid` | handled by the system, see above |
| `playThroughEarpieceAndroid` | none |
| `allowsRecordingIOS` | none; RNAP does not record |

## Lock screen and remote controls

expo-av has none, so there is nothing to map and nothing to migrate: RNAP adds them. Pass a title, artist and artwork on the source, and RNAP shows them on the iOS lock screen and Control Center and in the Android media notification:

```ts
await player.load({
  uri: 'https://stream.example.com/live.mp3',
  metadata: { title: 'Example FM', artwork: 'https://example.com/logo.png' },
});
```

Play, pause, stop and seek from the lock screen, the notification, headsets and cars are handled natively and also work while JavaScript is frozen. To get next and previous, create the player with `new Player({ mediaSession: { commands: ['next', 'previous'] } })` and listen for `remoteCommand` ([lock screen](background-and-system.md#lock-screen-notification-and-hardware-controls)). For a live stream, the ICY title replaces your station title on the lock screen, as `useStreamMetadataForNowPlaying` is on by default.

If you built your own notification or foreground service around expo-av, delete it.

## The recovery code you can delete

Typical code written around expo-av for a stream:

```ts
// BEFORE
let sound: Audio.Sound | null = null;
let wantPlaying = false;
let attempt = 0;

async function start() {
  await sound?.unloadAsync();
  const created = await Audio.Sound.createAsync(
    { uri: STREAM_URL },
    { shouldPlay: true },
    onStatus
  );
  sound = created.sound;
}

function onStatus(status: AVPlaybackStatus) {
  if (!status.isLoaded) {
    if (status.error && wantPlaying) {
      setTimeout(start, Math.min(30_000, 1000 * 2 ** attempt++));   // backoff
    }
    return;
  }
  if (status.isPlaying) attempt = 0;
  if (status.didJustFinish && wantPlaying) start();                 // a live stream "ended"
}

NetInfo.addEventListener((s) => s.isConnected && wantPlaying && start());
AppState.addEventListener('change', (s) => s === 'active' && wantPlaying && start());
```

```ts
// AFTER
import { Player } from 'react-native-anything-player';

export const player = new Player();
await player.load(STREAM_URL, { autoplay: true });
```

You can delete the unload-and-recreate loop, the backoff timers, the `didJustFinish` reconnect (a live source does not "finish": the server closing the connection is reconnected as `STREAM_ENDED`), the `NetInfo` and `AppState` listeners, and `wantPlaying` (use `status.playWhenReady`). Keep an `error` listener for fatal errors only:

```ts
player.on('error', (error, { fatal }) => { if (fatal) showToast(error.message); });
```

## What differs or is missing

- **Recording** (`Audio.Recording`): out of scope. RNAP stays a player to stay small. Use `expo-audio` or `react-native-audio-api` for recording ([roadmap](roadmap.md#p2-—-platform-reach)).
- **Video** (the `Video` component): RNAP plays audio only. Use a video library for that.
- **Several `Sound` objects.** RNAP can run several players, but the lock screen shows the most recently started one ([several players](playback.md#several-players)). For short effects and UI clicks, RNAP has no API yet; a separate `Sound` API is [roadmap P1](roadmap.md#p1-—-the-features-people-search-for).
- **No queue.** expo-av never had one; if you built a playlist on top of it, the same pattern works: load the next item on `ended` ([details and limits](migrating-from-track-player.md#the-queue-is-the-big-difference)).
- **No looping, pan or pitch control.**
- **Seconds, not milliseconds.** Every position, duration and start offset.
- **`await` order.** Commands are applied in call order and their promises resolve after the status changed. `play()` rejects with `AUDIO_FOCUS_DENIED` during a call.
- **`downloadFirst`.** expo-av downloads a remote file before playing by default (`downloadFirst = true`). RNAP streams it. For offline playback, download the file yourself and load the `file://` URI.

## Full example: a radio screen

**Before (expo-av).**

```tsx
import { Audio, type AVPlaybackStatus } from 'expo-av';

export function RadioScreen() {
  const sound = useRef<Audio.Sound | null>(null);
  const [status, setStatus] = useState<AVPlaybackStatus | null>(null);

  useEffect(() => {
    Audio.setAudioModeAsync({ staysActiveInBackground: true, playsInSilentModeIOS: true });
    return () => { sound.current?.unloadAsync(); };
  }, []);

  const toggle = async () => {
    if (!sound.current) {
      const { sound: s } = await Audio.Sound.createAsync(
        { uri: 'https://stream.example.com/live.mp3' },
        { shouldPlay: true },
        setStatus
      );
      sound.current = s;
    } else if (status?.isLoaded && status.isPlaying) {
      await sound.current.pauseAsync();
    } else {
      await sound.current.playAsync();
    }
  };

  const playing = status?.isLoaded && status.isPlaying;
  return (
    <View>
      {status?.isLoaded && status.isBuffering && <ActivityIndicator />}
      <Button title={playing ? 'Pause' : 'Play'} onPress={toggle} />
    </View>
  );
}
```

The screen unmounting stops the audio, there is no lock screen, and there is no song title.

**After (RNAP).**

```ts
// player.ts
import { Player } from 'react-native-anything-player';

export const player = new Player();

export const station = {
  uri: 'https://stream.example.com/live.mp3',
  metadata: { title: 'Example FM', artwork: 'https://example.com/logo.png' },
};
```

```tsx
// RadioScreen.tsx
import { usePlayerStatus, useStreamMetadata } from 'react-native-anything-player';
import { player, station } from './player';

export function RadioScreen() {
  const status = usePlayerStatus(player);
  const meta = useStreamMetadata(player);
  const busy = ['loading', 'buffering', 'reconnecting'].includes(status.state);

  const onPress = async () => {
    if (status.state === 'idle') await player.load(station, { autoplay: true });
    else await player.toggle();
  };

  return (
    <View>
      <Text>{[meta?.artist, meta?.title].filter(Boolean).join(' - ')}</Text>
      {busy && <ActivityIndicator />}
      <Button title={status.playWhenReady ? 'Pause' : 'Play'} onPress={onPress} />
    </View>
  );
}
```

No audio-mode call, no unload on unmount, and nothing to wire for the lock screen. The audio keeps playing when the screen closes, and the lock screen shows the station, its logo and the current song.
