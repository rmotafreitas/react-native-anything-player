# Cache and offline

RNAP keeps media on the device in three ways, all from one `Cache` API:

- **The cache written as items play** (off by default): a file plays from the network the first time and from the device after that; the least recently played go first once the cache is full.
- **Preload:** the start of a source (or all of it) fetched ahead, so a later `load()` starts at once.
- **Downloads:** sources kept for offline replay, never evicted, until you remove them.

The platform does the work (Media3's cache on Android, the stream proxy and `AVAssetDownloadURLSession` on iOS, Cache Storage on the web), so a cached or downloaded item plays while JavaScript is frozen and with no network. Players need nothing: they read the cache and downloads by themselves, a queue's items included.

```ts
import { Cache, Player } from 'react-native-anything-player';

await Cache.configure({ enabled: true, maxSizeBytes: 512 * 1024 * 1024 }); // the cache as items play

await Cache.preload({ uri: 'https://cdn.example/ep1.mp3' });          // the first 1 MB
await Cache.preload({ uri: 'https://cdn.example/ep1.mp3' }, { all: true });

const unsubscribe = Cache.addListener('download', ({ id, state, bytes, totalBytes }) => { … });
await Cache.download({ uri: 'https://cdn.example/ep2.mp3' }, { id: 'ep2' });

await Cache.info('https://cdn.example/ep2.mp3');  // { state: 'complete', bytes, totalBytes, downloaded: true }
await Cache.downloads();                          // [{ id, uri, state, bytes, totalBytes, error }]
await Cache.removeDownload('ep2');
await Cache.usage();                              // { cacheBytes, downloadBytes, maxSizeBytes }
await Cache.clear();                              // the cache, not downloads
```

## Per source

| Option | |
|---|---|
| `cache: true` / `false` | This source is (or is never) written as it plays, whatever `Cache.configure({ enabled })` says. |
| `cacheKey` | The bytes' identity (default: the URL without its fragment). Give one to a signed URL whose query changes: the new URL finds the bytes the old one cached or downloaded. |

```ts
player.load({ uri: signedUrl, cacheKey: 'episode-42' });
```

## What each platform keeps

| Source | Android | iOS | Web |
|---|---|---|---|
| A file over HTTP(S) (MP3, AAC, M4A, FLAC, Ogg, Opus, WAV, MP4, MOV, WebM, MKV, MPEG-TS): cache as it plays | ✓ | ✓ audio ¹ | ✓ ² |
| The same: preload part / all | ✓ / ✓ | ✓ / ✓ | ◐ ³ / ✓ ² |
| The same: download, offline replay | ✓ | ✓ | ✓ ² |
| HLS on demand: cache as it plays | ✓ | – ⁴ | – ⁵ |
| HLS on demand: preload / download | ✓ / ✓ ⁶ | – / ✓ ⁷ | – ⁵ |
| DASH on demand | ✓ ⁶ | – ⁸ | – ⁵ |
| Live streams (internet radio, live HLS / DASH) | – ⁹ | – ⁹ | – ⁹ |
| Local files (`file://`, `content://`, `blob:`, `data:`) | – (already on the device) | – | – |
| DRM | – | – | – |

1. A video file is cached when it is downloaded or preloaded whole (AVFoundation fetches a video's ranges itself; a file held whole is opened from the device).
2. With CORS from the file's server (its bytes are read by the page), and a length. A complete file plays from a `blob:` URL made from the stored bytes; on iPhone and iPad, the very first play of a player from the cache may need a second tap (the stored bytes are read before the element gets them). As items play, the page fetches the file a second time, at its own pace, to store it (the element's own requests cannot be read); `Cache-Control: no-store` is honoured.
3. Part of a file goes into the browser's own HTTP cache; `Cache.info` reports it as `partial`, but the browser decides how long it keeps it and whether the element's own requests are served from it.
4. AVFoundation fetches HLS itself. Download it instead.
5. hls.js, dash.js and Shaka read their segments themselves.
6. One quality: the highest-bandwidth video variant and the first audio track. DASH needs the DASH module (video apps have it, or `rnapDash=true`).
7. `AVAssetDownloadURLSession`: the system picks the quality and keeps downloading in the background.
8. iOS plays DASH as rewritten HLS, which `AVAssetDownloadURLSession` cannot take.
9. A live stream never ends: keeping it would be recording, which is out of scope. `Cache.preload` of a live source does nothing, so the station never counts a listener for it.

## Where the bytes live

| | Cache | Downloads |
|---|---|---|
| Android | the app's cache directory (`rnap-media`); the system may clear it when storage runs low | the app's files directory (`rnap-downloads`) |
| iOS | `Caches/rnap-media` (the system may clear it) | `Application Support/rnap-downloads`, excluded from iCloud backup; HLS packages where `AVAssetDownloadURLSession` puts them |
| Web | Cache Storage (`rnap-media-v1`), evictable by the browser | the same, with `navigator.storage.persist()` asked for at the first download |

## Downloads

- A download left half-way goes on at the next launch: from where it stopped on iOS and Android (HLS downloads on iOS go on in the background, the system's own), from the start on the web (a page cannot resume a file it stores). One that failed stays `failed`: ask for it again.
- Progress comes at most once a second (`download` events). An HLS download on iOS reports a share of 1,000 (`bytes` / `totalBytes`) until it completes: AVFoundation does not say its size.
- A finished download of a file removes its copy from the cache (Android, iOS), so the same bytes are not kept twice. On the web a file the cache holds whole becomes the download without being fetched again; on Android and iOS a download fetches the file anew.
- A source with no length (a live stream without `live: true`) is never cached or downloaded.
- A download keeps its source's request headers (to resume it), in the app's storage. A download is an app's data, not the user's account: on sign-out, remove the downloads (`Cache.downloads()`, then `removeDownload`) and `Cache.clear()` the cache.

## Offline

A complete cached or downloaded item plays with no network, from its first byte. A partly cached file plays what it holds and stops where it ends; the player then reconnects as for any network failure. The queue never skips an item because the network is gone: give it downloaded items for a flight.
