// Decoded-audio windows from a stream's own bytes, for WebKit. There a
// MediaElementAudioSourceNode reads silence (all zeros) from every source,
// Media Source or CORS, so `AudioSampler` cannot route the element. Twin of
// the iOS stream decoder: `MseStream` hands over the audio it appends, which
// is decoded here in short batches and read at the element's clock.

import {
  AAC_FORMAT,
  FrameScanner,
  MP3_FORMAT,
  type AudioCodec,
  type Frame,
} from './AudioFrames';

/** The audio `MseStream` appends, and where it lands on the media timeline. */
export interface StreamAudio {
  codec: AudioCodec;
  bytes: Uint8Array;
  /** Media time the first whole frame in `bytes` plays at. */
  time: number;
  /** The first bytes of a connection (a new item, or a splice). */
  fresh: boolean;
}

/** PCM of one decoded batch, one array per channel. */
export interface DecodedAudio {
  channels: Float32Array[];
  sampleRate: number;
}

/** Decodes a run of whole frames (an `ArrayBuffer` the decoder may detach). */
export type FrameDecoder = (
  bytes: ArrayBuffer,
  sampleRate: number
) => Promise<DecodedAudio>;

/** Audio decoded per batch: long enough to amortize a decode, short enough to stay ahead of the playhead. */
const BATCH_SECONDS = 0.4;
/**
 * Frames of the previous batch decoded again first, and dropped: an MP3 frame
 * may draw on its predecessors' bits, and an AAC decoder trims 2112 samples of
 * priming (more than two 1024-sample frames).
 */
const OVERLAP_FRAMES: Record<AudioCodec, number> = { mp3: 2, aac: 3 };
/** Decoded audio kept behind the playhead. */
const KEEP_BEHIND_SECONDS = 1;
/**
 * Undecoded audio kept while sampling is off: the most `MseStream` buffers
 * ahead of the playhead, so sampling that comes back has the audio being heard.
 */
const PARKED_SECONDS = 30;

/** Whole frames waiting to be decoded, and where their own audio (after the overlap) plays. */
interface Batch {
  bytes: ArrayBuffer;
  start: number;
  seconds: number;
  sampleRate: number;
  epoch: number;
}

interface Chunk {
  start: number;
  sampleRate: number;
  /** Mono: the channels averaged, as an AnalyserNode down-mixes them. */
  pcm: Float32Array;
}

export class DecodedTap {
  private scanner: FrameScanner | null = null;
  private codec: AudioCodec | null = null;
  private anchored = false;
  /** Media time of the next frame scanned. */
  private nextTime = 0;
  private batch: Frame[] = [];
  private batchSamples = 0;
  private batchStart = 0;
  private overlap: Frame[] = [];
  private sampleRate = 0;
  private chunks: Chunk[] = [];
  private decoding: Promise<void> = Promise.resolve();
  /** Bumped whenever the decoded audio is dropped: decodes still running for it are too. */
  private epoch = 0;
  /** Off: batches are parked undecoded (sampling is off). */
  private active = true;
  private parked: Batch[] = [];

  constructor(private readonly decode: FrameDecoder) {}

  push(audio: StreamAudio): void {
    if (audio.fresh || !this.anchored || audio.codec !== this.codec) {
      this.flush();
      // Another item: a new media source starts its timeline at 0 again.
      if (audio.time === 0 || audio.codec !== this.codec) this.clear();
      this.codec = audio.codec;
      this.scanner = new FrameScanner(
        audio.codec === 'mp3' ? MP3_FORMAT : AAC_FORMAT
      );
      this.overlap = [];
      this.nextTime = audio.time;
      this.anchored = true;
    }
    const { frames, config } = this.scanner!.scan(audio.bytes);
    if (!config) return;
    if (config.sampleRate !== this.sampleRate) {
      this.flush();
      this.overlap = [];
      this.sampleRate = config.sampleRate;
    }
    for (const frame of frames) {
      if (this.batch.length === 0) this.batchStart = this.nextTime;
      this.batch.push(frame);
      this.batchSamples += frame.samples;
      this.nextTime += frame.samples / this.sampleRate;
      if (this.batchSamples >= BATCH_SECONDS * this.sampleRate) this.flush();
    }
  }

  /**
   * The `size` mono samples that end at media time `time` (at the stream's
   * rate), or `null` when they are not decoded yet.
   */
  window(
    time: number,
    size: number
  ): { pcm: Float32Array; sampleRate: number } | null {
    this.prune(time - KEEP_BEHIND_SECONDS);
    const covering = this.chunks.find(
      (c) => c.start <= time && time <= c.start + c.pcm.length / c.sampleRate
    );
    if (!covering) return null;
    const { sampleRate } = covering;
    const pcm = new Float32Array(size);
    const from = time - size / sampleRate;
    for (const chunk of this.chunks) {
      if (chunk.sampleRate !== sampleRate) continue;
      // Sample offsets of the chunk inside the window.
      const offset = Math.round((chunk.start - from) * sampleRate);
      const begin = Math.max(0, -offset);
      const end = Math.min(chunk.pcm.length, size - offset);
      if (begin < end) pcm.set(chunk.pcm.subarray(begin, end), offset + begin);
    }
    return { pcm, sampleRate };
  }

  /** Sampling on (decode, starting with what was parked) or off (park the batches undecoded). */
  setActive(active: boolean): void {
    if (active === this.active) return;
    this.active = active;
    if (!active) return;
    const parked = this.parked;
    this.parked = [];
    for (const batch of parked) this.decodeBatch(batch);
  }

  private clear(): void {
    this.chunks = [];
    this.parked = [];
    this.epoch += 1;
  }

  /**
   * Ends the batch: decoded in the background, after any decode still running
   * (chunks stay in order), or parked while sampling is off.
   */
  private flush(): void {
    if (this.batch.length === 0) return;
    const frames = [...this.overlap, ...this.batch];
    const { batchStart: start, sampleRate, epoch } = this;
    const seconds = this.batchSamples / sampleRate;
    this.overlap = this.batch.slice(-OVERLAP_FRAMES[this.codec!]);
    this.batch = [];
    this.batchSamples = 0;
    const batch = {
      bytes: joinFrames(frames),
      start,
      seconds,
      sampleRate,
      epoch,
    };
    if (this.active) {
      this.decodeBatch(batch);
      return;
    }
    this.parked.push(batch);
    let parkedSeconds = 0;
    for (const { seconds: s } of this.parked) parkedSeconds += s;
    while (parkedSeconds > PARKED_SECONDS)
      parkedSeconds -= this.parked.shift()!.seconds;
  }

  private decodeBatch(batch: Batch): void {
    const { bytes, start, seconds, sampleRate, epoch } = batch;
    this.decoding = this.decoding
      .then(() => this.decode(bytes, sampleRate))
      .then((decoded) => {
        if (epoch === this.epoch) this.add(decoded, start, seconds);
      })
      // A batch that does not decode (a corrupt run) leaves a gap: the
      // window reads silence there.
      .catch(() => undefined);
  }

  /** Keeps the batch's own samples: the tail of what was decoded, after the overlap. */
  private add(decoded: DecodedAudio, start: number, seconds: number): void {
    const { channels, sampleRate } = decoded;
    const length = channels[0]?.length ?? 0;
    const wanted = Math.min(length, Math.round(seconds * sampleRate));
    if (wanted === 0) return;
    const pcm = new Float32Array(wanted);
    for (const channel of channels) {
      for (let i = 0; i < wanted; i++)
        pcm[i]! += channel[length - wanted + i]! / channels.length;
    }
    // A decoder that trimmed samples leaves the batch short: it still ends on time.
    this.chunks.push({
      start: start + seconds - wanted / sampleRate,
      sampleRate,
      pcm,
    });
  }

  private prune(before: number): void {
    const keep = this.chunks.findIndex(
      (c) => c.start + c.pcm.length / c.sampleRate >= before
    );
    if (keep > 0) this.chunks.splice(0, keep);
  }
}

function joinFrames(frames: Frame[]): ArrayBuffer {
  let length = 0;
  for (const frame of frames) length += frame.whole.length;
  const joined = new Uint8Array(length);
  let at = 0;
  for (const frame of frames) {
    joined.set(frame.whole, at);
    at += frame.whole.length;
  }
  return joined.buffer;
}
