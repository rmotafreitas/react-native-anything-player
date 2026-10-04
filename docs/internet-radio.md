# Internet radio & ICY metadata

Internet radio is a first-class use case, not "a file that never ends".

```ts
const radio = new Player({ mediaSession: { commands: ['next', 'previous'] } });

await radio.load({
  uri: 'https://stream.example.com/live.mp3',
  metadata: { title: 'Example FM', artwork: 'https://example.com/logo.png' },
});
await radio.play();

radio.on('metadata', (m) => console.log(m.artist, m.title, m.station));
radio.on('remoteCommand', ({ command }) => { /* next/previous → switch station */ });
```

## What happens on the wire

**iOS.** AVPlayer plays the stream through a small in-process HTTP proxy bound to `127.0.0.1`; the connection to the station is made by the app's own `URLSession`. AVPlayer still sees a genuine live HTTP stream (its own buffering, its own ICY metadata parsing), while Airwave owns the sockets:

- the connection is closed the moment the player stops, re-opens, or is released, and late requests for a discarded item are answered locally — AVFoundation's internal retries can otherwise keep a discarded stream downloading in the background indefinitely (reproduced);
- when the station drops the connection after streaming for a while, the proxy reconnects and continues the same response, so playback goes on from the buffer without a gap (ICY metadata is re-framed across the new connection);
- AVFoundation occasionally opens two identical requests for one item; the proxy serves both from one station connection.

The ICY response headers (`icy-name`, `icy-genre`, `icy-br`) are read from the proxied response. HLS (`.m3u8`) is played by AVFoundation directly. The proxy only listens on loopback and needs no `Info.plist` entry (verified with `NSAllowsLocalNetworking` removed: AVPlayer's requests to `127.0.0.1` are not blocked by App Transport Security). The connection to the station is subject to ATS as usual: `https`, or an exception for cleartext stations — a blocked cleartext URL fails with `INVALID_SOURCE`.

**Android.** Media3's ICY support de-interleaves the stream; Airwave reads the raw metadata bytes and normalizes them with the same rules as iOS.

Either way, **one connection per open** (verified against a test server that counts connections).

## ICY metadata

Each `metadata` event is a `MediaMetadata`:

```ts
{
  title: 'Sweet Child O\' Mine',
  artist: 'Guns N\' Roses',
  station: 'Example FM',          // icy-name
  genre: 'Rock',                  // icy-genre
  artwork: { uri: 'https://…' },  // StreamUrl, only when it points to an image
  raw: { StreamTitle: "Guns N' Roses - Sweet Child O' Mine", StreamUrl: '…' },
  timestamp: 1730000000000,       // epoch ms when it became audible
}
```

Normalization rules (identical on both platforms, verified by a shared test file):

- **Charset**: UTF-8 when the bytes are valid UTF-8, otherwise Windows-1252 (the Shoutcast legacy charset, a superset of Latin-1's printable range). Text a platform already mis-decoded (`CafÃ©`) is repaired; genuine Latin-1 (`Café`) is left alone.
- **Fields**: `key='value';` pairs; values may contain quotes and semicolons (`Guns N' Roses`, `A; B`). Unterminated blocks are tolerated. Blocks with no `StreamTitle`/`StreamUrl` (corrupted framing) are dropped.
- **Splitting**: `StreamTitle` is split on the first ` - ` (also ` – `, ` — `, ` ~ `) as `Artist - Title`. Stations that send `Title - Artist` or an unsplittable string can set `metadata.streamTitleFormat` to `'title-artist'` or `'title'`. A separator-only title (`' - '`) means "nothing playing".
- **Timing**: metadata is published when the audio it describes is **heard**, not when it arrives over the network (the buffer can be many seconds deep). Android uses Media3's metadata renderer; iOS schedules each block by its byte offset and the stream bitrate (`icy-br`).
- **Station**: `icy-name`/`icy-genre` are available on both platforms.

The lock screen shows stream metadata on top of the source's `metadata`; see [Now Playing precedence](background-and-system.md#what-the-lock-screen-shows).

## Live edge

A live stream that falls behind (pauses, stalls) plays stale audio when it resumes. Airwave tracks how far behind it is (*drift*) and re-opens the stream at the live edge — but only at moments that are silent anyway:

- resuming after a pause or interruption longer than the drift budget (`recovery.liveMaxDriftMs`, default 5 s);
- during a stall that would push the drift over the budget.

It never cuts audio that is flowing just to catch up: being a few seconds behind live is inaudible, an extra gap is not.

A paused live stream keeps downloading audio that resuming will never play, so its connection is **released after 30 s** of pause; `play()` re-opens at the live edge.

## Recovery

| Situation | What Airwave does |
|---|---|
| Server closes the connection | iOS: AVPlayer re-requests inside the item through Airwave's loader (seamless). Android: a continuation of the stream is queued in Media3's playlist and plays gaplessly. A circuit breaker (4 connections per 10 s) stops servers that keep closing from causing a storm; past it, the engine reconnects with backoff. |
| Socket alive but silent | Detected after 3 s with no incoming data (1.5 s right after a network change) and re-opened. |
| Playhead frozen without a native report | "Silent stall": detected after 4 s (2 s after a network change). |
| Slow link (data trickles in) | Left alone for up to 20 s; the live-edge rule still applies. |
| Recoverable failure | Reconnect: immediately after stable playback, then 1 s, 2 s, 4 s … 30 s (±20 % jitter). |
| Offline | Attempts are skipped (every third runs as a probe); the moment connectivity returns, it re-opens. |
| Wi-Fi ↔ cellular handoff | Stall detection becomes eager; a stall in progress re-opens immediately. |
| HTTP 404/410/403/401, unsupported format | Fatal: `state: 'error'`, no retries. |
| 10 minutes without stable playback | Gives up (`recovery.giveUpAfterMs`, `null` = never). |

Every constant and the production failure behind it: [recovery.md](recovery.md).

## Testing against a misbehaving server

The repository ships a controllable ICY server (`scripts/stream-server/server.mjs`) that can stall, drop, end, throttle, refuse, return HTTP errors, send Latin-1 or malformed metadata, and reports open connections — the harness behind Airwave's own integration tests. Run it with `node scripts/stream-server/server.mjs` after `scripts/stream-server/generate-media.sh`.
