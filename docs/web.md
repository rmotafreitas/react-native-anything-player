# Web

RNAP plays on the web with the same `Player` API: in **Expo web**, in **React Native Web**, in **React** apps without React Native (Vite, Next.js), and in a **plain web page** with no framework. [What works where](features.md) lists the differences from iOS and Android. The browser engine is a TypeScript twin of the Swift and Kotlin engines and passes the same [conformance suite](../conformance/README.md), so state, intent, events and recovery follow the same rules everywhere.

## Setup

### Expo web and React Native Web

Nothing to configure: the bundler picks the browser engine (`nativeModule.web.ts`) the way it picks any `.web` file. Hooks, events and `Player` work unchanged.

```sh
npx expo install react-dom react-native-web @expo/metro-runtime
npx expo start --web
```

### React (react-dom: Vite, Next.js, Create React App)

Import `react-native-anything-player/react`: the `Player`, the same hooks as on React Native, and `<button>` versions of `<RoutePicker />` and `<CastButton />` (they take `className` and `style`). No React Native import, so `react-native` does not need to be installed.

```tsx
import { useEffect, useState } from 'react';
import { Player, usePlayerStatus, useStreamMetadata, CastButton } from 'react-native-anything-player/react';

export function Radio() {
  const [player, setPlayer] = useState<Player | null>(null);
  useEffect(() => {
    const created = new Player({ id: 'main' });
    setPlayer(created);
    return () => void created.release();
  }, []);
  return player ? <Controls player={player} /> : null;
}

function Controls({ player }: { player: Player }) {
  const { playWhenReady, state } = usePlayerStatus(player);
  const metadata = useStreamMetadata(player);
  return (
    <div>
      <button onClick={() => (playWhenReady ? player.pause() : player.load('https://radio.example/stream', { autoplay: true }))}>
        {playWhenReady ? 'Pause' : 'Play'}
      </button>
      <span>{state} · {metadata?.title ?? '–'}</span>
      <CastButton />
    </div>
  );
}
```

Importing it touches no browser API, so server-rendered pages (Next.js) can import it; create players in the browser, in an effect or a client component. [`example-react/`](../example-react/src/App.tsx) is a Vite app, tested in Chromium, Firefox and WebKit.

### A plain web page

Import `react-native-anything-player/web`. It has no React or React Native dependency, and the `Player` API is the same:

```html
<button id="play">Play the radio</button>
<script type="module">
  import { Player } from 'https://esm.sh/react-native-anything-player/web';

  const player = new Player();
  player.on('metadata', (m) => console.log(m.artist, '–', m.title));
  // Browsers start audio only from a user gesture: load and play in the tap.
  document.getElementById('play').onclick = () =>
    player.load('https://radio.example/stream', { autoplay: true });
</script>
```

With a bundler, `import { Player } from 'react-native-anything-player/web'` works the same. [`example-web/`](../example-web/main.js) is a complete page (stations, controls, metadata, a visualizer).

## How a stream is played

| Source | How | ICY metadata | Splice on drop | `liveOffset` |
|---|---|---|---|---|
| Live HTTP stream (MP3, AAC) with CORS | `fetch()` + Media Source Extensions (wrapped in MP4 where the browser needs it, see below) | yes, timed to when it is heard | yes | yes |
| Live stream without CORS, or a codec MSE cannot take | the `<audio>` element | no | no (the engine reconnects) | `null` |
| Files (`live: false`, or a response with `Content-Length`) | the `<audio>` element, seekable | – | – | – |
| HLS (`.m3u8`) | the `<audio>` element where the browser plays HLS (Safari, Android); elsewhere [hls.js](#hls) | ID3 titles (hls.js) | the engine reconnects | live: seconds behind the edge (hls.js) |
| A picked `File` / `Blob`, a `blob:` or `data:` URL | the `<audio>` element, seekable, [see Local files](#local-files) | – | – | – |

Reading the stream itself is what makes radio work properly on the web: RNAP owns the connection, so it de-interleaves ICY metadata (the same parser as native, the same charset repair) and delivers each title when its audio is heard. It closes the connection the moment the player releases it. And when a connection that stayed up for at least 3 s drops, a fresh one is spliced into the same buffer without stopping, reported as a [`discontinuity`](events.md#events) once its audio plays. A connection that drops sooner (a flapping server) ends the stream instead, and the engine's backoff paces the reconnects.

Anything RNAP cannot read falls back to the plain element, which still plays and still recovers. The diagnostics trace says why (`plain playback` with a reason).

### MP3 and AAC in MP4 (Firefox)

MSE takes MP3 and AAC in different containers in different browsers. Chromium takes `audio/mpeg` and `audio/aac` as they come; Firefox does not, but takes `audio/mp4; codecs="mp3"` and `codecs="mp4a.40.2"`; WebKit takes all of them. RNAP asks the browser per stream: the raw type if it is supported, else the MP4 form. For the MP4 form it wraps the frames in fragmented MP4 as they arrive (`Fmp4Muxer`, a few hundred lines, no dependency): it finds the MP3 or ADTS frames (skipping ID3 tags and resynchronising after garbage, as on a connection that joins mid-frame), writes one init segment, then one segment per chunk on a continuous timeline. The frames themselves are not touched, so nothing is decoded or re-encoded.

Everything above works the same on top of it: ICY is de-interleaved before muxing and each title is timed to the frame it was sent with, a spliced connection continues on the same timeline (with the init segment sent again, as the source buffer's parser was reset), reading pauses when 30 s are buffered, and the visualizer and `liveOffset` read the element as usual. The diagnostics trace notes a `remux`.

Two limits: a stream whose sample rate or channel layout changes mid-stream (very rare) ends there, as a recoverable `STREAM_ENDED`, and the engine reconnects with an init segment for the new layout; and bytes that are not MP3 or ADTS AAC (MP2 under an `audio/mpeg` label, say) are given to the plain element after 64 KB without a frame.

### What the stream server must send

A browser may read a cross-origin stream only if the server allows it. Many servers already send `Access-Control-Allow-Origin`; for ICY titles, the stream also needs the other two:

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Headers: Icy-MetaData
Access-Control-Expose-Headers: icy-metaint, icy-name, icy-genre
```

If `icy-metaint` is not exposed, RNAP asks again without ICY (a hidden metadata interval would corrupt the audio): the stream plays without titles. Set `live: false` on file sources served from the same host as a stream, to skip the probe request.

### Browser support

Tested end to end with Playwright on every change:

| | Chromium (Chrome, Edge, Android) | WebKit (Safari, iOS 17.1+) | Firefox |
|---|---|---|---|
| Playback, files, seeking, recovery | ✓ | ✓ | ✓ |
| ICY metadata, splices, `liveOffset` | ✓ | ✓ (ManagedMediaSource on iPhone) | ✓ (the stream is wrapped in MP4) |
| Visualizer | ✓ | ✓ | ✓ |
| HLS | hls.js | native | hls.js |
| Local files (`File`, `Blob`) | ✓ | ✓ | ✓ |
| Lock screen / media keys (Media Session) | ✓ | ✓ | ✓ |
| Network handoff detection | ✓ (Network Information API) | – | – |

## HLS

Safari (and Android's browsers) play HLS themselves, and RNAP hands them the playlist. Everywhere else it needs [hls.js](https://github.com/video-dev/hls.js), which RNAP does not bundle: install it and register it once at startup.

```sh
npm install hls.js
```

```ts
import Hls from 'hls.js';
import { configureHls } from 'react-native-anything-player'; // or '…/web'

configureHls(Hls);
```

With hls.js loaded by a `<script>` (it then sits on `window.Hls`), the call is optional: RNAP uses a registered constructor first, else the global one. On iOS and Android `configureHls` does nothing: the platforms play HLS natively.

Without hls.js on a browser that cannot play HLS, the load fails with `UNSUPPORTED_FORMAT` and a message that says to install hls.js and call `configureHls`.

RNAP uses hls.js for a source whose path ends in `.m3u8`, or whose response says `application/vnd.apple.mpegurl` or `application/x-mpegurl` (a playlist behind a URL without the extension is found by that). It gives hls.js the player's `<audio>` element, so the Media Session, the volume, the visualizer and the diagnostics work as for any other source.

- **A native HLS that cannot.** Some browsers say they play HLS and then cannot open a playlist (Chrome's native HLS takes fewer streams than hls.js). If the element fails with an unsupported source before anything played and hls.js is registered, RNAP tries the same item with hls.js.
- **Ready.** `isLive`, `duration` and `seekable` come from the playlist: a playlist without `#EXT-X-ENDLIST` is live (no duration, not seekable).
- **Recovery is the engine's.** A fatal hls.js error (hls.js has already retried a fragment) is reported as a recoverable `NETWORK_ERROR` or `DECODER_ERROR`, hls.js is destroyed, and the engine re-opens the item with a new instance under its usual [backoff](recovery.md). RNAP never calls hls.js's `startLoad()` or `recoverMediaError()`, so the two do not fight over retries. A missing playlist (HTTP 404/410) is `SOURCE_NOT_FOUND`, not recoverable.
- **Titles.** ID3 text frames in the stream (`TIT2` title, `TPE1` artist, `TALB` album; ID3v2.2–2.4) become [`metadata`](events.md#events), each delivered when its time is heard, as native HLS timed metadata is.
- **Headers.** The source's `headers` are sent on every playlist and segment request (`xhrSetup` / `fetchSetup`). A custom header makes a cross-origin request preflighted: the server has to allow it.
- **Live offset.** `liveOffset` is hls.js's latency to the live edge.
- **Teardown.** The hls.js instance is destroyed on `stop()`, `reset()`, the next `load()` and `release()`.

## Local files

A file the user picked or dropped plays by passing it straight to `load()`:

```ts
input.onchange = () => player.load(input.files[0], { autoplay: true });
dropZone.ondrop = (event) => {
  event.preventDefault();
  player.load(event.dataTransfer.files[0], { autoplay: true });
};
```

RNAP creates an object URL for the `File` or `Blob` and revokes it when the item is replaced by another `load()`, on `reset()` and on `release()` (`stop()` keeps it: `play()` re-opens the file). There is nothing to clean up. A `File`'s name, without its extension, is the title on the lock screen until you call `updateNowPlaying`. The file is a seekable, non-live source; the visualizer works on it.

Strings work too: `blob:` and `data:` URLs are accepted on the web (`player.load(URL.createObjectURL(file))`), but then the URL is yours to revoke. Both are refused on iOS and Android with `INVALID_SOURCE` (the message says they are for the web; use a `file:` URI there), as is a `Blob`. A catalog item's `source` must be a URL: a `Blob` there is `INVALID_SOURCE`.

A Cast receiver and an AirPlay device cannot reach a page's `blob:` or `data:` URL. A local file therefore always plays on this device: loading one returns a casting player to the device (with a `CAST_UNSUPPORTED_SOURCE` error event that is not fatal), and it is never offered as an AirPlay alternative.

The example page ([`example-web/`](../example-web/main.js)) has a picker and a drop zone.

## Autoplay

Browsers refuse to start audible playback without a user gesture. RNAP reports it rather than failing silently:

- `play()` (or a `load(…, { autoplay: true })`) that the browser refuses rejects with **`AUTOPLAY_BLOCKED`** (recoverable).
- The status says `playWhenReady: false, interruption: { reason: 'autoplay-blocked' }` until playback starts.

Call `play()` from a click or tap handler; the same call then succeeds.

```ts
player.play().catch((error) => {
  if (error.code === 'AUTOPLAY_BLOCKED') showTapToPlayButton();
});
```

## Lock screen and media keys

The browser's Media Session shows the active player (title, artist, album, artwork, position) on the lock screen, in the notification shade on Android, and on media keys and headsets. The rules are those of the [native lock screen](background-and-system.md#lock-screen-notification-and-hardware-controls): play, pause, stop and seek are handled by the engine; `next`, `previous`, `skipForward` and `skipBackward` are forwarded as `remoteCommand` when listed in `mediaSession.commands`; and a Play with nothing loaded is forwarded so the app can choose what to load.

## Recovery on the web

The engine is the same, so are the rules in [Recovery policy](recovery.md): stall and dead-socket detection, backoff with jitter, offline probing, live-edge re-open and give-up. Their inputs on the web:

| Native input | Web |
|---|---|
| Connectivity | `online` / `offline` events (`navigator.onLine`) |
| Network handoff | Network Information API `change` (Chromium) |
| App foreground | page visibility (`visibilitychange`) |
| Engine timers | the page's timers; browsers do not throttle a tab that is playing audio |

## Differences from native

| | Native | Web |
|---|---|---|
| `headers` on a source | sent on every request | sent when the stream is read through `fetch()` or played by hls.js; the `<audio>` element cannot send headers |
| Bundled assets (`require('./a.mp3')`) | resolved by Metro | pass a URL (`INVALID_SOURCE` otherwise) |
| `blob:` / `data:` URLs, `File` / `Blob` sources | `INVALID_SOURCE` | played, see [Local files](#local-files) |
| HLS | native | native in Safari; [hls.js](#hls) elsewhere |
| Audio focus | one app at a time | none: other tabs and apps play alongside |
| `audio.contentType`, `audio.mixWithOthers`, `android.*` | honoured | ignored |
| Volume on iOS Safari | honoured | fixed by the system (`setVolume` has no effect; `setMuted` works) |
| Visualizer | every source | streams read through `fetch()` (Web Audio cannot read a cross-origin `<audio>` without CORS) |

## Expo Go

Expo Go cannot load RNAP's native code. `new Player()` there throws `NATIVE_MODULE_MISSING` with the setup steps; see [Getting started](getting-started.md#expo-go). Expo web needs no native code and works.

## Testing

`yarn test:web` builds the library and the Expo example's web export, then runs Playwright in Chromium, Firefox and WebKit against the [test radio](testing.md#on-device-integration-scenarios). It drives the plain-web example (ICY, CORS fallback, seeking, splices, outages, autoplay, visualizer, MP3 and AAC remuxed to MP4, HLS through hls.js, picked and dropped files) and runs the Expo example's integration scenarios (the same ones the native apps run) on React Native Web. The test radio serves an HLS program (on demand and live, with ID3 titles) and an AAC stream; hls.js is a dev dependency, loaded by the example page. The MP4 muxer is also unit-tested against real MP3 and ADTS frames, and its output decodes in `ffmpeg`. Details in [Testing](testing.md).
