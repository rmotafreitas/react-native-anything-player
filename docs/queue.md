# Queue and playlists

A player's queue is the list of what plays after the current item: next and previous, repeat and shuffle, and the next item started without a gap. The engine runs it, natively on iOS and Android and in the web engine in a browser. It keeps advancing, skipping and repeating while JavaScript is frozen in the background, and the lock screen, notification, headset, car and watch buttons drive it directly.

Every source RNAP plays can be a queue item: files over HTTP in any container, local files, `require()` assets, HLS, DASH, live streams and internet radio, separate quality files (`renditions`), audio or video, and on the web a `File` or `Blob`.

```ts
import { Player } from 'react-native-anything-player';

const player = new Player();

await player.queue.set(
  [
    { id: 'ep1', uri: 'https://cdn.example/ep1.mp3', metadata: { title: 'Episode 1', artist: 'The Show' } },
    { id: 'ep2', uri: 'https://cdn.example/ep2.m4a', metadata: { title: 'Episode 2' } },
    'https://cdn.example/bonus.flac',                      // id: 'q1'
    { uri: 'https://radio.example/live', live: true },     // a station can sit in a queue too
  ],
  { startIndex: 0, autoplay: true }
);
```

## Commands

| | |
|---|---|
| `queue.set(items, { startIndex, startPosition, autoplay })` | Replaces the queue and loads `startIndex` (an empty list unloads the player). |
| `queue.add(items, { index })` | Inserts at `index`, by default at the end. The current item plays on. |
| `queue.remove(target)` | By id, by index, or a list of either. When the current item goes, the next one loads and keeps the play intent; removing every item unloads the player. |
| `queue.move(from, to)` | Reorders by index. The current item stays current. |
| `queue.clear()` | Removes every item but the current one. |
| `queue.skipTo(target, { position })` | Plays the item with that id (or at that index), from `position` seconds. |
| `queue.next()` | The next item; with repeat `all`, the first after the last. Nothing happens at the end. |
| `queue.previous()` | More than 3 s into a finite item: restarts it. Otherwise the item before (with repeat `all`, the last before the first; at the first item, a restart). A live item is never restarted. |
| `queue.setRepeat('off' \| 'one' \| 'all')` | `one` loops the current item seamlessly (the same loop as `setLoop`, kept apart from it); `all` wraps. |
| `queue.setShuffle(enabled)` | Shuffled: the current item first, then the rest in random order. Items added later land at random places after the current one. Turning it off plays on in list order from the current item. |

An item is any source plus an optional `id` (default `q1`, `q2`…; unique in the queue). Ids are what `remove`, `skipTo` and events use, because indexes shift with edits.

`player.load(source)` replaces the queue: what plays is no longer a queue item, so a radio app that never uses the queue keeps getting next and previous as `remoteCommand` events. `queue.add()` after a plain `load()` makes the loaded source the first item. `player.reset()` empties the queue.

## State

```ts
player.queue.items;     // QueueItem[]: the items as you gave them, with their ids
player.queue.index;     // the current item's place in items, null when empty
player.queue.current;   // the current item
player.queue.repeat;    // 'off' | 'one' | 'all'
player.queue.shuffle;   // boolean
player.queue.state;     // all of the above, and `order`: the ids in the order they play

player.on('queueChange', (state) => {
  // the items, order, current item, repeat or shuffle changed,
  // including when the engine moved on by itself
});
```

A queue item becomes current when the previous one ends, on a skip, or when an item fails (below). From then on, its own `metadata` is on the lock screen and its `refresh`, DRM `getLicense` and `thumbnails` answer for it.

## Advancing

When a finite item ends, the next one starts at once: no `ended` event and no `ended` state in between. `ended` fires once, when the last item ends with repeat `off`. The index stays on that item, and `play()` starts it again.

The next item is **prepared** behind the current one: opened and buffered once the current item has played for 2 s (or a quarter of a shorter item). It starts without a network wait:

| | How the next item starts |
|---|---|
| Android | In ExoPlayer's playlist: gapless, with the encoder delay and padding trimmed (LAME, iTunes headers). |
| iOS | On a second AVPlayer, opened and buffered, started when the current item ends: near-gapless (a few milliseconds), not sample-exact. |
| Web | On a second `<audio>` / `<video>` element, started when the current one ends: near-gapless. In Safari and on iPhone and iPad, the second element can play once the page has had a tap on a control that calls the player (before that, the next item opens on the element in use, after the current one ends). |
| Cast | The receiver plays one item at a time: the next one loads on it when the current one ends (a short gap). |

Not prepared, and opened when its turn comes: live items (opening a station counts as a listener), items with `renditions` or DRM, and anything while the player loops or casts. A live item never ends, so the queue only moves off it by a skip.

## Errors

An item that fails on its own (`SOURCE_NOT_FOUND`, `UNSUPPORTED_FORMAT`, `DECODER_ERROR`, `INVALID_SOURCE`, `DRM_UNSUPPORTED`, `DRM_LICENSE_FAILED`, or `HTTP_ERROR` with a 4xx status) reports its `error` (fatal, with the `error` state) and the queue goes on to the next item. A 401 or 403 on an item with `refresh` asks for a new URL first. When every item has failed in a row, the queue stops on the last error.

A network failure never skips an item: the usual [recovery](recovery.md) reconnects to it.

## Lock screen, notification, headset, car

While the queue has items, the next and previous buttons are shown and handled natively: they work while JavaScript is frozen, and they are no longer forwarded as `remoteCommand` events. With an empty queue, `mediaSession.commands` works as before.

## While JavaScript is frozen

The engine advances, skips failed items, repeats and answers the buttons without JavaScript. What needs JavaScript waits for it:

- `refresh` (a signed URL): an item whose URL expired fails its open with 401/403, and the engine retries it with backoff until JavaScript answers, as for a single source. Give queue items a long enough expiry.
- Subtitle files (`subtitles`) of a queue item are not loaded when the item becomes current; add them with `addSubtitles` from a `queueChange` listener.

## Playlist files

```ts
import { Playlists } from 'react-native-anything-player';

const items = await Playlists.fetch('https://cdn.example/mix.m3u');
await player.queue.set(items);

Playlists.parse(text, { baseUrl, format });   // 'm3u' | 'pls' | 'xspf', detected by default
Playlists.isPlaylistUri(url);
```

- **M3U and extended M3U:** `#EXTINF` length and `Artist - Title`, `tvg-logo`, `#EXTIMG`, `#EXTALB`, `#EXTVLCOPT:http-user-agent`.
- **PLS:** `File1`, `Title1`, `Length1`, in their numbers' order.
- **XSPF:** `location`, `title`, `creator`, `album`, `image`, `duration`.

Relative entries resolve against the file's URL. An entry with a length of `-1` is `live`. An `.m3u8` that is an HLS playlist is one item, the stream itself.

A `.pls`, `.m3u` or `.xspf` URL given to `load()` or a queue (a radio station's `listen.pls`) plays its first entry, with the source's own `metadata` on top. The source's `headers` (a token) are sent to the playlist and, only when the entry is on the same host, to the entry. A playlist fetched over HTTP(S) names only HTTP(S) entries: one pointing at a file on the device is left out. Resolving a playlist file runs in JavaScript: give a voice-catalog item the stream's own URL.

## Not in this version

A queue saved on the device and restored after a restart (`queue.items` and `queue.state` are plain data you can store and give back to `set()`), saved playlists, a queue run by the Cast receiver, and crossfades between items.
