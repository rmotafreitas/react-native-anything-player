// Decoded-audio windows for visualizers, from Web Audio. Twin of the
// ExoPlayer sink tap (Android) and the audio tap / stream decoder (iOS).
//
// The element is routed through an AnalyserNode. Routing is permanent and a
// cross-origin source without CORS plays as *silence* through Web Audio, so
// the sampler only attaches to items whose bytes RNAP fetched itself (the MSE
// path: same-origin to Web Audio), and only once the AudioContext runs (an
// unstarted context would mute the element too).
//
// WebKit reads silence from any routed element (and so plays silence), so
// there the element is never routed: the stream's own bytes are decoded
// instead (`DecodedTap`), read at the element's clock.

import { DecodedTap, type DecodedAudio, type StreamAudio } from './DecodedTap';
import {
  browser,
  type AnalyserLike,
  type AudioContextLike,
  type AudioElementLike,
  type OfflineAudioContextLike,
} from './dom';

export interface AudioWindow {
  waveform: number[];
  level: number;
  durationSeconds: number;
  outputLatencySeconds: number;
  timestampMs: number;
}

const FFT_SIZE = 2048;
/** The sample rate a decoded window's timer assumes (it only paces the windows). */
const NOMINAL_RATE = 44100;

export class AudioSampler {
  enabled = false;
  points = 1024;
  onWindow: ((window: AudioWindow) => void) | null = null;
  private context: AudioContextLike | null = null;
  /** One tap per element ever routed (routing cannot be undone). */
  private readonly taps = new Map<
    AudioElementLike,
    { node: { disconnect(): void }; analyser: AnalyserLike }
  >();
  /** WebKit: the streams' bytes are decoded, the element never routed. */
  private readonly decodes = AudioSampler.decodesStreams;
  private readonly decoded = new Map<AudioElementLike, DecodedTap>();
  private current: AudioElementLike | null = null;
  private resuming = false;
  private timer: number | null = null;

  static get supported(): boolean {
    const g = browser();
    if (AudioSampler.decodesStreams) return true;
    return g.AudioContext != null || g.webkitAudioContext != null;
  }

  /** Whether the bytes are decoded instead of routing the element (WebKit). */
  static get decodesStreams(): boolean {
    const g = browser();
    return (
      g.navigator?.vendor === 'Apple Computer, Inc.' &&
      g.OfflineAudioContext != null
    );
  }

  /**
   * Audio a stream is about to give `element`, where the element cannot be
   * routed: decoded while sampling is on, kept undecoded while it is off.
   */
  feed(element: AudioElementLike, audio: StreamAudio): void {
    if (!this.decodes) return;
    let tap = this.decoded.get(element);
    if (!tap) {
      if (!this.enabled) return;
      tap = new DecodedTap(decodeFrames);
      this.decoded.set(element, tap);
    }
    tap.push(audio);
  }

  /** Whether `element` is routed through Web Audio (only same-origin audio may play on it). */
  isAttached(element: AudioElementLike): boolean {
    return this.taps.has(element);
  }

  /**
   * Starts (or keeps) sampling `element` if allowed: sampling is on, the item
   * is RNAP-fetched, and the context runs. A suspended context is asked to
   * resume every time: it starts once the page has a user gesture (Firefox and
   * Safari create it suspended even inside one). Call from play() and
   * whenever the item changes. In WebKit only a `local` item (a `blob:` or
   * `data:` file) is routed; a stream's own bytes are decoded instead.
   */
  update(
    element: AudioElementLike,
    itemIsFetched: boolean,
    local = false
  ): boolean {
    if (!this.enabled || !itemIsFetched || !AudioSampler.supported) {
      this.stopTimer();
      return this.isAttached(element);
    }
    if (this.decodes && !local) {
      this.current = element;
      this.decoded.get(element)?.setActive(true);
      this.startTimer();
      return false;
    }
    const context = this.ensureContext();
    // The browser refused another context (they are limited): no sampling.
    if (!context) {
      this.stopTimer();
      return this.isAttached(element);
    }
    if (context.state !== 'running') {
      if (!this.resuming) {
        this.resuming = true;
        context
          .resume()
          .then(() => this.update(element, itemIsFetched, local))
          .catch(() => undefined)
          .finally(() => {
            this.resuming = false;
          });
      }
      return this.isAttached(element);
    }
    if (!this.taps.has(element)) {
      const node = context.createMediaElementSource(element);
      const analyser = context.createAnalyser();
      analyser.fftSize = FFT_SIZE;
      node.connect(analyser);
      analyser.connect(context.destination);
      this.taps.set(element, { node, analyser });
    }
    this.current = element;
    this.startTimer();
    return true;
  }

  /** Sampling is off: no timer, and streams' audio waits undecoded. */
  stop(): void {
    this.stopTimer();
    for (const tap of this.decoded.values()) tap.setActive(false);
  }

  /** Frees the audio context (the browser limits them) once the player is gone. */
  destroy(): void {
    this.enabled = false;
    this.stopTimer();
    const context = this.context;
    for (const { node, analyser } of this.taps.values()) {
      try {
        node.disconnect();
        analyser.disconnect();
      } catch {
        // Already disconnected.
      }
    }
    this.taps.clear();
    this.decoded.clear();
    this.current = null;
    this.context = null;
    this.onWindow = null;
    // A rejection (closed already) leaves nothing to free.
    context?.close().catch(() => undefined);
  }

  private ensureContext(): AudioContextLike | null {
    if (!this.context) {
      const g = browser();
      const Context = (g.AudioContext ?? g.webkitAudioContext)!;
      try {
        this.context = new Context();
      } catch {
        return null;
      }
    }
    return this.context;
  }

  private startTimer(): void {
    if (this.timer !== null) return;
    const rate = this.decodes ? NOMINAL_RATE : this.context?.sampleRate;
    if (!rate) return;
    const intervalMs = (FFT_SIZE / rate) * 1000;
    const buffer = new Float32Array(FFT_SIZE);
    this.timer = browser().setInterval(() => {
      const element = this.current;
      if (!element || !this.onWindow || element.paused) return;
      const window = this.taps.has(element)
        ? this.analysedWindow(element, buffer)
        : this.decodedWindow(element);
      if (window) this.onWindow(window);
    }, intervalMs);
  }

  private analysedWindow(
    element: AudioElementLike,
    buffer: Float32Array
  ): AudioWindow | null {
    const analyser = this.taps.get(element)?.analyser;
    const context = this.context;
    if (!analyser || !context) return null;
    analyser.getFloatTimeDomainData(buffer);
    const latency = (context.outputLatency ?? 0) + (context.baseLatency ?? 0);
    return toWindow(buffer, this.points, context.sampleRate, latency);
  }

  /** The decoded samples that end where the element plays now. */
  private decodedWindow(element: AudioElementLike): AudioWindow | null {
    const window = this.decoded
      .get(element)
      ?.window(element.currentTime, FFT_SIZE);
    return window
      ? toWindow(window.pcm, this.points, window.sampleRate, 0)
      : null;
  }

  private stopTimer(): void {
    if (this.timer !== null) browser().clearInterval(this.timer);
    this.timer = null;
  }
}

/** Resamples one frame of samples to `points` values and measures its loudness. */
function toWindow(
  samples: Float32Array,
  points: number,
  sampleRate: number,
  outputLatencySeconds: number
): AudioWindow {
  let sum = 0;
  for (const s of samples) sum += s * s;
  const step = samples.length / points;
  const waveform = Array.from({ length: points }, (_, i) => {
    const v = samples[Math.min(samples.length - 1, Math.floor(i * step))]!;
    return Math.max(-1, Math.min(1, v));
  });
  return {
    waveform,
    level: Math.min(1, Math.sqrt(sum / samples.length)),
    durationSeconds: samples.length / sampleRate,
    outputLatencySeconds,
    timestampMs: Date.now(),
  };
}

/** One decoding context per sample rate: decoding at the stream's rate does not resample. */
const decoders = new Map<number, OfflineAudioContextLike>();

/** Decodes whole frames with Web Audio (no audio context, no user gesture needed). */
async function decodeFrames(
  bytes: ArrayBuffer,
  sampleRate: number
): Promise<DecodedAudio> {
  let decoder = decoders.get(sampleRate);
  if (!decoder) {
    decoder = new (browser().OfflineAudioContext!)(1, 1, sampleRate);
    decoders.set(sampleRate, decoder);
  }
  const buffer = await decoder.decodeAudioData(bytes);
  const channels: Float32Array[] = [];
  for (let i = 0; i < buffer.numberOfChannels; i++)
    channels.push(buffer.getChannelData(i));
  return { channels, sampleRate: buffer.sampleRate };
}
