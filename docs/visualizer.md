# Visualizer (decoded audio)

RNAP can stream the audio it is playing as small windows of decoded PCM, for oscilloscopes, level meters and spectrum views. It is off by default and costs nothing while off.

```ts
const supported = player.setAudioSampling({ enabled: true, points: 1024 });

player.on('audioSample', ({ waveform, level, duration, outputLatency }) => {
  // waveform: `points` values in -1…1, mono, covering `duration` seconds.
  // Draw it `outputLatency` seconds from now to match what is heard.
});

player.setAudioSampling({ enabled: false });
```

| Field | |
|---|---|
| `waveform` | `points` samples (16…4096, default 1024), mono, -1…1 — downmixed and resampled natively |
| `level` | RMS loudness of the window, 0…1 |
| `duration` | seconds of audio in the window (~23 ms) |
| `outputLatency` | seconds until the window is heard; delay drawing by this much |
| `timestamp` | epoch ms the window is timed from: its first sample is heard at `timestamp + outputLatency`, on every platform |

Windows arrive at about 40 per second, on the JS thread. Turn sampling off while the visualizer is not on screen.

## How it works

**Android.** A `TeeAudioProcessor` in ExoPlayer's audio sink sees every decoded buffer on its way to the speaker. No `RECORD_AUDIO` permission is involved, unlike the platform `Visualizer` effect. `outputLatency` is how far the window's presentation time is ahead of the sink's playback position: the clock the player's position, its ICY metadata and `liveOffset` use, kept on what is heard by the platform's `AudioTrack` timestamps (the mixer, a Bluetooth route). Before the sink reports a position, the `AudioTrack` buffer, smoothed. The decoded audio is cut into windows of one fixed length, 1024 frames at 44.1 kHz (~23 ms) as on iOS, whatever size the codec's buffers come in (an HE-AAC buffer is 46 ms). When buffers come faster than windows are emitted (the decoder filling the output after a connect or a seek), their windows wait and go out together with the next ones, timed end to end. Only a flush, a format change or a jump drops the part of a window still waiting.

**iOS, files.** An `MTAudioProcessingTap` on the player item's audio track. The render thread only downmixes and measures the level; the waveform is resampled and the event emitted on a queue of its own. `outputLatency` is the audio session's output latency plus its I/O buffer, read when the session activates or the route changes (never on the render thread).

**iOS, streams.** AVPlayer never runs an audio tap on an HTTP stream: the tap is created but never prepared (verified on iOS 27, and the reason other libraries ship no iOS visualizer for radio). RNAP owns the stream's bytes (see the [stream proxy](internet-radio.md#what-happens-on-the-wire)), so it decodes a parallel copy with AudioToolbox (MP3, AAC, HE-AAC) and releases each window when the player item's clock reaches it. Windows are emitted when they are heard, so `outputLatency` is 0.

- A packet parser (no decoding) stamps every relayed chunk with its stream time, and the last 512 KB of relayed audio are kept. Turning sampling on mid-stream decodes that tail and starts from the playhead immediately, instead of waiting seconds for the player's buffer to play out.
- Decoding runs only while sampling is on. HE-AAC is decoded at its core rate (the waveform lacks the top octave, which a scope does not show).
- HLS (`.m3u8`, or a playlist behind a URL without the extension) is not relayed by the proxy, so it has no visualizer on iOS.
