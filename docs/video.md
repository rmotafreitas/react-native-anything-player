# Video

A video is a `Player` with a picture. It gets everything a stream already has: the native engine that keeps playing and recovering while JavaScript is frozen, reconnects with backoff on bad networks, the lock screen, AirPlay and Cast. What video adds is the picture, subtitles, qualities, fullscreen and Picture in Picture.

```tsx
import { Player } from 'react-native-anything-player';
import { VideoView, useCues } from 'react-native-anything-player/video';

const player = new Player({ video: true });
await player.load('https://cdn.example/episode.m3u8', { autoplay: true });

function Screen() {
  return <VideoView player={player} style={{ aspectRatio: 16 / 9 }} />;
}
```

It works on iOS, Android, Expo web, React Native Web, React DOM and plain pages, with the same code. On iOS and Android it is a build option ([below](#enabling-it)).

The player and the view are separate. Unmounting `<VideoView>` does not stop the player: the sound goes on (what the background does is [`whenBackgrounded`](#in-the-background)), and mounting a view for the same player elsewhere shows it there, without a gap. One view shows the picture at a time: the last one mounted.

## Sources

`load()` takes what an audio player takes, plus a video's extras:

| Source | What it is |
|---|---|
| `'https://…/master.m3u8'` | HLS: the player picks the quality as the network allows (under [RNAP's caps](#quality)), with the manifest's audio languages and subtitles as [tracks](subtitles.md#the-sources-own-tracks) |
| `'https://…/manifest.mpd'` | DASH, the same way ([below](#dash)) |
| `'https://…/movie.mkv'`, `.webm`, `.ts`, an IPTV channel | Matroska, WebM and MPEG-TS, on demand or live, with the file's audio languages and subtitles as [tracks](subtitles.md#the-sources-own-tracks) ([below](#matroska-webm-and-mpeg-ts)) |
| `'https://…/episode.mp4'`, `file://…`, `require('./intro.mp4')` | a file, streamed as it downloads |
| `{ renditions: [...] }` | separate files of one video at different qualities: RNAP picks one and [switches between them](#renditions) behind the picture |
| `{ uri, subtitles: [...] }` | [subtitle files](subtitles.md) (SubRip, WebVTT, TTML, ASS) next to the video |
| `{ uri, poster }` | an image shown until the first frame |
| `{ uri, refresh, expiresAt }` | a signed URL: RNAP asks `refresh` for a new one on a 401/403 or a minute before `expiresAt`, and goes on where it was |
| `{ uri, thumbnails }` | a WebVTT thumbnail track, for `getThumbnail(time)` in a scrubber |

```ts
await player.load({
  uri: 'https://cdn.example/ep1/master.m3u8',
  poster: 'https://cdn.example/ep1/poster.jpg',
  subtitles: [{ uri: 'https://cdn.example/ep1/pt.srt', language: 'pt' }],
  refresh: async () => ({ uri: await signedUrl('ep1') }),
  metadata: { title: 'Episode 1', artist: 'The show' },
});
```

### DASH

| Platform | How |
|---|---|
| Android | ExoPlayer plays it. Media3's DASH module is in every video app; an audio-only app adds it with `rnapDash=true` in `android/gradle.properties`, and a video app that never plays DASH drops it with `rnapDash=false`. Without it, a `.mpd` fails with `UNSUPPORTED_FORMAT` saying so. |
| iOS | AVPlayer has no DASH, so RNAP rewrites the manifest as HLS playlists that point at the manifest's own segments (fragmented MP4, the CMAF profile most packagers emit), on demand and live. Nothing to install. A manifest addressed by byte ranges (`SegmentBase`) is refused with `UNSUPPORTED_FORMAT`. |
| Web | [Shaka Player](web.md#dash), registered with `configureShaka(shaka)` |

### Matroska, WebM and MPEG-TS

ExoPlayer reads these containers itself. AVPlayer and most browsers do not, so RNAP remuxes them there: it gives the frames another container (fragmented MP4) and leaves the decoding to the platform. Nothing is transcoded, so the picture and sound are the file's, at the cost of a little CPU.

| Platform | How |
|---|---|
| Android | ExoPlayer plays them, with the file's audio tracks and its SubRip, ASS and WebVTT subtitles |
| iOS | RNAP serves the file to AVPlayer as HLS from the app (the same loopback server as streams): a segment is remuxed when AVPlayer asks for it, from the byte the file's Cues name (Matroska) or its bitrate suggests (MPEG-TS). Each audio track and subtitle track is an HLS rendition, so AVPlayer lists them as it does for any HLS source. A live MPEG-TS channel becomes a live playlist, and a dropped connection is reopened |
| Web | RNAP reads the file with `fetch()` and feeds the element through Media Source Extensions. Matroska is always remuxed, which is what lists its audio languages and subtitles. WebM and MPEG-TS are remuxed only where the browser does not play them (no browser plays MPEG-TS). Seeks use the same Cues and bitrate guesses |

Picking another audio track remuxes it from where the picture is. A file's subtitles (SubRip, ASS, WebVTT) are drawn by RNAP's overlay; bitmap subtitles (PGS, VobSub, DVB) are listed as unsupported.

A source whose URL names no format (an IPTV channel's path, a picked file) is tried as it is first. If the platform cannot open it, RNAP sniffs its first bytes and remuxes it when it is Matroska or MPEG-TS.

What it needs:

- **The codecs:** the platform has to decode them. H.264, HEVC, VP9 and AV1 video play wherever the platform has a decoder. AAC, MP3, AC-3, E-AC-3, Opus and FLAC sound play where the platform has those. AC-3 and E-AC-3 are Safari and Apple devices only, and Chromium takes no MP3 inside MP4, so such a track is left out there. A codec the platform lacks (MPEG-2, VC-1, DTS, TrueHD, Vorbis) fails with `UNSUPPORTED_FORMAT` naming it; software decoders are [planned](video-design.md#software-decoders).
- **On the web, CORS:** the server must allow cross-origin reads (`Access-Control-Allow-Origin`), with range requests for seeking. Without CORS, the element gets the URL as it is, which works where the browser reads the container itself (Matroska and WebM in Chromium and Firefox), without the tracks.
- **On iOS, range requests:** a file is read by ranges. A live channel needs none.

## The view

| Prop | Default | |
|---|---|---|
| `player` | required | a video player |
| `contentFit` | `'contain'` | `'contain'` (letterboxed), `'cover'` (cropped to fill), `'fill'` (stretched) |
| `nativeControls` | `false` | the platform's controls: AVKit's on iOS, the browser's on the web; Android has none of its own, so RNAP draws light ones (play/pause, the time, a seek bar, fullscreen) |
| `style` | | give it a size: `{ aspectRatio: 16 / 9 }`, or a width and height |

Without `nativeControls`, build your own from the status and the hooks (`usePlayerStatus`, `useProgress`); taps on the view reach your components. On plain pages, `player.attachTo(element, { contentFit })` puts the picture in an element.

`player.status.video` says what the picture is doing:

| Field | |
|---|---|
| `width`, `height`, `hdr` | the picture playing |
| `firstFrame` | a frame of the current source has been shown (the `firstFrame` event too) |
| `qualities`, `quality`, `selectedQuality` | the [qualities](#quality) |
| `tracks`, `audioTrack`, `textTrack`, `subtitleDelay` | the [audio and text tracks](subtitles.md) |
| `audioOnly` | why the sound plays alone (`listen`, `background`, `fallback`), else `null` |
| `pictureInPicture`, `fullscreen` | the system windows (`pictureInPictureChange`, `fullscreenChange` events) |

## Quality

Adaptive sources (HLS) are switched by the platform's own player (AVPlayer, ExoPlayer, hls.js) under caps RNAP keeps:

| Cap | Default | Option (`video.quality`) |
|---|---|---|
| The view's size | never more pixels than the view shows (a 360 px tall view gets at most 360p; fullscreen lifts it) | `capToView: false` |
| A metered network (cellular, a hotspot) | none | `cellular: { maxResolution, maxBitrate }` |
| Data Saver, Low Data Mode, `saveData` | at most 480p | `followDataSaver: false` |
| Always | none | `maxResolution`, `maxBitrate` |
| Where automatic starts | the network decides | `startQuality: 'lowest' \| 'highest' \| <height>` |

Picture in Picture keeps the cap the view had: no switch, and no rebuffer, on the way in or back.

`player.selectQuality(id)` pins one of `status.video.qualities` (on HLS, AVPlayer can only take it as a ceiling); `selectQuality('auto')` hands it back.

### Renditions

Separate files of one video, one per quality, are switched by RNAP itself: it starts at the lowest file 480p or taller (or the caps' choice), steps down on stalls or a bandwidth that stays too low, steps up after 30 s of headroom, and follows `selectQuality`. A switch opens the new file behind the picture, a little ahead of it, and swaps when it plays: no spinner, no jump. A file that fails sits out a minute.

```ts
await player.load({
  renditions: [
    { uri: 'https://cdn.example/ep1-360.mp4', height: 360 },
    { uri: 'https://cdn.example/ep1-720.mp4', height: 720 },
    { uri: 'https://cdn.example/ep1-1080.mp4', height: 1080 },
    { uri: 'https://cdn.example/ep1-audio.m4a', audioOnly: true },
  ],
});
```

A missing `height` or `bitrate` is read from the file. No `uri` is needed next to `renditions`.

### Sound alone

- `player.setListenOnly(true)` plays the sound alone: the audio-only variant or rendition when there is one, else the picture stops decoding.
- `video: { fallbackToAudio: true }` drops to the sound alone on a network too slow for any picture (under 1.2× the lowest quality for 10 s, or 2 stalls in 30 s) and brings the picture back after 30 s of headroom. It needs an audio-only option.

## In the background

`video.whenBackgrounded` decides what leaving the app does:

| Value | |
|---|---|
| `'pause'` (default on iOS and Android) | pause; the user resumes from the lock screen or the app |
| `'audio'` (default on the web, where a hidden tab plays on) | keep the sound and the lock screen, stop the picture, switch to an audio-only variant where there is one |
| `'pip'` | go into Picture in Picture; where that is not possible, pause |

`video: { ambient: true }` is for decorative loops: muted, looping, no audio focus, no lock screen, paused while off screen or in the background and resumed when shown again. A muted video takes no audio focus either (`focusWhenMuted: true` changes that).

The screen stays on while a video plays in a visible view (`keepAwake: false` turns that off).

## Fullscreen

`player.presentFullscreen({ lockOrientation: 'landscape' })` opens the platform's fullscreen player: AVKit's on iOS, a fullscreen window with RNAP's controls on Android (system bars hidden, around the camera cutout; Back closes it), the Fullscreen API on the web (`webkitEnterFullscreen` on iPhone Safari). `lockOrientation` holds the screen in `landscape` or `portrait` while it lasts. `dismissFullscreen()` closes it.

## Picture in Picture

`player.startPictureInPicture()` moves the picture into a floating window; `stopPictureInPicture()` brings the app back. With `whenBackgrounded: 'pip'`, leaving the app does it on its own (iOS from an inline view, Android 12+ from the system's auto-enter, Android 8–11 on the user-leave hint).

| Platform | Needs |
|---|---|
| iOS | the `audio` background mode ("Audio, AirPlay, and Picture in Picture") |
| Android | `android:supportsPictureInPicture="true"` on the main activity, with `screenSize\|smallestScreenSize\|screenLayout\|orientation` in its `android:configChanges` |
| Web | a browser with the Picture-in-Picture API (Chromium) or Safari |

The Expo plugin's `video` option sets both. Without them `startPictureInPicture()` rejects with `INVALID_ARGUMENT`, saying what is missing.

## AirPlay and Cast

A video goes to an AirPlay or Cast device like a stream does ([Casting & AirPlay](routes-and-casting.md)). On a Cast receiver it plays with a movie's title line, and the app's [subtitle files](subtitles.md) go with it as WebVTT tracks; `selectSubtitles` switches them while casting. Renditions go as the file playing. AirPlay keeps a video playing in the background.

## Enabling it

On iOS and Android video is a build option, like Cast and Sound, so audio apps ship none of it:

| Where | Option |
|---|---|
| `npx rnap add video` | writes the two below in a bare project, and prints the Picture in Picture manifest step |
| `android/gradle.properties` | `rnapVideo=true` |
| `pod install` | `RNAP_VIDEO=1` (or `"rnap.video": "true"` in `ios/Podfile.properties.json`) |
| Expo config plugin | `["react-native-anything-player", { "video": true }]` (`{ "video": { "pictureInPicture": false } }` leaves Picture in Picture out) |

Without it, `new Player({ video })` throws `VIDEO_UNAVAILABLE` (the message says how to turn it on), and `<VideoView>` is an empty box. The web needs no switch.

## Errors

| Code | When |
|---|---|
| `VIDEO_UNAVAILABLE` | `new Player({ video })` on iOS or Android in an app built without the video module |
| `DRM_UNSUPPORTED` | `load()` of a source with `drm` (DRM is designed, not shipped yet: [design](video-design.md)) |
| `SUBTITLE_LOAD_FAILED` | non-fatal: a subtitle file could not be fetched or read; the video plays on |
| `INVALID_ARGUMENT` | a quality or track id not in the status; Picture in Picture where there is none |

See [Errors](errors.md) and [Subtitles](subtitles.md).
