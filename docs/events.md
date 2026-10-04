# Status & events

## Status

`player.status` is the last authoritative snapshot native code published (`PlayerStatus`):

| Field | Type | Meaning |
|---|---|---|
| `state` | `PlaybackState` | see [the state model](playback.md#state-model) |
| `playWhenReady` | `boolean` | playback is wanted |
| `loadId` | `number` | increments on every `load()`; which source this status describes |
| `isLive` | `boolean` | live / indefinite source |
| `duration` | `number \| null` | seconds; `null` for live or unknown |
| `seekable` | `boolean` | `seekTo` is allowed |
| `interruption` | `{ reason, resumable, since } \| null` | the system paused (or refused to start) playback |
| `error` | `PlayerErrorInfo \| null` | set in `state: 'error'` |
| `reconnect` | `{ attempt, nextAttemptAt, reason } \| null` | set while recovering |
| `network` | `'online' \| 'offline' \| 'unknown'` | connectivity as the engine sees it |
| `volume`, `muted`, `rate` | | as set |

`player.refresh()` reads the native snapshot synchronously and applies it if it is newer. Players refresh automatically when the app becomes active.

## Events

```ts
const off = player.on('status', (status) => …);
off(); // unsubscribe
```

| Event | Payload | When |
|---|---|---|
| `status` | `PlayerStatus` | any status field changed |
| `stateChange` | `(state, previous)` | `status.state` changed |
| `metadata` | `MediaMetadata` | new stream metadata became audible (or station info arrived) |
| `error` | `(PlayerError, { fatal })` | a failure; `fatal: false` means recovery is running |
| `ended` | – | a file played to its end |
| `remoteCommand` | `{ command, position? }` | an opted-in remote command (`mediaSession.commands`) |
| `diagnostic` | `DiagnosticEntry` | engine trace, only while diagnostics are enabled |

There are deliberately no progress events: progress is a synchronous read ([playback](playback.md#progress)). Stalls shorter than 500 ms are not published.

## Guarantees

**Ordering.** All events of a player are delivered in the order native code produced them. A discrete event (`ended`, `error`) is always delivered *after* the status it implies, so inside an `ended` listener `player.state` is already `'ended'`, and inside a fatal `error` listener it is `'error'`.

**Command results.** A command's promise resolves after its status change was emitted, so after `await player.pause()` the status already reflects the pause. Commands are applied in call order; a later command can make an earlier one moot (e.g. `play()` then `pause()`), never reorder it.

**Staleness.** Each status carries a sequence number. JavaScript never applies a snapshot older than the one it has, so a late command result cannot roll the state back, and a snapshot read after JS was suspended wins over events still queued.

**Stale native events.** Every source open (including reconnects) gets a new *generation*; observations from older generations (an error from a replaced item, a "ready" from a superseded load) are dropped in native code before they reach the engine. Each drop is visible in the diagnostics trace (`stale event dropped`).

**Listener isolation.** A listener that throws does not prevent other listeners from running; the error is re-thrown asynchronously so it still reaches your error reporting.

## Threads

| Where | What runs there |
|---|---|
| JS thread | `Player` methods, listeners, hooks. Synchronous getters (`getProgress`, `refresh`, `getDiagnostics`) read lock-protected snapshots — they never wait for the player thread. |
| Main thread (iOS & Android) | the engine, AVPlayer / ExoPlayer, audio session / focus, media session, timers. Every command is posted here in call order. |
| Background | iOS: the HTTP loader queue (data → AVPlayer), `NWPathMonitor`; Android: Media3's playback thread. Observations hop to the main thread before reaching the engine; Android observations are additionally posted to the next main-loop turn so they never re-enter an engine command (ExoPlayer can call listeners synchronously from inside `setPlayWhenReady`). |
| Audio render thread (iOS keepalive) | only the dither generator; no locks, no allocation. |
