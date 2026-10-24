// A video's own audio and text tracks on the web. With hls.js, its audio and
// subtitle renditions; otherwise the element's own lists (Safari's native
// HLS, in-band tracks). The engine picks, like on iOS and Android: the
// chosen text track runs `hidden` (its cues load, the browser draws nothing)
// and its active cues go to RNAP's overlay, in the same place and style as
// an app's subtitle file.

import type { HlsMediaTrack } from '../../core/hls';
import type { MediaTrack } from '../../core/subtitles/tracks';
import type { SubtitleCue } from '../../core/subtitles/types';
import { vttCue } from '../../core/subtitles/vtt';
import type {
  AudioTrackLike,
  TextTrackLike,
  TrackListLike,
  VideoElementLike,
  VttCueLike,
} from './dom';

/** Where the tracks and the cues go (the driver, for its generation). */
export interface TrackSink {
  onTracks(tracks: MediaTrack[]): void;
  onCues(cues: SubtitleCue[]): void;
}

/** hls.js's renditions, as HlsStream exposes them. */
export interface HlsTracks {
  readonly audioTracks: ReadonlyArray<HlsMediaTrack>;
  readonly subtitleTracks: ReadonlyArray<HlsMediaTrack>;
  selectAudio(index: number): void;
  /** `-1`: none. */
  selectSubtitles(index: number): void;
}

const DESCRIBES_VIDEO = 'public.accessibility.describes-video';
const ACCESSIBLE_TEXT = [
  'public.accessibility.transcribes-spoken-dialog',
  'public.accessibility.describes-music-and-sound',
];

const audioId = (i: number) => `track:a:${i}`;
const textId = (i: number) => `track:t:${i}`;

/** The index in a `track:a:<i>` / `track:t:<i>` id, if it is that kind. */
function indexOf(id: string | null, kind: 'a' | 't'): number | null {
  const m = id == null ? null : /^track:([at]):(\d+)$/.exec(id);
  return m && m[1] === kind ? Number(m[2]) : null;
}

const isText = (t: TextTrackLike) =>
  t.kind === 'subtitles' || t.kind === 'captions';

function listOf<T>(list: TrackListLike<T> | undefined): T[] {
  const out: T[] = [];
  for (let i = 0; i < (list?.length ?? 0); i++) out.push(list![i]!);
  return out;
}

/** An hls.js rendition as a track. */
function hlsTrack(id: string, t: HlsMediaTrack, audio: boolean): MediaTrack {
  const traits = t.characteristics ?? '';
  const sdh = ACCESSIBLE_TEXT.some((c) => traits.includes(c));
  let kind: MediaTrack['kind'] = sdh ? 'captions' : 'subtitles';
  if (audio) kind = 'audio';
  return {
    id,
    kind,
    language: t.lang || null,
    label: t.name || null,
    forced: !audio && !!t.forced,
    default: !!t.default,
    sdh: !audio && sdh,
    describesVideo: audio && traits.includes(DESCRIBES_VIDEO),
  };
}

/** A browser cue (a `VTTCue`) in the cue model; `null` for a cue without text. */
export function cueOfVtt(c: VttCueLike): SubtitleCue | null {
  if (typeof c.text !== 'string') return null;
  const settings: string[] = [];
  if (typeof c.align === 'string') settings.push(`align:${c.align}`);
  if (typeof c.line === 'number') {
    const where = c.snapToLines === false ? `${c.line}%` : `${c.line}`;
    const anchor =
      c.lineAlign && c.lineAlign !== 'start' ? `,${c.lineAlign}` : '';
    settings.push(`line:${where}${anchor}`);
  }
  if (typeof c.position === 'number') settings.push(`position:${c.position}%`);
  const end = Math.max(c.endTime, c.startTime);
  return vttCue(c.startTime * 1000, end * 1000, settings.join(' '), c.text);
}

export class MediaTracks {
  private hls: HlsTracks | null = null;
  private chosen: { audio: string | null; text: string | null } | null = null;
  private cueTrack: TextTrackLike | null = null;
  private lastTracks = '';
  private lastCues = '';
  private closed = false;
  private readonly unlisten: Array<() => void> = [];
  private readonly onList = () => this.refresh();
  private readonly onCueChange = () => this.readCues();

  constructor(
    private readonly element: VideoElementLike,
    private readonly sink: TrackSink
  ) {
    for (const list of [element.textTracks, element.audioTracks]) {
      if (!list) continue;
      for (const type of ['addtrack', 'removetrack', 'change']) {
        list.addEventListener(type, this.onList);
        this.unlisten.push(() => list.removeEventListener(type, this.onList));
      }
    }
    this.refresh();
  }

  /** hls.js plays the source: its renditions are the tracks (called again when they change). */
  useHls(hls: HlsTracks): void {
    this.hls = hls;
    this.refresh();
  }

  /** The engine's picks: the audio and text track to play (`null` text: none of the source's). */
  select(audio: string | null, text: string | null): void {
    this.chosen = { audio, text };
    this.apply();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unlisten.splice(0).forEach((off) => off());
    this.watchCues(null);
  }

  /** The lists changed: report the tracks, apply the picks, follow the text track that runs. */
  private refresh(): void {
    if (this.closed) return;
    const tracks = this.tracks();
    const key = JSON.stringify(tracks);
    if (key !== this.lastTracks) {
      this.lastTracks = key;
      this.sink.onTracks(tracks);
    }
    this.apply();
    this.watchCues(this.runningText());
  }

  private tracks(): MediaTrack[] {
    const hls = this.hls;
    if (hls) {
      return [
        ...hls.audioTracks.map((t, i) => hlsTrack(audioId(i), t, true)),
        ...hls.subtitleTracks.map((t, i) => hlsTrack(textId(i), t, false)),
      ];
    }
    const audio = listOf(this.element.audioTracks).map(
      (t: AudioTrackLike, i): MediaTrack => ({
        id: audioId(i),
        kind: 'audio',
        language: t.language || null,
        label: t.label || null,
        forced: false,
        default: t.kind === 'main',
        sdh: false,
        describesVideo: t.kind === 'description',
      })
    );
    const text = this.textTracks().map((t, i): MediaTrack => ({
      id: textId(i),
      kind: t.kind === 'captions' ? 'captions' : 'subtitles',
      language: t.language || null,
      label: t.label || null,
      forced: false,
      default: false,
      sdh: t.kind === 'captions',
      describesVideo: false,
    }));
    return [...audio, ...text];
  }

  private textTracks(): TextTrackLike[] {
    return listOf(this.element.textTracks).filter(isText);
  }

  /** Puts the picks into effect (the browser never draws subtitles itself). */
  private apply(): void {
    const chosen = this.chosen;
    if (this.closed || chosen == null) return;
    const audio = indexOf(chosen.audio, 'a');
    const text = indexOf(chosen.text, 't');
    const hls = this.hls;
    if (hls) {
      if (audio != null && audio < hls.audioTracks.length)
        hls.selectAudio(audio);
      hls.selectSubtitles(
        text != null && text < hls.subtitleTracks.length ? text : -1
      );
      // hls.js's own text tracks run hidden: RNAP's overlay draws them.
      for (const t of this.textTracks())
        if (t.mode === 'showing') t.mode = 'hidden';
      return;
    }
    const audioTracks = listOf(this.element.audioTracks);
    if (audio != null && audio < audioTracks.length) {
      audioTracks.forEach((t, i) => {
        const on = i === audio;
        if (t.enabled !== on) t.enabled = on;
      });
    }
    this.textTracks().forEach((t, i) => {
      const mode = i === text ? 'hidden' : 'disabled';
      if (t.mode !== mode) t.mode = mode;
    });
  }

  /** The text track whose cues load (hidden, or showing before RNAP hid it). */
  private runningText(): TextTrackLike | null {
    // hls.js and Shaka keep a hidden track loading: subtitles off shows none of it.
    if (this.hls && this.chosen?.text == null) return null;
    return this.textTracks().find((t) => t.mode !== 'disabled') ?? null;
  }

  private watchCues(track: TextTrackLike | null): void {
    if (track === this.cueTrack) return;
    this.cueTrack?.removeEventListener('cuechange', this.onCueChange);
    this.cueTrack = track;
    track?.addEventListener('cuechange', this.onCueChange);
    this.readCues();
  }

  private readCues(): void {
    if (this.closed) return;
    const active = this.cueTrack?.activeCues;
    const cues: SubtitleCue[] = [];
    for (let i = 0; i < (active?.length ?? 0); i++) {
      const cue = cueOfVtt(active![i]!);
      if (cue) cues.push(cue);
    }
    const key = JSON.stringify(cues);
    if (key === this.lastCues) return;
    this.lastCues = key;
    this.sink.onCues(cues);
  }
}
