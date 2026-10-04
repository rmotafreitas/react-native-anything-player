# Errors

Every rejection and every `error` event is a `PlayerError`:

```ts
import { isPlayerError } from 'react-native-airwave';

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
| `INVALID_SOURCE` | no | empty/unsupported URI, cleartext HTTP blocked by ATS / network-security config, no permission to read |
| `SOURCE_NOT_FOUND` | no | missing file, HTTP 404/410 |
| `UNSUPPORTED_FORMAT` | no | container/codec the device cannot decode, server returned non-audio |
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
| `INTERNAL_ERROR` | no | a bug — please report with `player.getDiagnostics()` |

## Recoverable vs fatal

While playback is wanted, a recoverable failure does not end playback: the engine reconnects and emits `error` with `{ fatal: false }` (`status.state` is `reconnecting`). A non-recoverable failure, or recovery giving up, moves to `state: 'error'` and emits `{ fatal: true }`. Calling `play()` from `error` retries.

A failed **initial** `load()` rejects even when recovery will continue (with `autoplay`), so the caller learns about it; the status shows what happens next.
