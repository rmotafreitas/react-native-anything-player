# Subtitles

A video player shows subtitles from two places: the files the app gives it, and the source's own text tracks (an HLS manifest's subtitle groups, captions in the stream, an MP4's text track). Both go through one pipeline and one overlay, drawn over the picture in the user's caption style, the same on iOS, Android and the web. `useCues()` hands them to an app that draws its own.

```ts
await player.load({
  uri: 'https://cdn.example/ep1/master.m3u8',
  subtitles: [
    { uri: 'https://cdn.example/ep1/en.srt', language: 'en' },
    { uri: 'https://cdn.example/ep1/pt-BR.vtt', language: 'pt-BR', label: 'Português' },
    { text: '1\n00:00:01,000 --> 00:00:03,000\nHello\n', language: 'fr' },
  ],
});
```

## Files

| Format | Read |
|---|---|
| SubRip (`.srt`) | text, `<b>` `<i>` `<u>` `<font color>`, `{\an8}` placement |
| WebVTT (`.vtt`) | text, `<b>` `<i>` `<u>` `<c>` `<v>`, `align`, `line` and `position` settings |
| TTML / IMSC (`.ttml`, `.dfxp`, `.xml`) | text, styles, regions |
| ASS / SSA (`.ass`, `.ssa`) | text, bold, italic, underline, colours, alignment, `\pos` (full ASS rendering, karaoke and animations: [design](video-design.md)) |

A file is fetched with the source's headers (or its own `headers`), retried with backoff on a server error or a dropped connection, and read in the encoding it is in: UTF-8, UTF-16, Windows-1252, Windows-1251, Shift-JIS and the other legacy encodings are detected (`encoding` forces one). The format comes from the file name, else from the contents (`format` forces one). A file that cannot be loaded is a non-fatal `SUBTITLE_LOAD_FAILED` error: the video plays on.

| `SubtitleSource` | |
|---|---|
| `uri` or `text` | where the file is, or its contents |
| `language` | BCP 47 (`pt-BR`) or ISO 639 (`por`) |
| `label` | what a menu shows |
| `kind` | `subtitles` (default) or `captions` (for the deaf and hard of hearing) |
| `forced` | only what is not in the audio's language (signs, foreign lines) |
| `default` | the file marks it as the default |
| `id` | default `sub:<n>`, in the order given |
| `format`, `encoding`, `headers` | see above |

`player.addSubtitles([...])` adds files to the source playing.

## The source's own tracks

An HLS manifest's subtitle groups and audio languages, a DASH manifest's, captions in the stream (CEA-608/708), and an MP4's or Matroska file's audio and text tracks are tracks too, with `track:` ids. AVPlayer, ExoPlayer, hls.js and Shaka read them; the overlay draws their cues like a file's. On the web, Safari's own HLS lists them itself, and everywhere else a video player plays HLS with hls.js (a browser's native HLS without track lists, like Chromium's, has none to pick from).

A Matroska file's SubRip, ASS and WebVTT tracks work on every platform: ExoPlayer reads them on Android, and on iOS and the web RNAP's remuxer takes them out of the file ([Video](video.md#matroska-webm-and-mpeg-ts)). ASS keeps its text, bold, italic and placement on the web; on iOS it reaches AVPlayer as WebVTT (text, and `\an7`–`\an9` at the top). Bitmap subtitles (PGS, VobSub, DVB) are listed as unsupported.

## Choosing

`status.video.tracks` lists the audio and text tracks: the source's, then the app's files.

| Call | |
|---|---|
| `player.selectSubtitles(id)` | shows a text track; `null` turns subtitles off |
| `player.selectAudioTrack(id)` | plays an audio track (a language, an audio description); `'auto'` hands it back |
| `player.setSubtitleDelay(seconds)` | shows the subtitles later (negative: earlier), to fix a file out of sync; a new load resets it |

Until the app picks, RNAP picks: an audio track in the user's language (`video.tracks.languages`, else the device's), and subtitles when the audio is not in a language the user reads, or when the OS asks for captions (Settings › Accessibility on iOS, Caption preferences on Android). Forced subtitles in the audio's language show on their own. `video.tracks.followSystem: false` leaves the OS's settings out.

## Drawing them yourself

```tsx
import { useCues } from 'react-native-anything-player/video';

function Captions({ player }) {
  const cues = useCues(player);
  return cues.map((cue) => <Text key={cue.start}>{cue.text}</Text>);
}
```

Each `SubtitleCue` has `start`, `end`, `text`, `spans` (runs of text with `bold`, `italic`, `underline`, `color`), `align` (`left`, `center`, `right`), `vertical` (`top`, `middle`, `bottom`) and an optional anchor `x`, `y` (fractions of the picture). The `cues` event and `player.getCues()` give the same.

## The overlay

The overlay draws on the visible part of the picture, near the bottom unless the cue says otherwise (on Android it moves up while RNAP's controls show). It follows the user's caption settings: the text and background colours and opacity, the window, the edge (outline, shadow, raised, depressed), the font and its size (iOS: Subtitles & Captioning › Style; Android: Caption preferences). On the web it uses the page's font with a translucent band.

## On a Cast receiver

When the video goes to a Cast receiver, the app's files go with it as WebVTT text tracks, whatever format they were in, with the subtitle delay applied; `selectSubtitles` switches them while casting. A receiver reads the source's own tracks from the source itself.
