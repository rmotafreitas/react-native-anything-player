# Web

RNAP plays on the web with the same `Player` API: in **Expo web**, in **React Native Web**, and in a **plain web page** with no framework. The browser engine is a TypeScript twin of the Swift and Kotlin engines and passes the same [conformance suite](../conformance/README.md), so state, intent, events and recovery follow the same rules everywhere.

## Setup

### Expo web and React Native Web

Nothing to configure: the bundler picks the browser engine (`nativeModule.web.ts`) the way it picks any `.web` file. Hooks, events and `Player` work unchanged.

```sh
npx expo install react-dom react-native-web @expo/metro-runtime
npx expo start --web
```

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
| Live HTTP stream (MP3, AAC) with CORS | `fetch()` + Media Source Extensions | yes, timed to when it is heard | yes | yes |
| Live stream without CORS, or a codec MSE cannot take | the `<audio>` element | no | no (the engine reconnects) | `null` |
| Files (`live: false`, or a response with `Content-Length`) | the `<audio>` element, seekable | – | – | – |
| HLS (`.m3u8`) | the `<audio>` element (Safari plays HLS natively; other browsers need [hls.js](https://github.com/video-dev/hls.js)) | – | – | – |

Reading the stream itself is what makes radio work properly on the web: RNAP owns the connection, so it de-interleaves ICY metadata (the same parser as native, the same charset repair) and delivers each title when its audio is heard. It closes the connection the moment the player releases it. And when a connection that stayed up for at least 3 s drops, a fresh one is spliced into the same buffer without stopping, reported as a [`discontinuity`](events.md#events) once its audio plays. A connection that drops sooner (a flapping server) ends the stream instead, and the engine's backoff paces the reconnects.

Anything RNAP cannot read falls back to the plain element, which still plays and still recovers. The diagnostics trace says why (`plain playback` with a reason).

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
| ICY metadata, splices, `liveOffset` | ✓ | ✓ (ManagedMediaSource on iPhone) | plays without them: the tested build does not take MP3/AAC in MSE |
| Visualizer | ✓ | ✓ | streams read through MSE only |
| Lock screen / media keys (Media Session) | ✓ | ✓ | ✓ |
| Network handoff detection | ✓ (Network Information API) | – | – |

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
| `headers` on a source | sent on every request | sent when the stream is read through `fetch()`; the `<audio>` element cannot send headers |
| Bundled assets (`require('./a.mp3')`) | resolved by Metro | pass a URL (`INVALID_SOURCE` otherwise) |
| Audio focus | one app at a time | none: other tabs and apps play alongside |
| `audio.contentType`, `audio.mixWithOthers`, `android.*` | honoured | ignored |
| Volume on iOS Safari | honoured | fixed by the system (`setVolume` has no effect; `setMuted` works) |
| Visualizer | every source | streams read through `fetch()` (Web Audio cannot read a cross-origin `<audio>` without CORS) |

## Expo Go

Expo Go cannot load RNAP's native code. `new Player()` there throws `NATIVE_MODULE_MISSING` with the setup steps; see [Getting started](getting-started.md#expo-go). Expo web needs no native code and works.

## Testing

`yarn test:web` builds the library and the Expo example's web export, then runs Playwright in Chromium, Firefox and WebKit against the [test radio](testing.md#on-device-integration-scenarios). It drives the plain-web example (ICY, CORS fallback, seeking, splices, outages, autoplay, visualizer) and runs the Expo example's integration scenarios (the same ones the native apps run) on React Native Web. Details in [Testing](testing.md).
