# Migrating from react-native-track-player

This guide moves an app from React Native Track Player (RNTP) to RNAP. It covers both generations:

- **RNTP 4**: the `react-native-track-player` package, version 4.1.2 (Apache-2.0).
- **RNTP 5**: the `@rntp/player` package, version 5.12.1 (commercial licence).

Both were read from their published npm packages. RNAP has **no native queue yet** ([roadmap, P0](roadmap.md#p0-—-adoption-blockers)). If your app plays playlists, read [the queue section](#the-queue-is-the-big-difference) before you start. For a single stream or station at a time, which is what RNAP is built for, the move is mostly deletions.

## Why switch

- **Recovery is native.** A dropped socket, a silent stall, a Wi-Fi ↔ cellular handoff and an outage are handled by the engine, also while JavaScript is frozen. RNTP leaves these to app code ([comparison](comparison.md#what-you-get-out-of-the-box)): RNTP 4 and 5 give you `retry()`, and the app decides when to call it. A search of both packages' sources finds no reconnect logic and no connectivity monitor.
- **Radio is first class.** ICY metadata is published when it is *heard*, repaired for charset, and shown on the lock screen. The song's length can drive the lock-screen progress bar ([internet radio](internet-radio.md)).
- **One engine on the web too.** `react-native-anything-player/web` runs the same `Player` API in Expo web, React Native Web and plain pages ([Web](web.md)).
- **No playback service.** Play, pause, stop and seek from the lock screen, headset and car work natively, so the JS service file goes away.

> **Licence.** RNTP 4 is Apache-2.0, which is free for any use. RNAP is PolyForm Noncommercial: free for personal, educational, non-profit and other noncommercial use, and it needs a commercial licence otherwise ([roadmap, P0 licence](roadmap.md#p0-—-adoption-blockers), [COMMERCIAL.md](../COMMERCIAL.md)). RNTP 5 is free only for personal and educational use, and its published price is €99 per month or €999 per year for one app ([Why RNAP](why.md#the-default-player-went-commercial)). Check which of these applies to you before you move.

## Install and setup

RNAP needs React Native 0.80 or later with the New Architecture, iOS 15.1+ and Android 7+ ([requirements](getting-started.md#requirements)). RNTP 5 itself needs RN 0.76 or later, so an app on 0.76–0.79 has to upgrade first.

```sh
npm uninstall react-native-track-player   # or @rntp/player
npm install react-native-anything-player
cd ios && pod install
```

RNAP is not on npm yet: until it is, install the release tarball ([Getting started](getting-started.md#install)).

| Step | RNTP 4 | RNTP 5 | RNAP |
|---|---|---|---|
| Playback service | `TrackPlayer.registerPlaybackService(() => service)` in `index.js` | `registerPlaybackSession(() => { … })` and `registerRemoteHandlers({ … })` in `index.js` | **Nothing.** Delete the service file and the registration |
| Create the player | `await TrackPlayer.setupPlayer(options)` once, in the foreground on Android | `TrackPlayer.setupPlayer(config)` (synchronous) | `export const player = new Player(options)` at module scope ([first player](getting-started.md#first-player)) |
| Capabilities | `TrackPlayer.updateOptions({ capabilities, … })` | `TrackPlayer.setCommands({ capabilities, … })` | `new Player({ mediaSession: { commands: [...] } })` |
| iOS background mode | `audio` in `UIBackgroundModes` | same | same: keep it, or let the Expo plugin add it |
| Expo | development build | development build | development build and `"plugins": ["react-native-anything-player"]` ([Expo](getting-started.md#expo)) |

You can create the `Player` at any time, also in the background: there is no "set up in the foreground" rule. Create it at module scope, not in a component, so it outlives screens.

The Android manifest entries (foreground service, wake lock, network state) come with the library ([bare React Native](getting-started.md#bare-react-native)). Remove the ones you added for RNTP only if nothing else uses them.

## API mapping

### Setup and sources

| RNTP 4 | RNTP 5 | RNAP |
|---|---|---|
| `setupPlayer(options)` | `setupPlayer(config)` | `new Player(options)` |
| `add(track)` + `skip(0)` for one item | `setMediaItem(item)` | `player.load(source, { autoplay? })` |
| `Track.url` | `MediaItem.url` | `Source.uri` (or a string, or `require('./a.mp3')`) |
| `Track.headers`, `Track.userAgent` | `url: { uri, headers }` | `Source.headers`, with `User-Agent` as a header |
| `Track.title`, `artist`, `album`, `artwork` | `title`, `artist`, `albumTitle`, `artworkUrl` | `Source.metadata: { title, artist, album, artwork }` |
| `Track.isLiveStream` (iOS only) | `MediaItem.isLive` | `Source.live` (optional: an indefinite duration is detected as live) |
| `Track.duration` | `MediaItem.duration` | none needed; `metadata.duration` sets a *song's* length on a live stream |
| `Track.type`, `contentType`, `mimeType` | `MediaItem.mimeType` | none; the platform sniffs the stream |
| `Track` extra fields, `extras` | `MediaItem.extras`, `mediaId` | none; keep them in your own state |
| `reset()` | `clear()` | `reset()` unloads the source (`idle`) |
| `destroy()` (not in 4) | `destroy()` | `player.release()` |

### Playback

| RNTP 4 | RNTP 5 | RNAP |
|---|---|---|
| `play()` | `play()` (returns nothing) | `await player.play()` |
| `pause()` | `pause()` | `await player.pause()` |
| `stop()` | `stop()` | `player.stop()`: releases network and decoder, **keeps the source**; `play()` re-opens it |
| `setPlayWhenReady(b)`, `getPlayWhenReady()` | – | `player.toggle()`, `player.status.playWhenReady` |
| `seekTo(s)` | `seekTo(s)` | `player.seekTo(s)`; rejects `NOT_SEEKABLE` on live |
| `seekBy(offset)` | `seekBy(offset)` | `player.seekTo(player.getProgress().position + offset)` |
| – | `seekToLiveEdge()` | `player.load(sameSource)`, or `play()` after a long pause: a live stream past the drift budget re-opens at the live edge |
| `setVolume(v)` / `getVolume()` | same | `player.setVolume(v)` / `player.status.volume`; also `setMuted(bool)` |
| `setRate(r)` / `getRate()` | `setPlaybackSpeed` / `getPlaybackSpeed` | `player.setRate(r)` / `player.status.rate` |
| `retry()` | `retry()` | `player.play()` from `error` retries. Recoverable failures retry by themselves |
| `getProgress()` (async) | `getProgress()` (sync) | `player.getProgress()`: synchronous |
| `getState()`, `getPlaybackState()` | `getPlaybackState()` | `player.state`, `player.status` |
| `updateNowPlayingMetadata(m)` | `updateMetadata(index, m)` | `player.updateNowPlaying(m)` |
| `updateMetadataForTrack(i, m)` | – | `player.updateNowPlaying(m)`: there is one source |
| `clearNowPlayingMetadata()` | – | `player.updateNowPlaying({})` |
| `minBuffer`, `maxBuffer`, `backBuffer`, `playBuffer` | – | none; the engine chooses (fast start for radio) |
| `maxCacheSize` (Android) | `cache: { maxSizeBytes, preloading }` | none yet ([cache is roadmap P1](roadmap.md#p1-—-the-features-people-search-for)) |
| `iosCategory*` options | – | none; RNAP configures the audio session itself |

### Queue

| RNTP 4 | RNTP 5 | RNAP |
|---|---|---|
| `add`, `setQueue`, `remove`, `move`, `removeUpcomingTracks`, `getQueue`, `getTrack` | `setMediaItems`, `addMediaItem(s)`, `insertMediaItem(s)`, `removeMediaItem(s)`, `moveMediaItem`, `replaceMediaItem`, `getQueue` | **No equivalent.** [See below](#the-queue-is-the-big-difference) |
| `skip(i)`, `skipToNext()`, `skipToPrevious()` | `skipToIndex`, `skipToNext`, `skipToPrevious` | `load()` the item you want |
| `setRepeatMode(RepeatMode.Off \| Track \| Queue)` | `setRepeatMode('off' \| 'one' \| 'all')`, `setShuffleEnabled` | none. Repeat one: `player.on('ended', () => player.play())` |
| – | `preload(item)`, `cancelPreload` | none |
| – | `sleepAfterTime`, `sleepAfterMediaItemAtIndex`, `cancelSleepTimer` | none yet ([sleep timer is roadmap P1](roadmap.md#p1-—-the-features-people-search-for)) |
| – | `setBrowseTree` (Android Auto, CarPlay) | none. [CarPlay / Android Auto browsing is next on the roadmap](roadmap.md#p2-—-platform-reach) |

## The queue is the big difference

RNAP plays **one source at a time**. A native queue (next and previous, gapless hand-off, repeat, shuffle, auto-advance while JS is frozen) is the top item on the [roadmap](roadmap.md#p0-—-adoption-blockers) and does not exist yet.

If your app is a radio with a station list, you do not need a queue: `load()` the next station and the playing player switches seamlessly. If it plays tracks in order, use this interim pattern. It loads the next item when the current one ends, and when the lock screen or headset asks for next or previous.

```ts
import { Player, type Source } from 'react-native-anything-player';

const items: Source[] = [/* … */];
let index = 0;

export const player = new Player({
  mediaSession: { commands: ['next', 'previous'] }, // show the buttons, forward the presses
});

export async function playIndex(i: number) {
  index = (i + items.length) % items.length;
  await player.load(items[index]!, { autoplay: true });
}

player.on('ended', () => void playIndex(index + 1)); // a file played to its end
player.on('remoteCommand', ({ command }) => {
  if (command === 'next') void playIndex(index + 1);
  if (command === 'previous') void playIndex(index - 1);
});
```

What this costs you compared with a queue:

- **It runs in JS.** On iOS it does not advance while JavaScript is suspended, so a screen-off playlist stops at the end of the current item. This is the limitation the roadmap names.
- **No gapless transition.** Each `load()` opens a source; there is a gap between items, and nothing is preloaded.
- **You own the list.** Index, shuffle and repeat live in your code. There is no `getQueue()` and no `PlaybackActiveTrackChanged` equivalent: `load()` resolves when the item is ready, and `status.loadId` increments on every load.

If gapless playback, or a playlist that keeps going with the screen off, is a requirement, wait for the native queue.

## Events and status

RNAP has one state machine and one snapshot, `player.status` ([events](events.md), [state model](playback.md#state-model)). Show the play/pause button from `status.playWhenReady` (the intent), not from `state`.

### States

| RNTP 4 `State` | RNTP 5 `PlaybackState` | RNAP `status.state` |
|---|---|---|
| `None` | `idle` | `idle` |
| `Loading` | – | `loading` |
| `Buffering` | `buffering` | `buffering`, also `reconnecting` while recovery runs |
| `Ready` | `ready` | `paused` (loaded, not playing) |
| `Playing` | `ready` + `isPlaying()` | `playing` |
| `Paused` | `ready` + not playing | `paused` |
| `Stopped` | – | `stopped` |
| `Ended` | `ended` | `ended` (a finite source played to its end) |
| `Error`, with an `error` field on the state | `error` | `error`, with `status.error: { code, message, recoverable, … }` |

### Events

| RNTP 4 `Event` | RNTP 5 `Event` | RNAP |
|---|---|---|
| `PlaybackState` | `PlaybackStateChanged` | `player.on('stateChange', (state, previous) => …)` or `'status'` |
| – | `IsPlayingChanged` | `status.state === 'playing'` |
| `PlaybackPlayWhenReadyChanged` | – | `status.playWhenReady` in the `'status'` event |
| `PlaybackError`, `PlayerError` | `PlaybackError` | `player.on('error', (error, { fatal }) => …)`. `fatal: false` means recovery is running |
| `PlaybackQueueEnded` | – | `player.on('ended', …)` |
| `PlaybackActiveTrackChanged`, `PlaybackTrackChanged` | `MediaItemTransition`, `QueueChanged` | none (no queue). `status.loadId` changes on each `load()` |
| `PlaybackMetadataReceived`, `MetadataCommonReceived`, `MetadataTimedReceived`, `MetadataChapterReceived` | `MetadataReceived`, `MediaMetadataChanged` | `player.on('metadata', (m) => …)`: `m.title`, `m.artist`, `m.station`, `m.genre`, `m.raw` |
| `PlaybackProgressUpdated` (`updateOptions({ progressUpdateEventInterval })`, seconds) | `PlaybackProgressUpdated` | `progress` event with `new Player({ progressInterval })` in **milliseconds**. For a UI, call `getProgress()` instead |
| `RemoteDuck` | – | none. The engine pauses and resumes itself; read `status.interruption` ([interruptions](background-and-system.md#audio-focus-and-interruptions)) |
| – | `SleepTimerTriggered`, `BrowseRefreshRequested` | none |

PlaybackError codes map to `status.error.code`. RNTP 5's `network` is `NETWORK_ERROR`, `NETWORK_UNAVAILABLE`, `TIMEOUT` or `HTTP_ERROR`; `source` is `SOURCE_NOT_FOUND`, `UNSUPPORTED_FORMAT` or `INVALID_SOURCE`; `renderer` is `DECODER_ERROR`; `play-not-permitted` is `AUTOPLAY_BLOCKED`. The [error table](errors.md) says which ones the engine retries.

### Hooks

| RNTP 4 | RNTP 5 | RNAP |
|---|---|---|
| `usePlaybackState()` returns `{ state }`, `undefined` at first | `usePlaybackState()` returns the state | `usePlaybackState(player)` returns a `PlaybackState`, never `undefined` |
| `useIsPlaying()` returns `{ playing, bufferingDuringPlay }` | `useIsPlaying()` returns a boolean | `usePlayerStatus(player)`: `status.playWhenReady`, and a spinner for `loading`, `buffering` or `reconnecting` |
| `usePlayWhenReady()` | – | `usePlayerStatus(player).playWhenReady` |
| `useProgress(ms)` returns `{ position, duration, buffered }` | `useProgress(seconds)` | `useProgress(player, ms)` returns `position`, `duration` (`null` for live), `buffered`, `bufferedAhead`, `liveOffset` |
| `useActiveTrack()` | `useActiveMediaItem()` | `useStreamMetadata(player)` for the current ICY title; for the rest, your own state |
| `useTrackPlayerEvents(events, handler)` | `addEventListener` | `usePlayerEvent(player, 'metadata', handler)` |
| `useAppIsInBackground()` | – | none; use React Native's `AppState` |

RNAP's hooks take the `player` as their first argument, because players are objects you create. They read native state synchronously, so there is no `undefined` first render.

## Lock screen, remote controls and capabilities

RNAP shows the lock screen and notification for any player with `mediaSession.enabled` (the default). Play, pause, stop and seek are handled natively and always on. The other buttons are opt-in.

| RNTP | RNAP |
|---|---|
| `Capability.Play`, `Pause`, `Stop`, `SeekTo` | always on; seek only for seekable sources |
| `Capability.SkipToNext`, `SkipToPrevious` | `mediaSession.commands: ['next', 'previous']`; presses arrive as `remoteCommand` |
| `Capability.JumpForward`, `JumpBackward` | `commands: ['skipForward', 'skipBackward']`; you do the seek in the handler |
| `forwardJumpInterval`, `backwardJumpInterval` | none; the interval is whatever your handler seeks by |
| RNTP 5 `forwardInterval`, `backwardInterval` | same: your handler decides |
| `Event.RemotePlay`, `RemotePause`, `RemoteStop`, `RemoteSeek` handlers | **delete.** Handled natively, also while JS is frozen |
| `Event.RemoteNext`, `RemotePrevious` | `player.on('remoteCommand', …)` with `command: 'next' \| 'previous'` |
| RNTP 5 `registerRemoteHandlers({ play, pause, … })` | native handling needs no registration; `remoteCommand` for the extra buttons |
| `Capability.PlayFromId`, `PlayFromSearch`, `Event.RemotePlayId`, `RemotePlaySearch` | [voice assistants](voice.md): `setCatalog()` and the `searchPlay` event |
| `Capability.SetRating`, `Like`, `Dislike`, `Bookmark`, `ratingType`, `likeOptions` … | none |
| `icon`, `playIcon`, `pauseIcon`, `color` (Android notification styling) | none |
| `android.appKilledPlaybackBehavior` (RNTP 4), `android.taskRemovedBehavior` (RNTP 5) | `android: { stopOnTaskRemoved }` (default `false`, i.e. keep playing) |
| `autoUpdateMetadata`, `autoUpdateMetadataFromStream` | `metadata: { useStreamMetadataForNowPlaying }` (default `true`) |
| `autoHandleInterruptions`, `handleAudioBecomingNoisy` | always on. A call or another app pauses and resumes by itself; unplugging headphones pauses. `interruptions.autoResume: false` to stop resuming |
| `androidAudioContentType`, `contentType` | `audio: { contentType: 'music' \| 'speech' }` |
| RNTP 5 `audioMixing: 'mix'` | `audio: { mixWithOthers: true }` (on iOS this removes lock-screen controls) |
| RNTP 5 `cast` | `cast` option of the Expo plugin; [Casting & AirPlay](routes-and-casting.md) |

What the lock screen shows is built from your `Source.metadata`, the stream's ICY metadata and `updateNowPlaying()`, in that order of precedence ([details](background-and-system.md#what-the-lock-screen-shows)). A radio has no queue to feed `updateMetadataForTrack`: let ICY drive it, or call `updateNowPlaying()` when you know more.

## The recovery code you can delete

Typical RNTP radio code, written because the player does not reconnect:

```ts
// BEFORE: keep a stream alive by hand
import NetInfo from '@react-native-community/netinfo';
import { AppState } from 'react-native';
import TrackPlayer, { Event, State } from 'react-native-track-player';

let wantPlaying = false;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let attempt = 0;

async function reconnect() {
  clearTimeout(retryTimer);
  try {
    await TrackPlayer.reset();
    await TrackPlayer.add(station);
    await TrackPlayer.play();
    attempt = 0;
  } catch {
    retryTimer = setTimeout(reconnect, Math.min(30_000, 1000 * 2 ** attempt++));
  }
}

TrackPlayer.addEventListener(Event.PlaybackError, () => wantPlaying && reconnect());
TrackPlayer.addEventListener(Event.PlaybackState, async ({ state }) => {
  if (state === State.Ended || state === State.Stopped) wantPlaying && reconnect();
});
TrackPlayer.addEventListener(Event.RemoteDuck, async ({ paused, permanent }) => {
  if (permanent) { wantPlaying = false; await TrackPlayer.pause(); }
  else if (paused) await TrackPlayer.pause();
  else if (wantPlaying) await TrackPlayer.play();
});
NetInfo.addEventListener((s) => s.isConnected && wantPlaying && reconnect());
AppState.addEventListener('change', (s) => s === 'active' && wantPlaying && reconnect());
setInterval(async () => {               // buffering watchdog
  if (wantPlaying && (await TrackPlayer.getPlaybackState()).state === State.Buffering) reconnect();
}, 15_000);
```

```ts
// AFTER: all of it is the engine's job
import { Player } from 'react-native-anything-player';

export const player = new Player();
await player.load(station, { autoplay: true });
// reconnects, backoff, offline probing, handoffs, calls and focus: handled natively
```

You can delete:

- the `NetInfo` listener, the `AppState` listener and the buffering watchdog (the engine detects dead sockets and silent stalls itself, [recovery policy](recovery.md));
- the backoff and retry timers (jittered exponential backoff, reset after 10 s of stable playback);
- the `RemoteDuck` handler (interruptions resume on their own, never against the user's pause);
- the `reset()` + `add()` + `play()` reconnect dance (a live source re-opens at the live edge);
- `wantPlaying` bookkeeping: `status.playWhenReady` is that flag, kept natively.

Keep one thing: an `error` listener for **fatal** errors (a 404, an unsupported format), to tell the user. Check `fatal` first:

```ts
player.on('error', (error, { fatal }) => {
  if (fatal) showToast(error.message);
});
```

## What differs or is missing

- **No queue** (above), so no `skipToNext`, repeat modes, shuffle or `getQueue()`.
- **No cache, preload, sleep timer, progress sync, Android Auto or CarPlay browse tree.** RNTP 5 has them; on the RNAP roadmap are the [cache and sleep timer (P1)](roadmap.md#p1-—-the-features-people-search-for) and [car browsing (P2)](roadmap.md#p2-—-platform-reach).
- **No ratings, like, dislike or bookmark** buttons, and no custom notification icons.
- **`stop()` is not `reset()`.** RNAP's `stop()` keeps the source so `play()` can restart it; use `reset()` to unload.
- **Time units.** RNAP positions are seconds and its hook interval is milliseconds. RNTP 5's `useProgress` takes seconds.
- **Async everywhere.** Commands return promises that resolve after the status changed, and they reject with a [`PlayerError`](errors.md).
- **No `setupPlayer` ordering rule.** Nothing needs to be awaited before the first command; commands are applied in call order.
- **New Architecture only**, React Native 0.80 or later.

## Full example: a radio screen

**Before (RNTP 4).**

```ts
// index.js
import TrackPlayer from 'react-native-track-player';
import App from './App';
TrackPlayer.registerPlaybackService(() => require('./service'));
AppRegistry.registerComponent('app', () => App);

// service.ts
import TrackPlayer, { Event } from 'react-native-track-player';
module.exports = async function () {
  TrackPlayer.addEventListener(Event.RemotePlay, () => TrackPlayer.play());
  TrackPlayer.addEventListener(Event.RemotePause, () => TrackPlayer.pause());
  TrackPlayer.addEventListener(Event.RemoteStop, () => TrackPlayer.stop());
};
```

```tsx
// RadioScreen.tsx
import { useState } from 'react';
import TrackPlayer, {
  Capability, Event, useIsPlaying, useTrackPlayerEvents,
} from 'react-native-track-player';

export async function setup() {
  await TrackPlayer.setupPlayer();
  await TrackPlayer.updateOptions({ capabilities: [Capability.Play, Capability.Pause] });
  await TrackPlayer.add({
    url: 'https://stream.example.com/live.mp3',
    title: 'Example FM',
    artwork: 'https://example.com/logo.png',
    isLiveStream: true,
  });
}

export function RadioScreen() {
  const { playing, bufferingDuringPlay } = useIsPlaying();
  const [song, setSong] = useState('');
  useTrackPlayerEvents([Event.PlaybackMetadataReceived], ({ artist, title }) =>
    setSong([artist, title].filter(Boolean).join(' - '))
  );
  return (
    <View>
      <Text>{song}</Text>
      {bufferingDuringPlay && <ActivityIndicator />}
      <Button
        title={playing ? 'Pause' : 'Play'}
        onPress={() => (playing ? TrackPlayer.pause() : TrackPlayer.play())}
      />
    </View>
  );
}
```

**After (RNAP).** No service file, no `index.js` change, no setup function.

```tsx
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
import {
  usePlayerStatus, useStreamMetadata,
} from 'react-native-anything-player';
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

The lock screen shows the station name and logo from `metadata`, then the song from the stream. Play, pause and stop from the lock screen, a headset or a car work with JavaScript frozen. If you also want next and previous (a station list), create the player with `mediaSession: { commands: ['next', 'previous'] }` and switch stations in a `remoteCommand` listener.
