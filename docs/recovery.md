# Recovery policy

All recovery constants live in one file per platform — `ios/Core/RecoveryPolicy.swift` and `android/.../core/RecoveryPolicy.kt` — kept identical and checked by the shared [conformance suite](../conformance/README.md). Most are fixed on purpose: each encodes a failure observed in production (the Rádio Animu app) or during this library's own device testing.

| Constant | Value | Why |
|---|---|---|
| `heartbeatMs` | 1 s | The engine's watchdog clock while playback is wanted. Native timers keep running when React Native's JS timers are frozen in the background — the original reason recovery could not live in JS. |
| `stallDebounceMs` | 500 ms | ExoPlayer reports sub-second `BUFFERING` blips on healthy streams. Publishing them flickers spinners and spams events; recovery timers still count from the real stall start. |
| `openTimeoutMs` | 12 s | A link that cannot start a stream in 12 s is unusable; the attempt fails as `TIMEOUT` and the backoff takes over. |
| `openGraceMs` | 4 s | Two triggers landing together (a network edge and a foreground catch-up) used to re-open twice and abort the first connect mid-handshake. An open younger than this is left alone — unless it was issued before the latest network change (it rode the dead route). |
| `silentStallMs` / suspect | 4 s / 2 s | With `automaticallyWaitsToMinimizeStalling` off (fast start for radio), AVPlayer can stay "playing" with a frozen playhead through a dead socket and report nothing. A playhead that does not move is a stall. |
| `stallDeadMs` / suspect | 3 s / 1.5 s | Progressive streams are never revived by the native players once the socket dies. No buffered progress for this long while online ⇒ dead socket ⇒ re-open. |
| `stallMaxMs` | 20 s | A link that trickles data but never recovers is re-opened anyway. |
| `networkSuspectMs` | 20 s | After a connectivity change (lost, restored, Wi-Fi ↔ cellular), the stream's socket is probably dead: detection becomes eager for a while. A handoff never reports "offline", but the socket dies with the old route. |
| `reconnectBaseMs` … `reconnectMaxMs`, jitter | 1 s doubling to 30 s, ±20 % | Exponential backoff; the jitter spreads a station's listeners after a server restart instead of reconnecting all of them on the same second. |
| first reconnect after stable playback | immediate | A healthy stream that suddenly drops is usually a server kick or a handoff. Waiting a backoff step only adds silence. |
| `offlineProbeEvery` | 3 | While the OS says "offline", attempts are skipped — they only churn the player — but every third runs anyway in case the OS reading is stale. The restore edge re-opens immediately. |
| `stablePlaybackMs` | 10 s | The backoff resets only after audio flowed this long: a server that accepts, plays a second and drops must not cause a reconnect storm. |
| `pausedStreamReleaseMs` | 30 s | A paused live stream keeps downloading audio that resuming will never play (ExoPlayer indefinitely; AVPlayer ~110 s, measured). The connection is released; `play()` re-opens at the live edge. |
| `liveMaxDriftMs` (option) | 5 s | How far behind the live edge a stream may fall before a resume re-opens it. Only applied at silent moments — measured: an hour of ExoPlayer blips accumulated 5 s and the old rule cut flowing audio to catch up. |
| `giveUpAfterMs` (option) | 10 min | Bounds recovery (and the iOS background keepalive). `null` = never. |

Platform-level guards, outside the shared engine:

| Guard | Why |
|---|---|
| iOS proxy splice: only after ≥ 3 s of streaming | When a live stream's connection is dropped, the iOS stream proxy opens a fresh one and continues the same response, so AVPlayer plays on from its buffer (no gap, no state change; a `upstream spliced` diagnostic is recorded). An upstream that lived less than 3 s is never spliced: a server that accepts and closes in a loop ends the response, and the engine's backoff takes over. |
| Android continuation breaker: 4 / 10 s | The Media3 playlist continuation that makes drop recovery gapless; past the limit the item ends and the engine's backoff takes over. |
| iOS stale-pause handling | AVPlayer drops to `.paused` on a buffer underrun when auto-wait is off. Reading that as a system pause silently ended a radio; interruptions and route losses are reported separately by the session coordinator, so an unexplained pause is a stall. |
| Android focus retry (500 ms × 8) | Android 15+ denies audio focus to background apps without a foreground service; a start requested from the background is kept as "delayed" while Media3 promotes the service. |

## What recovery will not do

- Resume after the **user** paused — a pending system resume is cancelled by a user pause.
- Take audio focus or the audio session back from an app the user switched to.
- Retry non-recoverable errors (404, unsupported format, 401/403).
- Reconnect a file at the "live edge": files reconnect at their last position.
