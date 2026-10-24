// The remuxer's model: what a demuxer finds in a Matroska/WebM or MPEG-TS
// file, and what the MP4 writer is given. Platform-free; the Swift twin is
// ios/Core/Remux/RemuxTypes.swift, and both are held to conformance/remux/.

export type RemuxTrackKind = 'video' | 'audio' | 'text';

/** A track as the demuxer found it. */
export interface RemuxTrack {
  /** The container's id: the Matroska track number, the TS PID. */
  id: number;
  kind: RemuxTrackKind;
  /**
   * The RFC 6381 codec (`avc1.4D401E`, `mp4a.40.2`, `opus`); for text,
   * `srt`, `ass` or `vtt`. `null` until the codec's configuration is known.
   */
  codec: string | null;
  /** The MP4 sample entry (`avc1`, `hvc1`, `vp09`, `vp08`, `av01`, `mp4a`, `Opus`, `fLaC`, `ac-3`, `ec-3`); `null` for text. */
  entry: string | null;
  /** The sample entry's configuration box payload (`avcC`, `hvcC`, `vpcC`, `av1C`, `esds`'s AudioSpecificConfig, `dOps`, `dfLa`, `dac3`, `dec3`). */
  config: Uint8Array | null;
  /** The `esds` objectTypeIndication (AAC 0x40, MP3 0x6B). */
  objectType: number;
  /** Units per second of the samples' times. */
  timescale: number;
  /** The coded picture, pixels. */
  width: number;
  height: number;
  /** The pixels' aspect ratio (anamorphic pictures), `1:1` for square pixels. */
  sarWidth: number;
  sarHeight: number;
  sampleRate: number;
  channels: number;
  /** ISO 639-2 or BCP 47; `null` when unknown. */
  language: string | null;
  name: string | null;
  default: boolean;
  forced: boolean;
  /** Why it cannot be remuxed (an unknown codec, Vorbis…); `null` when it can. */
  unsupported: string | null;
  /** Text: the codec's private data (an ASS script's header). */
  header: string | null;
}

/** One sample, as the MP4 writer takes it: times in the track's timescale. */
export interface RemuxSample {
  dts: number;
  pts: number;
  duration: number;
  key: boolean;
  data: Uint8Array;
}

/** A subtitle found in the file: times in milliseconds. */
export interface RemuxCue {
  track: number;
  start: number;
  /** `null`: the file does not say. */
  end: number | null;
  text: string;
}

/** A frame as a demuxer hands it on (before the remuxer times it). */
export interface DemuxFrame {
  track: number;
  /** Presentation time in the track's timescale; `null`: right after the previous frame. */
  pts: number | null;
  key: boolean;
  data: Uint8Array;
}

/** Where a Matroska file's clusters start, for seeking (from its Cues). */
export interface CuePoint {
  /** Milliseconds. */
  time: number;
  /** The cluster's byte offset in the file. */
  offset: number;
}

export function emptyTrack(id: number, kind: RemuxTrackKind): RemuxTrack {
  return {
    id,
    kind,
    codec: null,
    entry: null,
    config: null,
    objectType: 0,
    timescale: 1000,
    width: 0,
    height: 0,
    sarWidth: 1,
    sarHeight: 1,
    sampleRate: 0,
    channels: 0,
    language: null,
    name: null,
    default: false,
    forced: false,
    unsupported: null,
    header: null,
  };
}
