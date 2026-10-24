# Errors

Every rejection and every `error` event is a `PlayerError`:

```ts
import { isPlayerError } from 'react-native-anything-player';

try {
  await player.load(url, { autoplay: true });
} catch (e) {
  if (isPlayerError(e)) {
    e.code;           // 'SOURCE_NOT_FOUND'
    e.message;        // 'The server returned HTTP 404.'
    e.recoverable;    // false
    e.httpStatus;     // 404
    e.platform;       // 'ios' | 'android'
    e.platformDomain; // e.g. 'AVFoundationErrorDomain', 'androidx.media3:ERROR_CODE_IO_BAD_HTTP_STATUS'
    e.platformCode;   // native code
    e.nativeCause;    // full native chain: 'NSURLErrorDomain(-1009): The Internet connection appears to be offline. ← …'
  }
}
```

Native details are never dropped: `AVFoundationErrorDomain -11800` comes with the underlying error that explains it.

| Code | Recoverable | Typical cause |
|---|---|---|
| `INVALID_SOURCE` | no | empty/unsupported URI, cleartext HTTP blocked by ATS / network-security config, no permission to read; a `File`/`Blob` or `blob:`/`data:` URL outside the web |
| `SOURCE_NOT_FOUND` | no | missing file, HTTP 404/410 |
| `UNSUPPORTED_FORMAT` | no | container/codec the device cannot decode, server returned non-audio; web: HLS in a browser without native HLS when hls.js is not [configured](web.md#hls) |
| `DECODER_ERROR` | if it had played | corrupt data (a glitch in a stream that was playing is retried) |
| `NETWORK_UNAVAILABLE` | yes | the device is offline |
| `NETWORK_ERROR` | yes | connection refused/reset, DNS, TLS failure (TLS: no) |
| `TIMEOUT` | yes | connect/read timeout, open took longer than 12 s |
| `HTTP_ERROR` | 408/429/5xx yes, others no | `httpStatus` set |
| `STREAM_ENDED` | yes | a live stream's server closed the connection |
| `AUDIO_FOCUS_DENIED` | yes | another app or a call holds audio focus / the audio session |
| `AUDIO_SESSION_ERROR` | yes | reserved for audio-session configuration failures (activation refusals are reported as `AUDIO_FOCUS_DENIED`) |
| `NOT_SEEKABLE` | no | `seekTo` on a live stream |
| `NO_SOURCE` | no | `play`/`seekTo` before `load` |
| `PLAYER_RELEASED` | no | any command after `release()` |
| `INVALID_ARGUMENT` | no | non-finite numbers, rate ≤ 0 |
| `NATIVE_PLAYER_ERROR` | yes | unclassified native failure (details in `nativeCause`) |
| `AUTOPLAY_BLOCKED` | yes | web: the browser refused `play()` without a user gesture; call it from a tap ([Web](web.md#autoplay)) |
| `NATIVE_MODULE_MISSING` | no | thrown by `new Player()` when the binary lacks RNAP's native module: Expo Go, or an app not rebuilt ([Getting started](getting-started.md#expo-go)) |
| `ROUTE_PICKER_UNAVAILABLE` | no | `showRoutePicker()` where there is no output picker (Firefox; a browser without AirPlay or Remote Playback for this source) ([Casting & AirPlay](routes-and-casting.md#the-output-picker)) |
| `CAST_UNAVAILABLE` | no | `showCastPicker()` where Cast is not built in (no `cast` plugin option) or not supported (browsers other than Chrome), or before the web's Cast SDK is ready ([Casting & AirPlay](routes-and-casting.md#google-cast)) |
| `CAST_UNSUPPORTED_SOURCE` | no | non-fatal `error` event: a Cast session started but the player's source cannot be reached by a receiver (a local file, `content://`, a bundled asset, `blob:`); the player stays on the device ([Casting & AirPlay](routes-and-casting.md#what-casting-does)) |
| `SOUND_UNAVAILABLE` | no | `Sound.load()` or `Sound.configure()` on iOS or Android in an app built without the `sound` option ([Sound](sound.md#enabling-it)) |
| `VIDEO_UNAVAILABLE` | no | `new Player({ video })` on iOS or Android in an app built without the video module ([Video](video.md#enabling-it)) |
| `DRM_UNSUPPORTED` | no | `load()` of a source with `drm`: DRM is designed, not shipped yet ([Video design](video-design.md)) |
| `SUBTITLE_LOAD_FAILED` | no | non-fatal `error` event: a subtitle file could not be fetched or read; the video plays on ([Subtitles](subtitles.md#files)) |
| `INTERNAL_ERROR` | no | a bug — please report with `player.getDiagnostics()` |

## Recoverable vs fatal

While playback is wanted, a recoverable failure does not end playback: the engine reconnects and emits `error` with `{ fatal: false }` (`status.state` is `reconnecting`). A non-recoverable failure, or recovery giving up, moves to `state: 'error'` and emits `{ fatal: true }`. Calling `play()` from `error` retries.

A failed **initial** `load()` rejects even when recovery will continue (with `autoplay`), so the caller learns about it; the status shows what happens next.
