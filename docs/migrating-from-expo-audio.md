# Migrating from expo-audio

This guide moves an app from `expo-audio` to RNAP. It was written against `expo-audio` 58.0.10, read from its published npm package.

RNAP is a player. It does not record, so keep `expo-audio` for recording if you need it ([below](#what-differs-or-is-missing)).

## Why switch

- **Streams recover by themselves.** expo-audio exposes `error` in its status and leaves the rest to you. A search of its sources finds no reconnect logic and no connectivity monitor. RNAP detects dead sockets and silent stalls, backs off, probes while offline and re-opens at the live edge, natively ([recovery policy](recovery.md)).
- **Radio metadata.** expo-audio's player events are `playbackStatusUpdate` and `audioSampleUpdate`; there is no stream-metadata event. RNAP publishes ICY title, artist, station and genre when they are *heard* ([internet radio](internet-radio.md)).
- **Lock-screen controls without bookkeeping.** In expo-audio you call `setActiveForLockScreen` for one player, and `interruptionMode` has to be `doNotMix` or `doNotMixPersistent` for it to work. In RNAP the lock screen, notification and headset controls are on by default.
- **Same API on the web.** `react-native-anything-player/web` runs the `Player` API in Expo web, React Native Web and plain pages ([Web](web.md)).

> **Licence.** expo-audio is MIT. RNAP is PolyForm Noncommercial: free for personal, educational, non-profit and other noncommercial use, and it needs a commercial licence otherwise ([roadmap, P0 licence](roadmap.md#p0-—-adoption-blockers), [COMMERCIAL.md](../COMMERCIAL.md)). Check which applies to you before you move.

## Install and setup

RNAP is a TurboModule that needs React Native 0.80 or later with the New Architecture, and an Expo development build ([requirements](getting-started.md#requirements)). It does not need the `expo` package; the Expo config plugin is the only Expo part.

```sh
npm uninstall expo-audio            # only if you do not record
npm install react-native-anything-player
```

RNAP is not on npm yet: until it is, install the release tarball ([Getting started](getting-started.md#install)).

```diff
 // app.json
 {
   "expo": {
     "plugins": [
-      ["expo-audio", { "enableBackgroundPlayback": true }]
+      "react-native-anything-player"
     ]
   }
 }
```

| expo-audio plugin option | RNAP |
|---|---|
| `enableBackgroundPlayback` (default `true`): `audio` background mode, foreground service | `backgroundAudio` (default `true`): the iOS `audio` background mode. The Android service is part of the library |
| `microphonePermission`, `recordAudioAndroid`, `enableBackgroundRecording` | none. RNAP does not record. Keep the `expo-audio` plugin if you do |

Then rebuild (`npx expo run:ios`, `npx expo run:android` or EAS Build). In Expo Go, `new Player()` throws `NATIVE_MODULE_MISSING` with the steps ([Expo Go](getting-started.md#expo-go)).

The call to `setAudioModeAsync({ shouldPlayInBackground: true, interruptionMode: 'doNotMix' })` goes away. RNAP's defaults already hold audio focus, play in the background, and play with the ringer switch on silent (it uses the iOS playback category).

## The mental model changes

`useAudioPlayer(source)` creates a player tied to a component and releases it when the component unmounts. RNAP players are created once, at module scope, and keep playing when screens unmount:

```ts
// player.ts
import { Player } from 'react-native-anything-player';
export const player = new Player();
```

```tsx
// any component
import { usePlayerStatus } from 'react-native-anything-player';
import { player } from './player';
const status = usePlayerStatus(player);
```

Call `player.release()` only when you are done with it for good.

## API mapping

| expo-audio | RNAP |
|---|---|
| `useAudioPlayer(source, options)` | `new Player(options)` at module scope, then `player.load(source)` |
| `createAudioPlayer(source, options)` | `new Player(options)`, then `player.load(source)` |
| `AudioSource`: string, `require()` number, `{ uri, assetId, headers, name }` | `SourceInput`: string, `require()` number, or `{ uri, headers, live, metadata }` |
| `player.play()`, `player.pause()` (synchronous) | `await player.play()`, `await player.pause()`; `player.toggle()` |
| `player.replace(source)` | `player.load(source)`. A playing player keeps playing the new source |
| `player.seekTo(seconds, toleranceBefore, toleranceAfter)` | `player.seekTo(seconds)` (no tolerance arguments); rejects `NOT_SEEKABLE` on live |
| `player.volume = v` | `player.setVolume(v)` |
| `player.muted = true` | `player.setMuted(true)` |
| `player.loop = true` | none. `player.on('ended', () => player.play())` restarts a finished file |
| `player.setPlaybackRate(rate, quality)` | `player.setRate(rate)`; there is no pitch-correction option |
| `player.currentTime`, `player.duration` | `player.getProgress().position`, `.duration` (`null` for live or unknown, where expo-audio gives `0`) |
| `player.playing`, `player.paused` | `status.state === 'playing'`, `status.playWhenReady` |
| `player.isBuffering`, `player.isLoaded` | `status.state` is `loading`, `buffering` or `reconnecting`; `status.state !== 'idle'` |
| `player.remove()` | `player.release()` |
| `options.updateInterval` | `useProgress(player, ms)` (default 1000 ms); `progressInterval` for native `progress` events |
| `options.downloadFirst` | none; the file is streamed. Download it yourself and pass the `file://` URI |
| `options.preferredForwardBufferDuration` | none; the engine chooses |
| `options.keepAudioSessionActive`, `setIsAudioActiveAsync(bool)` | none; the audio session follows playback |
| `options.allowsExternalPlayback` (AirPlay) | [`<RoutePicker />`](routes-and-casting.md) and `status.route` |
| `preload(source)`, `clearPreloadedSource` | none yet ([cache and preload are roadmap P1](roadmap.md#p1-—-the-features-people-search-for)) |
| `useAudioPlaylist`, `createAudioPlaylist`, `playlist.next()`, `previous()`, `skipTo()`, `add()`, `insert()`, `remove()`, `loop: 'all'` | **No equivalent: RNAP has no native queue yet.** The pattern is in the [track-player guide](migrating-from-track-player.md#the-queue-is-the-big-difference) |
| `useAudioSampleListener(player, fn)`, `setAudioSamplingEnabled` | `player.setAudioSampling({ enabled: true })` and the `audioSample` event ([visualizer](visualizer.md)) |
| `useAudioStream`, `useAudioRecorder`, `useAudioRecorderState`, permission functions | none: recording is [out of scope](roadmap.md#p2-—-platform-reach) |

## Status and events

`useAudioPlayerStatus(player)` returns an `AudioStatus`. The RNAP equivalent is `usePlayerStatus(player)`, which returns a `PlayerStatus` ([status](events.md#status)).

| expo-audio `AudioStatus` | RNAP |
|---|---|
| `playing` | `status.state === 'playing'` |
| `isBuffering` | `status.state === 'buffering'`, `'loading'` or `'reconnecting'` |
| `isLoaded` | `status.state !== 'idle'` |
| `currentTime`, `duration` | `getProgress()` or `useProgress(player, ms)` |
| `didJustFinish` | `player.on('ended', …)`, or `status.state === 'ended'` |
| `error: string \| null` | `status.error: { code, message, recoverable, … }` or the `error` event ([errors](errors.md)) |
| `isLive` | `status.isLive` |
| `currentOffsetFromLive` | `getProgress().liveOffset` (`null` when it cannot be measured; use `bufferedAhead`) |
| `playbackRate` | `status.rate` |
| `mute` | `status.muted` |
| `loop` | none |
| `playbackState`, `timeControlStatus`, `reasonForWaitingToPlay` (strings) | `status.state` and `status.interruption` ([state model](playback.md#state-model)) |
| `mediaServicesDidReset` | none needed: RNAP rebuilds its players and re-opens what was loaded ([iOS media services reset](background-and-system.md#ios-media-services-reset)) |

Show the play/pause button from `status.playWhenReady`: it is the intent, so it does not flicker through a stall or a reconnect.

Events you gain, with no expo-audio counterpart: `metadata` (ICY, ID3), `error` with `{ fatal }`, `stateChange`, `remoteCommand`, `routeChange`, `discontinuity`, `searchPlay` ([events](events.md#events)).

## Lock screen and remote controls

| expo-audio | RNAP |
|---|---|
| `player.setActiveForLockScreen(true, { title, artist, albumTitle, artworkUrl }, options)` | on by default. Put `metadata: { title, artist, album, artwork }` on the `Source`, or call `player.updateNowPlaying({ … })` |
| `player.updateLockScreenMetadata(metadata)` | `player.updateNowPlaying(metadata)` |
| `player.clearLockScreenControls()` | `new Player({ mediaSession: { enabled: false } })`, or `player.updateNowPlaying({})` to clear overrides |
| `AudioLockScreenOptions.isLiveStream` | automatic: an indefinite duration is live. `updateNowPlaying({ live: false })` removes the badge between songs |
| `showNextTrack`, `showPreviousTrack`, `showSeekForward`, `showSeekBackward` | `mediaSession: { commands: ['next', 'previous', 'skipForward', 'skipBackward'] }`; presses arrive as `remoteCommand` events |
| `seekForwardIntervalSeconds`, `seekBackwardIntervalSeconds` | none; your `remoteCommand` handler seeks by whatever it likes |
| `interruptionMode` must be `doNotMix` for the lock screen | no such rule |
| `interruptionMode: 'duckOthers'` | the system ducks for navigation prompts. `audio: { contentType: 'speech' }` pauses instead |
| `interruptionMode: 'mixWithOthers'` | `audio: { mixWithOthers: true }`. On iOS this also removes the lock-screen controls |
| `playsInSilentMode`, `shouldRouteThroughEarpiece`, `allowsRecording` | none; RNAP configures the audio session itself and does not record |

The expo-audio types expose no event for a next or previous press on a single player. In RNAP, play, pause, stop and seek from the lock screen are handled natively, and the extra buttons you enable are delivered to JS:

```ts
const player = new Player({ mediaSession: { commands: ['next', 'previous'] } });
player.on('remoteCommand', ({ command }) => {
  if (command === 'next') playNextStation();
});
```

## The recovery code you can delete

Typical code written around expo-audio for a stream:

```tsx
// BEFORE
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import NetInfo from '@react-native-community/netinfo';

const player = useAudioPlayer(STREAM_URL);
const status = useAudioPlayerStatus(player);
const wantPlaying = useRef(false);

const restart = useCallback(() => {
  player.replace(STREAM_URL);                // re-open the stream
  player.play();
}, [player]);

useEffect(() => {
  if (wantPlaying.current && status.error) {
    const t = setTimeout(restart, 3000);     // retry timer
    return () => clearTimeout(t);
  }
}, [status.error, restart]);

useEffect(() => {
  const unsub = NetInfo.addEventListener((s) => s.isConnected && wantPlaying.current && restart());
  const sub = AppState.addEventListener('change', (s) => s === 'active' && wantPlaying.current && !status.playing && restart());
  return () => { unsub(); sub.remove(); };
}, [restart, status.playing]);
```

```ts
// AFTER
import { Player } from 'react-native-anything-player';
export const player = new Player();
await player.load(STREAM_URL, { autoplay: true });
```

You can delete the retry timer, the `NetInfo` and `AppState` listeners, the `wantPlaying` ref (use `status.playWhenReady`) and the `replace()` + `play()` restart. A phone call or another app no longer leaves the player silent: the engine resumes when the system gives audio back, unless the user paused ([interruptions](background-and-system.md#audio-focus-and-interruptions)). Keep an `error` listener for fatal errors only:

```ts
player.on('error', (error, { fatal }) => { if (fatal) showToast(error.message); });
```

## What differs or is missing

- **Playlists.** `AudioPlaylist` has no RNAP counterpart yet; a native queue is the top roadmap item ([P0](roadmap.md#p0-—-adoption-blockers)). Until then, load the next item on `ended`. On iOS that does not run while JS is suspended, and there is no gapless transition.
- **Recording** (`useAudioRecorder`, `AudioRecorder`, `useAudioStream`, microphone permissions): out of scope. RNAP stays a player to stay small ([roadmap](roadmap.md#p2-—-platform-reach)). Keep `expo-audio` for it. Both can be installed, but only RNAP should own playback; do not use expo-audio players for the same audio, because both would compete for audio focus.
- **Looping** a single file: restart it from the `ended` event.
- **Pitch correction, `downloadFirst`, preload:** no counterpart.
- **Lifecycle.** expo-audio's hook releases the player on unmount; RNAP's `Player` lives until `release()`.
- **Async commands.** `play()` and `pause()` return promises that resolve after the status changed, and reject with a [`PlayerError`](errors.md). `play()` rejects with `AUDIO_FOCUS_DENIED` during a call.
- **Units.** Both use seconds for positions. RNAP's hook interval is milliseconds, as expo-audio's `updateInterval` is.
- **No `expo` package required.** RNAP has no JS dependencies; `expo-audio` itself needs `expo` and `expo-asset`.

## Full example: a radio screen

**Before (expo-audio).**

```tsx
import { useAudioPlayer, useAudioPlayerStatus, setAudioModeAsync } from 'expo-audio';

const STREAM = 'https://stream.example.com/live.mp3';

export function RadioScreen() {
  const player = useAudioPlayer(STREAM);
  const status = useAudioPlayerStatus(player);

  useEffect(() => {
    setAudioModeAsync({ playsInSilentMode: true, shouldPlayInBackground: true, interruptionMode: 'doNotMix' });
  }, []);

  const toggle = () => {
    if (status.playing) {
      player.pause();
      player.clearLockScreenControls();
    } else {
      player.setActiveForLockScreen(true, { title: 'Example FM', artworkUrl: 'https://example.com/logo.png' }, { isLiveStream: true });
      player.play();
    }
  };

  return (
    <View>
      {status.isBuffering && <ActivityIndicator />}
      <Button title={status.playing ? 'Pause' : 'Play'} onPress={toggle} />
    </View>
  );
}
```

There is no title of the song here, because expo-audio does not publish stream metadata.

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

No audio-mode call and no lock-screen calls: the lock screen shows the station, its logo and the current song, and its play and pause buttons work while JavaScript is frozen.
