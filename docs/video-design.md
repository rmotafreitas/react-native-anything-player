# Video: design

> [!NOTE]
> This is the design record for the video module, agreed on 2026-10-24. Nothing in it has shipped yet: the parts land one by one on the `feat/video` branch, and each part's user guide (Video, Subtitles) replaces the matching section here when it ships. Its [release plan](#release-plan) is the order.

Video follows the rest of RNAP: **lightweight, bulletproof, best DX**. It is not a second library inside the package. A video is a `Player` with a picture, so it gets everything a stream already has: the native engine, recovery while JavaScript is frozen, the conformance suite, the lock screen, AirPlay and Cast. What video adds is the picture, the subtitles and the bandwidth: the parts below.

## Status

| Part | State |
|---|---|
| Engine rules (background, PiP, ambient, muted focus, keep-awake, quality caps, renditions and switches, audio-only fallback, refresh, loop, tracks, delay, fullscreen, stats) | **Done** in the three engines, 178 shared scenarios (`conformance/video.json`) |
| Subtitles: SubRip, WebVTT, basic ASS, TTML parsing; encoding detection; cue timing; track choice | **Done** (parsing in TypeScript; encoding, timing and track choice also in Kotlin and Swift, held to `conformance/subtitles/` and `conformance/tracks/`) |
| The API: `video` option, `status.video`, the commands and events, `attachTo`, `<VideoView>` (React DOM, React Native Web) | **Done** |
| Web: `<video>`, hls.js variants and caps, renditions switched behind the picture, subtitle overlay, fullscreen, Picture in Picture, wake lock, hidden tabs | **Done**, Playwright on Chromium, Firefox and WebKit (`e2e/video.spec.ts`) |
| Android: the picture (ExoPlayer on a `TextureView` that keeps its frame between views), `<VideoView>`, renditions switched behind the picture, the source's tracks and variants, the subtitle overlay in the OS caption style, fullscreen, Picture in Picture (auto on Android 12+), keep-awake, light controls, posters, the `rnapVideo` switch | **Done**, on the emulator with the example app (file, renditions + SubRip, HLS with two audio languages and WebVTT groups) |
| Android and iOS: loop, exact seeks, refresh, `fetchText` | **Done** |
| iOS: the picture (`AVPlayerLayer`s in a stage moved between `<VideoView>`s), renditions switched behind the picture, the source's audio and text options and HLS variants, the legible output in the MediaAccessibility caption style, AVKit's controls inline and in fullscreen (orientation lock), Picture in Picture (auto from inline), the idle timer, posters, the `RNAP_VIDEO` switch | **Written**; compiled and tried in macOS CI and on devices before it is called done |
| Web: the source's own tracks (hls.js audio and subtitle groups; Safari's own `audioTracks` and `textTracks`), drawn by RNAP's overlay; video players take hls.js over a native HLS without track lists (Chromium's) | **Done**, Playwright on Chromium, Firefox and WebKit |
| Cast video (web, Android, iOS): video content types, movie metadata, the app's subtitle files (any format) as the receiver's WebVTT text tracks (`data:` URLs, the subtitle delay applied), switched while casting; renditions go as the file playing | **Written**: the web against a scripted sender SDK, Android compiled and unit-tested, iOS compiled in macOS CI; to try on a real receiver |
| DASH: ExoPlayer's module (in video apps, `rnapDash` either way), CMAF DASH rewritten to HLS on iOS (`DashToHls`, golden fixtures in `conformance/dash/`) and served through the asset's resource loader, Shaka Player injected on the web (`configureShaka`, 4.x and 5.x) with its tracks and variants | **Done** on Android (emulator) and the web (Playwright, three browsers); iOS **written**, the converter tested on Linux |
| Remux of Matroska, WebM and MPEG-TS (also M2TS): the demuxers and fragmented MP4 writer twice, TypeScript and Swift, byte for byte against `conformance/remux/` (8 fixtures: H.264, HEVC, VP9, AV1; AAC, MP3, AC-3, E-AC-3, Opus, FLAC; SubRip, ASS; lacing; multiple audio tracks); the web through MSE (seeks by Cues or bitrate, live TS, audio switches, subtitles to the overlay); iOS as HLS from the loopback server (windows remuxed on request, a rendition per audio and subtitle track, live TS as a sliding playlist with reconnects); Android with ExoPlayer's extractors and their subtitles | **Done** on the web (Playwright, three browsers) and Android (emulator: tracks, subtitles, TS, live TS); iOS **written**: the serving tested on Linux against the test server, its HLS played by ffmpeg; AVPlayer to try in macOS CI |
| DRM: FairPlay (AVContentKeySession), Widevine, PlayReady and Clear Key (ExoPlayer's DRM sessions; EME on the web, Shaka's for DASH), Clear Key keys answered on the device, the app's `getLicense` over the bridge, protected sources kept off Cast | **Done** on the web (Playwright: Clear Key in Chromium and Firefox, keys, license server, `getLicense`, refusals) and Android (emulator: the same, plus FairPlay-only and wrong-system refusals); iOS **written**: the license registry tested on Linux, FairPlay to try on hardware |
| Software decoders on Android: Media3's FFmpeg (AC-3, E-AC-3, DTS, TrueHD, MPEG audio), libvpx and dav1d extensions, built from pinned sources (`scripts/decoders/build-android.sh`, the `Android decoders` workflow publishes them as a GitHub release) and downloaded by Gradle against pinned checksums (`rnapVideoDecoders`, `rnapDecodersDir`, `rnap add video-decoders`, Expo `videoDecoders`); renderers created by name after the platform's; an undecodable picture fails and an undecodable sound warns (Android and the web) | **Built**: the sound decoders tried on the emulator (AC-3, DTS, MPEG audio layer II heard; without them, the warning); VP9 and AV1 decode there but render wrongly (emulators mishandle the YV12 surfaces they write), so the picture is to try on a device; the first release is not published yet |
| Software decoders on iOS (`SampleBufferDriver`) and the web (an injected decoder) | In the release plan below |

## Decisions

| Topic | Decision |
|---|---|
| Engine | The same `PlaybackEngine` (Swift, Kotlin, TypeScript) and the same conformance suite, with video scenarios added (`conformance/video.json`). |
| Players | The OS's: AVPlayer, ExoPlayer (Media3), the browser's `<video>`. Formats they cannot read are **remuxed** (repackaged, not decoded) on iOS and the web. Software decoders are separate opt-in modules. |
| API shape | The player is separate from the view: `<VideoView player={player} />`; `player.attachTo(element)` on plain pages. One view at a time; moving to another view keeps playing. |
| Controls | None by default (build them from `status` and the hooks). `nativeControls` opts into the OS's own: AVKit's on iOS, the browser's on the web, and on Android (which has none) RNAP's light ones: play/pause, the time, a seek bar and fullscreen, plain platform widgets with no extra library. Fullscreen always has them. |
| Packaging | The same package, a `/video` entry, and a build switch on native (`rnapVideo`, `RNAP_VIDEO`, Expo `video: true`, `npx rnap add video`). The web needs no switch: the video code is a separate chunk loaded on the first video player. |
| Use cases in v1 | Long-form on demand, live, ambient loops. Feeds (TikTok-style): design only, [below](#feeds). |
| Platforms | Phase 1: iOS, Android (with Android TV and Fire TV), the web (Expo web, React Native Web, React DOM, plain pages, Electron and Tauri). Phase 2: tvOS, macOS. Phase 3: visionOS. Windows: roadmap. |
| Delivery | Progressive files, HLS (with LL-HLS), DASH, MPEG-TS live and on demand (IPTV). RTSP and Smooth Streaming as Android switches. The SRT protocol, RTMP, WebRTC and FLV: roadmap. |
| Audio without the picture | `whenBackgrounded: 'pause' \| 'audio' \| 'pip'` (default `'pause'`), audio track choice, listen-only, an opt-in automatic audio-only fallback on bad networks. |
| Quality | Native ABR for HLS/DASH under RNAP's caps; separate files per quality (`renditions`) are managed by the engine, switched without a spinner. |
| Cloud files | Headers, signed URLs, and a `refresh` hook on 401/403 or expiry. No provider SDKs. |
| Subtitles | SubRip, WebVTT, TTML/IMSC, CEA-608/708, MP4 and MKV text tracks, basic ASS. One cue pipeline, one RNAP overlay that follows the OS caption settings, `useCues()` for custom rendering. Full ASS (libass): design only. |
| DRM | `drm` by key system; each platform uses the first one it has. License servers by URL and headers, Clear Key keys in the source, or the app's `getLicense` for providers that wrap their requests. Temporary licenses only until downloads. |
| System | Picture in Picture everywhere, AirPlay / Cast / Remote Playback video, the media session (skip ±10 s on demand), keep-awake, fullscreen, muted videos take no audio focus. |

## API

```tsx
import { Player } from 'react-native-anything-player';
import { VideoView, useCues } from 'react-native-anything-player/video';

const player = new Player({
  video: {
    whenBackgrounded: 'pip', // 'pause' (default) | 'audio' | 'pip'
    fallbackToAudio: true, // off by default
    quality: { cellular: { maxResolution: 720 } },
  },
});

await player.load({
  uri: 'https://cdn.example.com/ep01/master.m3u8',
  headers: { Authorization: `Bearer ${token}` },
  refresh: async () => ({ uri: await signUrl('ep01/master.m3u8') }),
  subtitles: [
    { uri: 'https://cdn.example.com/ep01/pt.srt', language: 'pt' },
    { uri: 'https://cdn.example.com/ep01/en.vtt', language: 'en' },
  ],
  thumbnails: 'https://cdn.example.com/ep01/thumbs.vtt',
  poster: 'https://cdn.example.com/ep01/poster.jpg',
  metadata: { title: 'Episode 1', artist: 'Show' },
});

export function Screen() {
  return <VideoView player={player} contentFit="contain" style={{ aspectRatio: 16 / 9 }} />;
}
```

| | |
|---|---|
| `new Player({ video })` | A video player. `video: true` takes every default. Without the build switch on iOS/Android: `VIDEO_UNAVAILABLE`, saying how to turn it on. |
| `video.ambient` | A preset for decorative loops: muted, looping, no audio focus, no media session, paused while off screen or in the background (and resumed when back). |
| `video.whenBackgrounded` | `'pause'`: pause (the platform convention). `'audio'`: keep the sound and the lock-screen controls, stop decoding the picture, and switch to an audio-only variant when there is one. `'pip'`: go into Picture in Picture; when it is not possible, pause. |
| `video.keepAwake` | Keep the screen on while playing in a visible view. Default `true`. |
| `video.focusWhenMuted` | A muted video takes no audio focus and no media session until it is unmuted, so the user's music keeps playing. Default `false`. |
| `video.fallbackToAudio` | On a network too slow for the lowest video quality, play the audio alone and bring the picture back when it recovers. Default `false`. |
| `video.quality` | `maxResolution`, `maxBitrate`, `cellular: { maxResolution, maxBitrate }`, `startQuality: 'auto' \| 'lowest' \| 'highest' \| <height>`, `followDataSaver` (default `true`), `capToView` (default `true`: never more pixels than the view shows). |
| `video.tracks` | `languages` (preferred, in order), `followSystem` (captions and audio descriptions from the OS accessibility settings, default `true`). |
| `video.hdr` | `false` keeps HDR sources on SDR variants. Default `true`. |
| `load({ renditions })` | Separate files of one video at different qualities: `[{ uri, height?, bitrate?, label?, audioOnly? }]`, with no `uri` needed beside them. RNAP picks, switches and falls back; a missing height or bitrate is read from the file. |
| `load({ subtitles })` | `[{ uri \| text, language, label?, format?, forced?, default?, encoding? }]`, before or after `load()` (`player.addSubtitles()`). |
| `load({ refresh, expiresAt })` | Called on 401/403, and ahead of `expiresAt`; returns the new source. |
| `load({ drm })` | `{ fairplay?, widevine?, playready?, clearkey?, getLicense? }` ([Video](video.md#drm)). |
| `player.selectQuality(id \| 'auto')`, `selectAudioTrack(id)`, `selectSubtitles(id \| null)`, `setSubtitleDelay(s)`, `setListenOnly(b)`, `setLoop(b)` | Commands. |
| `player.presentFullscreen({ lockOrientation })`, `dismissFullscreen()`, `startPictureInPicture()`, `stopPictureInPicture()` | The system UI. |
| `player.getThumbnail(t)`, `player.getStats()`, `seekTo(t, { exact })` | Seek previews, quality-of-experience numbers, frame-accurate seeks. |
| `status.video` | Size, HDR, first frame, the qualities and the current one, the tracks, audio-only and why, Picture in Picture. |
| Events | `cues` (and `useCues()`), `stats`, `firstFrame`, `pictureInPictureChange`, `fullscreenChange`. |

## Architecture

### The engine

Video decisions are engine decisions: they have to keep working while JavaScript is frozen, and races between them are exactly what the conformance suite exists for. The engine gains these inputs, all generation-guarded where they come from a driver:

| Input | Effect |
|---|---|
| `appBackgrounded()` / `appForegrounded()` | The `whenBackgrounded` policy. `'pause'` pauses (`interruption.reason: 'background'`, not resumed by itself); `'audio'` turns the picture off and asks for audio only; `'pip'` keeps playing only while Picture in Picture is up. Ambient players pause and resume. |
| `viewChanged({ attached, visible, width, height })` | No view for 1 s turns decoding off (a move between views keeps it); off screen pauses an ambient player (`'offscreen'`, resumed when visible); the size caps the quality. |
| `pictureInPictureChanged(active)` | Closing Picture in Picture while in the background pauses after a 1 s grace (the "back to app" button foregrounds the app first). The quality cap stays what the view had: no switch, and no rebuffer, on the way in or back. |
| `networkCostChanged(metered, saveData)` | Cellular caps, Data Saver / Low Data Mode / `saveData`. |
| `onBandwidth(gen, bps)`, `onVariants(gen, variants)`, `onVideoInfo(gen, info)`, `onFirstFrame(gen)` | Bandwidth estimates and the source's facts. |
| `selectQuality`, `setListenOnly`, `setLoop`, `sourceRefreshed` / `sourceRefreshFailed` | Commands. |

New driver commands: `setVideoEnabled(on)`, `setQuality({ maxHeight, maxBitrate, pinned, audioOnly })` (adaptive sources), `setLoop(on)`, `cancelSwap(gen)`, and `open` with `swap: true`.

**Renditions** (separate files per quality) are the engine's: it picks the start (caps, network, view size, the last bandwidth estimate), steps down on stalls or a sustained low bandwidth, steps up after 30 s of headroom, and honours a manual choice. A switch is a transaction, like the Cast handoff: the engine opens the new file at the current position under a **new generation with `swap: true`**; the driver prepares it behind the current picture and swaps on its first frame (`playing` for the new generation). Until then the old item is current and plays on. A failure, a 12 s timeout, a seek, a pause or a new load cancels the swap (`cancelSwap`), and a failed file sits out 60 s. Generations come from one monotonic counter, so a cancelled swap's late events can never be taken for the current item's.

**Audio-only fallback** (`fallbackToAudio`) drops to audio when the bandwidth stays under 1.2× the lowest video quality for 10 s, or after 2 stalls within 30 s, and returns after 30 s above 1.5× (or, with no bandwidth readings, after 60 s without a stall). With renditions it is the last step down, below the lowest video file. It needs an audio-only option (variant or rendition); without one it stays off.

**Refresh**: a 401/403 on a source with `refresh` asks JavaScript for a new source and waits up to 10 s (`reconnecting`, reason `refresh`), then re-opens at the same position. JavaScript frozen: the usual backoff, asking again on the next 401/403, until `giveUpAfterMs`. `expiresAt` asks 60 s ahead without interrupting playback; the next open uses the new source.

**Focus and the media session**: `needsAudioFocus` and a new `wantsMediaSession` are false for ambient players and for muted ones (unless `focusWhenMuted`). Unmuting asks for focus, and a refusal pauses like a refused `play()`. A new `wantsScreenAwake` drives keep-awake.

**Stats**: start-up time, rebuffer count and time, quality and audio-only switches, counted by the engine; the platform adds dropped frames and bandwidth.

### Drivers and views

| | iOS | Android | Web |
|---|---|---|---|
| Player | AVPlayer, `AVPlayerLayer` in a Fabric view | ExoPlayer on a `TextureView` whose `SurfaceTexture` outlives the view: moving to fullscreen, Picture in Picture or another view keeps the frame | `<video>`, one per player, moved between views |
| Video off | Layer detached (QA1668) | `setTrackTypeDisabled(VIDEO)` | No decoding to disable: audio-only variants only |
| Quality caps | `preferredMaximumResolution`, `preferredPeakBitRate` (and for expensive networks) | `TrackSelectionParameters` | hls.js / dash.js level caps |
| Swap (renditions) | A second AVPlayer and layer | A second ExoPlayer on its own `TextureView` under the first, muted until it takes over | A second `<video>`, unlocked with the first on the same gesture |
| Picture in Picture | `AVPictureInPictureController` (auto from inline) | The activity's PiP mode (auto-enter on Android 12+, the user-leave hint on 8–11 with androidx.activity 1.9+); the picture fills the window, the app hears `pictureInPictureChange`. The activity needs `android:supportsPictureInPicture` (the Expo plugin and `rnap add video --pip` add it) | Picture-in-Picture API |
| Fullscreen | `AVPlayerViewController`, modal | A fullscreen dialog, immersive, optional orientation lock | Fullscreen API; `webkitEnterFullscreen` on iPhone |
| Keep-awake | `isIdleTimerDisabled` | `FLAG_KEEP_SCREEN_ON` on the view | Screen Wake Lock |
| Captions settings | MediaAccessibility | `CaptioningManager` | — (browser defaults) |

### Formats the OS cannot read

| | Android | iOS | Web |
|---|---|---|---|
| MKV, WebM | ExoPlayer reads them | **Remuxed** by the stream proxy to fragmented MP4, served as an HLS playlist (H.264, HEVC, AV1 on A17 Pro/M3 and later; AAC, AC-3, E-AC-3, FLAC, Opus) | **Remuxed** to fragmented MP4 into MSE where the browser has no Matroska |
| MPEG-TS (files, IPTV) | ExoPlayer | Cut into a live or VOD HLS playlist (no remux) | Remuxed to fragmented MP4 into MSE |
| DASH | ExoPlayer | CMAF DASH rewritten to HLS by the proxy; other DASH: `UNSUPPORTED_FORMAT` | dash.js or Shaka, injected like hls.js |
| Codecs the OS lacks | Media3 decoder extensions (switch) | `SampleBufferDriver` (switch) | Injected wasm decoder |

The Matroska/TS demuxer exists twice, in Swift and TypeScript, held to shared golden fixtures (`conformance/remux/`) and fuzzed like the ICY parser. Subtitle tracks found in an MKV go into the cue pipeline.

### Software decoders

Three separate opt-in modules, built now, none blocking v1:

- **Android** (`rnap add video-decoders`, built): FFmpeg in an LGPL-only build with the AC-3, E-AC-3, DTS, TrueHD and MPEG audio decoders (Media3's FFmpeg extension is audio only), libvpx (VP9) and dav1d (AV1; Media3 moved to it from libgav1) through Media3's decoder extensions ([Video](video.md#software-decoders)).
- **iOS**: a second `EngineDriver`, `SampleBufferDriver`, chosen per item when AVPlayer cannot decode even after a remux: FFmpeg (LGPL, a **dynamic** xcframework) and dav1d into `AVSampleBufferDisplayLayer`, `AVSampleBufferAudioRenderer` and `AVSampleBufferRenderSynchronizer`; Picture in Picture through `ContentSource` (iOS 15+). AirPlay carries its audio, not its picture.
- **Web**: a canvas driver (WebCodecs where the browser has the codec, AudioWorklet output) with the decoder **injected** by the app (`configureSoftwareDecoder(...)` or `globalThis`), never bundled, like hls.js.
- **macOS** (phase 2): MediaExtension (macOS 15+).

The binaries are built in CI from pinned sources, reproducibly, and published on **GitHub Releases**; Gradle and the podspec download them at build time and check the SHA-256 pinned in the npm package, failing the build on a mismatch. The docs carry the LGPL source offer. Maven Central: on request.

### Subtitles

One pipeline on every platform: sideloaded files (URL, file or string) are fetched with retry and backoff, their encoding detected (Windows-1252, CP1251, Shift-JIS…, with the ICY charset repair), and parsed by the parser twins (SubRip, WebVTT, TTML/IMSC, basic ASS: text, bold/italic/underline, colours, alignment, `\pos`); embedded and manifest cues come from the platform (iOS legible output with player rendering suppressed, Media3 `onCues`, `TextTrack` `cuechange`). One native overlay draws them with the OS caption style; `useCues()` hands them to an app that draws its own. `setSubtitleDelay()` shifts them. Track choice (`conformance/tracks/`) follows the preferred languages, forced tracks, and the OS's captions / audio-description settings.

To a Cast receiver: WebVTT or TTML tracks by URL; other formats converted to WebVTT and sent as a `data:` URL where the receiver takes it, otherwise listed as unavailable there.

## Release plan

1. **Video v1 (1.3.0)**: the engine and conformance; web, Android and iOS drivers and views; renditions; subtitles; remux; CMAF DASH→HLS; PiP, fullscreen, AirPlay/Cast video; the Android decoders.
2. The iOS and web software decoders, each as soon as it passes the suite.
3. DRM: FairPlay, Widevine, PlayReady, ClearKey (**built**, see the status above). ClearKey runs in CI (Playwright Chromium and Firefox) and on the Android emulator; FairPlay, Widevine L1, PlayReady and Cast DRM are on the hardware list.
4. Separate audio and video URLs (`source: { video, audio }`), on demand: Media3 `MergingMediaSource`, two MSE source buffers, `AVMutableComposition`. Live pairs only through manifests.
5. Downloads for offline viewing, with persistent licences, together with Cache & preload.

Phase 2 (tvOS, macOS) and phase 3 (visionOS) follow; each brings the whole `Player`, minus what the platform lacks (CarPlay, Siri media intents).

## Design notes (not scheduled)

### Feeds

Short-video feeds need many players: a pool of 3 (previous, current, next) recycled as the user swipes, `preload(source)` of the next one (the Cache & preload work), muted autoplay with the no-focus rule above, a memory cap per player, and views that take a player from the pool. The engine's `swap` and the one-view-at-a-time rule are the building blocks.

### Full ASS (libass)

Karaoke, fonts, animations and vector drawing need libass with FreeType, HarfBuzz and FriBidi (2–4 MB per platform): an opt-in module that renders cues to bitmaps for the same overlay, fonts from the MKV attachments.

### 360° and VR

Equirectangular sources rendered on a sphere (SceneKit / Metal on iOS, Media3's `SphericalGLSurfaceView`, WebGL), with gyroscope and drag; visionOS's immersive video as its own step.

### Also on the roadmap

Chapters (MP4, MKV, HLS date ranges); client-side ads (IMA) as an opt-in module (server-side insertion already plays); HLS I-frame trick play and `snapshot()`; the SRT protocol, RTMP, WebRTC/WHEP and FLV; Windows (a fourth engine twin); the binaries on Maven Central.

## Testing

- The conformance suite: `video.json` (background modes, PiP, visibility, audio-only, renditions and swaps, refresh, focus), `subtitles/`, `tracks/`, `remux/`.
- Playwright video specs on Chromium, Firefox and WebKit; the simulator and the emulator end to end.
- On hardware: Picture in Picture, AirPlay, Cast, TVs, HDR, FairPlay.
- Benchmarks, like with like: against expo-video and react-native-video (6 and the 7 beta) on mobile, video.js, Vidstack, Shaka and hls.js on the web; added size, time to first frame, recovery, data used on cellular.
- Migration guides and `rnap migrate` codemods from expo-video and react-native-video.
