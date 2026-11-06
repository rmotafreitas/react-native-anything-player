# Queue, playlists, preload and cache: design

Status: **design, reviewed by the council (round 1: Sonnet 6.5, GLM 7); being built in two pull requests: (A) queue and playlists, (B) cache, preload and offline.** Covers the roadmap rows **Queue** (P0) and **Cache & preload** (P1), plus playlists and offline replay. Every part works for every source RNAP plays (local files, HTTP files in any container, HLS, DASH, ICY/Icecast and other live streams, audio and video) on iOS, Android, Expo web, React Native Web, React and plain pages, except where a source's nature rules it out; those limits are listed, not hidden.

## Principles

- **Native owns it.** The queue advances, the next item preloads, remote next/previous work, and the cache serves bytes while JavaScript is frozen. JS sends commands and mirrors snapshots, as for `Player`.
- **Opt-in by use.** A radio app that never touches `player.queue` or `Cache` pays nothing: no extra connection, no disk, no listener counted.
- **One specification.** The queue's decisions (what is next, what previous does, shuffle order, edits around the current item) are a pure model with TypeScript, Kotlin and Swift twins held to `conformance/queue`. The engine's new hooks (next item, preload, advance) join the engine's conformance scenarios.
- **Live is not a file.** A live stream never ends, so it never auto-advances, is never preloaded (a `GET` counts as a listener, #101) and is never cached (replaying a live stream is recording, which is out of scope). It can sit in a queue and be skipped to.

## 1. Queue

### API

```ts
const player = new Player();

await player.queue.set(
  [
    { id: 'ep1', uri: 'https://cdn.example/ep1.mp3', metadata: { title: 'Episode 1' } },
    { uri: 'file:///…/song.flac' },
    { uri: 'https://radio.example/live', live: true },
    { renditions: [{ uri: 'https://cdn.example/v-480.mp4', height: 480 }, …] },
  ],
  { startIndex: 0, startPosition: 0, autoplay: true }
);

player.queue.add(items, { index });   // default: at the end
player.queue.remove(idOrIndex | Array);
player.queue.move(from, to);
player.queue.clear();                 // the current item plays on, alone
player.queue.skipTo(idOrIndex, { position });
player.queue.next(); player.queue.previous();
player.queue.setRepeat('off' | 'one' | 'all');
player.queue.setShuffle(true | false);

player.queue.items;   // QueueItem[] (sync snapshot)
player.queue.index;   // number | null
player.queue.state;   // { index, currentId, length, repeat, shuffle, order }
player.on('queueChange', (state) => …);
```

- A queue item is any `Source` plus an optional `id` (default `q<n>`, unique per player). Ids are what edits and events use; indexes shift.
- `player.load(source)` empties the queue (what plays is no longer a queue item): a radio app that never uses the queue keeps forwarding next/previous as today. `player.queue.add()` after a plain load makes the loaded source the first item. `player.reset()` empties it.
- **Repeat `one`** uses the engine's seamless loop (`setLoop`). **Repeat `all`** wraps from the last item to the first (and `previous` from the first to the last).
- **Shuffle** plays a permutation of the items; the current item stays current and becomes the first of the order. `add` inserts new items at random places after the current position in the order; turning shuffle off returns to list order from the current item.
- **Previous:** more than 3 s into the item (or a live item) restarts it; otherwise goes to the previous item (wrapping with repeat `all`; at the first item without wrap it restarts it).
- **Edits around the current item:** removing the current item moves to the next (or the previous if it was the last), keeping the play intent; moving it keeps it current; `set` with a `startIndex` replaces it.
- **Errors:** an item that fails fatally with an error of its own (`SOURCE_NOT_FOUND`, `UNSUPPORTED_FORMAT`, `DECODER_ERROR`, `HTTP_ERROR` 4xx, `DRM_*`, `INVALID_SOURCE`) emits its `error` (state `error` first) and the queue moves on to the next item. A 401/403 on a refreshable source asks for a new URL first, as today. When every item has failed in a row, the queue stops on the last error. Network failures keep the engine's recovery: the queue never skips an item because the network dropped.
- **Signed URLs:** `refresh` stays a JS callback. An item whose URL expired while JavaScript was frozen fails its open with 401/403 and is retried by the engine's backoff until JS answers (as a plain load is today); give such items a long enough expiry, or `cacheKey` (PR B) so cached bytes survive a new signature.
- **Remote next/previous:** while a queue has items, the lock screen, notification, headset, car and watch next/previous buttons are enabled and handled natively, and are no longer forwarded as `remoteCommand` events. With no queue, `mediaSession.commands` works as today.
- **Live items** in a queue: never auto-advance, never preloaded. Next/previous skip off them as from any item.

### Gapless and preload of the next item

The engine owns the queue (a `QueueModel` inside each twin, so auto-advance, skips on errors and remote next/previous are decided in one place and held to `conformance/queue.json`). Its contract with the driver:

| Call / observation | Meaning |
| --- | --- |
| `driver.prepareNext(request)` | Open the next item behind the current one, paused at its start, under **its own generation**, issued now. Asked once the current item is finite and ready for `min(2 s, a quarter of its length)`, the next item is finite (not live, no renditions, no DRM in v1) and the player is not looping or casting. |
| `driver.cancelNext(gen)` | The prepared item is no longer next (an edit, repeat/shuffle change, a new open, stop, reset, handoff). |
| `onReady(gen)` etc. for the prepared generation | Kept as facts of the prepared item; never change the current state. Its failure drops it (the item is opened normally when its turn comes). |
| `onAdvanced(gen, playing)` | The driver started the prepared item itself as the current one ended (ExoPlayer's playlist). The engine makes it the current item under that generation: a new load id, state from its facts, **no `ended`**. |
| `driver.advance(gen)` | The current item ended (or the user skipped to the prepared item) and the driver did not start it: start it now. Same takeover. |
| late `onAdvanced` of a dropped item | The driver moved on before the cancel reached it: the current item ended all the same; the engine goes to the item that is next now. |

`ended` stays an engine state for the last item only. Repeat `one` is the engine's loop (the app's `setLoop` and repeat `one` are kept apart).

Per platform, the prepared item is played as follows:

- **Android:** the next item is appended to ExoPlayer's playlist (as live continuations already are), so the transition is ExoPlayer's own: gapless, with encoder delay and padding trimmed (LAME/iTunes headers). The driver reports the old generation's end at the automatic transition and adopts the playing item when the engine's preloaded open arrives.
- **iOS:** the `SwapDriver`'s second AVPlayer opens the next item paused and prerolled; a boundary time observer on the current item starts it just before the end, and the current item's end is the fallback trigger. **Near-gapless, best effort**: no network wait, but not sample-exact (encoder padding is not trimmed). `AVQueuePlayer` for audio is the upgrade path.
- **Web:** the `SwapDriver`'s second element opens the next item and is started when the current one ends (its own path, not the quality switch's rendezvous). **Near-gapless, best effort** (a hidden tab's timers are throttled). Real gapless through one MSE buffer (`timestampOffset`) is the upgrade path.
- **Cast:** the receiver plays one item at a time and nothing is prepared; when the receiver reports the item's end, the engine loads the next one on it (a short gap). A queue on the receiver is out of scope for v1.
- **Android media session:** the session player is RNAP's facade over the engine (`SessionPlayer`), not ExoPlayer, so the prepared playlist item never shows to controllers; next/previous availability follows the queue.

### Persistence (deferred)

Not in v1 (council): `player.queue.state` and `items` are plain data an app can store and give back to `set()`.

## 2. Playlists

```ts
import { Playlists } from 'react-native-anything-player';

const items = await Playlists.fetch('https://station.example/listen.pls'); // M3U, M3U8 (not HLS), PLS, XSPF
const items2 = Playlists.parse(text, { baseUrl, format? });
player.queue.set(items);
```

- **Playlist files:** M3U / extended M3U (`#EXTINF` duration, artist and title, `#EXTIMG`/`tvg-logo` artwork, `#EXTVLCOPT:http-user-agent`), PLS (`File1`, `Title1`, `Length1`), XSPF (`location`, `title`, `creator`, `album`, `image`, `duration`). Relative entries resolve against the file's URL. An `.m3u8` that turns out to be an HLS playlist (`#EXT-X-TARGETDURATION` / `#EXT-X-STREAM-INF`) is returned as one item (the HLS source itself). Entries with a `-1` duration are marked `live: true`.
- **`load()` of a playlist file:** a `.pls`, `.m3u` or `.xspf` URL given to `load()` or a queue (common for radio stations) is resolved to its first entry. Parsing runs in the same TypeScript code on every platform, so it needs JavaScript (a voice catalog item should name the stream itself); native receives resolved items. The app's headers go to the playlist's own host only, and a playlist fetched over HTTP(S) can name only HTTP(S) entries.
- **Saved playlists (deferred, council):** `Playlists.save/get/list/remove` is not in v1; apps keep their own storage, and a playlist is a list of items they pass to `queue.set()`. `Playlists.format` is deferred too.

## 3. Cache, preload and offline (pull request B)

Round-1 changes: the engine's in-memory `prepareNext` and the disk `Cache.preload` are separate names and tiers; `player.preload()` is dropped (the queue prepares its next item, `Cache.preload` fills the disk); iOS HLS is **download-only** (no cache-on-play, `Cache.preload` of HLS is a no-op there), stated in the API docs; Android uses one download cache (no evictor) read before the LRU play cache, and a completed download removes the key from the play cache; downloads report progress at most once a second; `Cache.pause/resume` and the web hls.js / dash.js loaders are deferred; preconnect for live items is best effort (a no-op where the platform has none). Who decides an item is fully cached for the offline waiver: the platform's cache index, told to the engine as a source fact (`offline: true`) at open.

### API

```ts
import { Cache } from 'react-native-anything-player';

Cache.configure({ enabled: true, maxSizeBytes: 512 * 1024 * 1024 }); // defaults: on, 256 MB

// Per source (also in queue items):
player.load({ uri, cache: false });            // never cached
player.load({ uri, cacheKey: 'ep-42' });       // a signed URL whose query changes

// Preload caching: fetch ahead so a later load starts at once (and plays offline if complete).
await Cache.preload(source, { bytes: 2_000_000 }); // default: the first 1 MB, or for HLS/DASH the first 3 segments
await Cache.preload(source, { all: true });        // the whole item

// Offline downloads: pinned, never evicted, in the app's support directory.
const id = await Cache.download(source, { id: 'ep-42', quality: '720p' }); // HLS/DASH: one rendition + its audio/subtitles
Cache.on('download', ({ id, state, bytes, totalBytes, error }) => …);
await Cache.downloads();         // [{ id, source, state, bytes, totalBytes }]
await Cache.pause(id); await Cache.resume(id); await Cache.remove(id);

await Cache.info(source);        // { state: 'none' | 'partial' | 'complete', bytes, pinned }
await Cache.usage();             // { cacheBytes, downloadBytes }
await Cache.clear();             // the LRU cache, not downloads

player.preload(source);          // warm a player for this source: preconnect + Cache.preload
```

### Behaviour

- **What is cached:** finite sources: progressive files in every container (MP3, AAC, M4A, FLAC, Ogg, Opus, WAV, MP4, MOV, WebM, MKV, MPEG-TS files, including remuxed ones), and HLS / DASH on-demand segments, playlists and keys (not DRM licenses). Never: live streams (ICY/Icecast, live HLS/DASH, unbounded responses), local files (`file://`, `content://`, `blob:`, `data:`), sources with `cache: false`, responses marked `Cache-Control: no-store`.
- **Cache on play** (LRU, `maxSizeBytes`): bytes are written as they are played and reused by later plays, seeks and loops; what is partly cached plays from disk where it can and fetches the rest.
- **Offline replay:** a fully cached or downloaded item plays with no network. The engine's offline rules do not hold back an item the cache can serve whole: `status.network` still reports `offline`, but no `reconnecting` state or probe applies to it.
- **Downloads** run natively in the background where the OS allows (iOS background `URLSession` / `AVAssetDownloadURLSession`, Android `DownloadManager` service of Media3 with a notification), survive app restarts and resume after network loss.
- **Preload for live sources:** `player.preload(liveSource)` and the queue's next live item only preconnect (DNS + TCP/TLS, no request, #101); nothing reaches the mount, so no listener is counted.
- **Cache key:** the URL without its fragment, or `cacheKey`. Two sources with the same key share bytes.

### Per platform

- **Android:** Media3 `SimpleCache` (LRU evictor) and `CacheDataSource` over the OkHttp source, with `FLAG_IGNORE_CACHE_FOR_UNSET_LENGTH_REQUESTS` (an unbounded live response is never written). Downloads: a separate `SimpleCache` with no evictor and Media3 `DownloadManager` + `DownloadService` (progressive, HLS, DASH downloaders). Preload: `CacheWriter` for a byte range; HLS/DASH: the first segments through the downloader with a stop.
- **iOS:** progressive files go through the `StreamProxy` already, which writes what it fetches to a sparse cache file per key (a range index next to it) and serves covered ranges from disk. HLS and DASH-as-HLS: on-demand items are downloaded for offline with `AVAssetDownloadURLSession` (the only way AVFoundation plays HLS offline); cache-on-play for HLS is not offered on iOS (AVFoundation fetches HLS itself). Preload: the proxy fetches the range ahead into the cache.
- **Web:** Cache Storage (`caches.open('rnap')`) with an LRU index in IndexedDB. Complete items play from a `blob:` URL; partial items through the fetch-based readers (MSE, remux) that already own the bytes; hls.js and dash.js/Shaka get a loader that reads and writes the cache. A plain cross-origin `<audio>` without CORS cannot be cached (an opaque response cannot be read), and Safari's native HLS is not cached; both are reported by `Cache.info` as `none` and documented.

## Conformance

- `conformance/queue/*.json`: the queue model (set, add, remove, move, skip, next/previous with positions, repeat, shuffle with a seeded generator shared by the twins, edits around the current item, error skipping decisions).
- Engine scenarios (`conformance/queue-engine.json`): `setNext`, preload timing (2 s rule, finite-only, cancel on change), advance without `ended`, preloaded open, advance after a driver's automatic transition, repeat one through loop, last item ends with `ended`, skip on fatal source error, never on network failure, offline rules waived for a fully cached item.
- Cache: unit tests per platform (range index, LRU eviction, key rules, live never written); Playwright scenarios for the web cache and offline replay.

## Out of scope (v1)

- A queue run by a Cast receiver; crossfades between queue items (the existing fades apply per item); recording or caching live streams; DRM offline licenses (persistent Widevine / FairPlay offline keys); split packages (`@rnap/queue`, `@rnap/cache`).
