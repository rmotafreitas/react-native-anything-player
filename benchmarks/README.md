# Benchmarks

Reproducible comparisons between Airwave and the other React Native audio libraries. The results and charts are published in [docs/comparison.md](../docs/comparison.md).

| Script | What it measures | Output |
|---|---|---|
| `node benchmarks/size/measure.mjs` | npm tarball and unpacked size, native lines compiled into the app, Android Maven artifacts, JS bundle cost (min+gz) — for Airwave (packed from this checkout) and every competitor (latest on npm) | `results/size.json` |
| `node benchmarks/charts/render.mjs` | renders the charts from `results/` | `docs/assets/charts/*.svg` |
| — (curated) | capability matrix read from each package's source, with evidence per row | `results/capabilities.json` |

Needs Node ≥ 20, npm, and network access to the npm registry. The size script runs `yarn prepare` first if `lib/` is missing.

## On-device benchmarks (protocol)

Cross-library runtime numbers need real devices; they are **not published yet**. This is the protocol they will follow. Every run uses the repository's controllable stream server (`scripts/stream-server/server.mjs`), which can drop, stall, throttle and refuse connections, and counts them server-side.

| Benchmark | Scenario | Metric |
|---|---|---|
| Time to first audio — file | `load(require('./tone.mp3'))` + `play()` | ms from the `play()` call to the first `playing` state (median of 50 runs, cold and warm) |
| Time to first audio — live | the test station, 128 kbps MP3 | same, live stream |
| Drop recovery | the server closes the connection every 15 s for 5 min | silent seconds (server-side byte gaps plus the player's state), and connections opened |
| Outage recovery | the server refuses connections for 30 s, then returns | seconds from the server's return to audio |
| Handoff | Wi-Fi ↔ cellular switch (device), or `svc wifi disable` with data on (Android) | seconds of silence |
| Dead socket | the server stops sending without closing | seconds until audio returns, and whether the dead socket was closed |
| Connection hygiene | `stop()` / `release()` / 10 rapid station switches | open connections afterwards (server-side count) |
| Bridge traffic | 60 s of playback with one progress hook mounted | native → JS events per minute |
| Memory | 45 min soak, app backgrounded | RSS / PSS at start, 15, 30 and 45 min |

Rules: Release builds; same device and OS for every library; each library at its documented defaults, with the app code its docs recommend for recovery (e.g. RNTP's `retry()` on `PlaybackError`) — a library is never handicapped by leaving out what its docs say to write. Raw results are stored next to `size.json` and charted by `render.mjs`.
