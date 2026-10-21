// Decoded-audio windows for visualizers, from Web Audio. Twin of the
// ExoPlayer sink tap (Android) and the audio tap / stream decoder (iOS).
//
// The element is routed through an AnalyserNode. Routing is permanent and a
// cross-origin source without CORS plays as *silence* through Web Audio, so
// the sampler only attaches to items whose bytes RNAP fetched itself (the MSE
// path: same-origin to Web Audio), and only once the AudioContext runs (an
// unstarted context would mute the element too).

import {
  browser,
  type AnalyserLike,
  type AudioContextLike,
  type AudioElementLike,
} from './dom';

export interface AudioWindow {
  waveform: number[];
  level: number;
  durationSeconds: number;
  outputLatencySeconds: number;
  timestampMs: number;
}

const FFT_SIZE = 2048;

export class AudioSampler {
  enabled = false;
  points = 1024;
  onWindow: ((window: AudioWindow) => void) | null = null;
  private context: AudioContextLike | null = null;
  /** One tap per element ever routed (routing cannot be undone). */
  private readonly taps = new Map<AudioElementLike, AnalyserLike>();
  private current: AudioElementLike | null = null;
  private resuming = false;
  private timer: number | null = null;

  static get supported(): boolean {
    const g = browser();
    return g.AudioContext != null || g.webkitAudioContext != null;
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
   * whenever the item changes.
   */
  update(element: AudioElementLike, itemIsFetched: boolean): boolean {
    if (!this.enabled || !itemIsFetched || !AudioSampler.supported) {
      this.stopTimer();
      return this.isAttached(element);
    }
    const context = this.ensureContext();
    if (context.state !== 'running') {
      if (!this.resuming) {
        this.resuming = true;
        context
          .resume()
          .then(() => this.update(element, itemIsFetched))
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
      this.taps.set(element, analyser);
    }
    this.current = element;
    this.startTimer();
    return true;
  }

  stop(): void {
    this.stopTimer();
  }

  private ensureContext(): AudioContextLike {
    if (!this.context) {
      const g = browser();
      const Context = (g.AudioContext ?? g.webkitAudioContext)!;
      this.context = new Context();
    }
    return this.context;
  }

  private startTimer(): void {
    if (this.timer !== null || !this.context) return;
    const intervalMs = (FFT_SIZE / this.context.sampleRate) * 1000;
    const buffer = new Float32Array(FFT_SIZE);
    this.timer = browser().setInterval(() => {
      const element = this.current;
      const analyser = element ? this.taps.get(element) : undefined;
      const context = this.context;
      if (!element || !analyser || !context) return;
      if (!this.onWindow || element.paused) return;
      analyser.getFloatTimeDomainData(buffer);
      this.onWindow(toWindow(buffer, this.points, context));
    }, intervalMs);
  }

  private stopTimer(): void {
    if (this.timer !== null) browser().clearInterval(this.timer);
    this.timer = null;
  }
}

/** Resamples one analyser frame to `points` values and measures its loudness. */
export function toWindow(
  samples: Float32Array,
  points: number,
  context: Pick<
    AudioContextLike,
    'sampleRate' | 'baseLatency' | 'outputLatency'
  >
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
    durationSeconds: samples.length / context.sampleRate,
    outputLatencySeconds:
      (context.outputLatency ?? 0) + (context.baseLatency ?? 0),
    timestampMs: Date.now(),
  };
}
