# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `player.setAudioSampling()` and the `audioSample` event: decoded-audio windows for visualizers. Android: an ExoPlayer audio-sink tap. iOS: an audio tap for files, and for live streams a parallel AudioToolbox decode of the proxied bytes, released against the item's clock.
- `updateNowPlaying({ duration, elapsed })`: song progress on the lock screen / notification for live streams, advanced natively only while audio plays.

### Fixed

- Android: local (`file://`) artwork is now published as image bytes. The system media controls load an artwork URI themselves, cross-process, and could not open the app's private file (`ENOENT`), so the cover was missing.

## [0.1.0] — 2026-10-03

First release.

### Added

- `Player` with `load` / `play` / `pause` / `toggle` / `stop` / `reset` / `seekTo` / `setVolume` / `setMuted` / `setRate` / `updateNowPlaying` / `release`, sequence-numbered status snapshots, synchronous `getProgress()`, and typed events (`status`, `stateChange`, `metadata`, `error`, `ended`, `remoteCommand`, `diagnostic`).
- React hooks: `usePlayerStatus`, `usePlaybackState`, `useProgress`, `useStreamMetadata`, `usePlayerEvent`.
- Native playback engine (Swift and Kotlin twins, one shared conformance suite): play-intent state machine, generation-based stale-event rejection, stall / silent-stall / dead-socket detection, jittered backoff, offline probing, network-handoff awareness, live-edge drift policy, paused-stream connection release, give-up limit.
- iOS: AVPlayer driver; app-owned HTTP connections through an in-process loopback proxy (deterministic connection teardown, late requests refused, parallel AVFoundation requests coalesced onto one connection, dropped live connections spliced into the same response with ICY re-framing); audio-session coordinator (interruptions, route loss, media-services reset); Now Playing and remote commands; background keepalive during recovery.
- Android: ExoPlayer (Media3 1.11.1) driver with gapless live continuations; HTTP through Media3's OkHttp data source, with every call cancelled when its item is torn down (dead sockets close at once, no pooled idle connections); Media3 session service with an engine-backed session player; app-wide audio-focus coordinator (incl. Android 15 background rules); network monitor; recovery wake/Wi-Fi locks.
- ICY metadata normalization shared by both platforms (UTF-8 / Windows-1252, mojibake repair, robust field parsing, configurable title format).
- Normalized `PlayerError` codes preserving native error chains.
- Expo config plugin.
- Example apps (bare React Native and Expo), a controllable ICY test server, on-device integration scenarios, and a soak monitor.
