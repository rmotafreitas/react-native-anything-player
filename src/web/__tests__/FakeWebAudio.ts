// A scripted Web Audio for the Sound tests: nodes record how they are wired
// and driven, the context starts suspended until `resume()` (like a page
// before its first gesture), and `decodeAudioData` accepts what a test says.

type Handler = () => void;

export class FakeParam {
  value = 1;
  targets: Array<{ target: number; time: number; constant: number }> = [];
  setTargetAtTime(target: number, time: number, constant: number): void {
    this.targets.push({ target, time, constant });
  }
}

export class FakeNode {
  connections: unknown[] = [];
  disconnected = false;
  connect(destination: unknown): void {
    this.connections.push(destination);
  }
  disconnect(): void {
    this.disconnected = true;
  }
}

export class FakeGain extends FakeNode {
  gain = new FakeParam();
}

export class FakePanner extends FakeNode {
  pan = new FakeParam();
}

export class FakeSource extends FakeNode {
  buffer: unknown = null;
  loop = false;
  playbackRate = new FakeParam();
  onended: Handler | null = null;
  started: number[] = [];
  stopped: number[] = [];
  start(when = 0): void {
    this.started.push(when);
  }
  stop(when = 0): void {
    this.stopped.push(when);
  }
  /** The sound ran out (or was stopped): the browser fires `ended`. */
  end(): void {
    this.onended?.();
  }
}

export interface FakeBuffer {
  duration: number;
  bytes?: number;
}

export class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  static withPanner = true;
  static options: unknown[] = [];
  /** Whether `resume()` can start the context (a gesture happened). */
  static allowStart = true;
  /** What `decodeAudioData` makes of a byte length: a buffer, or `null` to fail. */
  static decode: (bytes: ArrayBuffer) => FakeBuffer | null = (bytes) => ({
    duration: bytes.byteLength / 1000,
    bytes: bytes.byteLength,
  });

  state = 'suspended';
  currentTime = 10;
  destination = { name: 'destination' };
  sources: FakeSource[] = [];
  gains: FakeGain[] = [];
  panners: FakePanner[] = [];
  resumes = 0;
  createStereoPanner?: () => FakePanner;

  constructor(options?: unknown) {
    FakeAudioContext.options.push(options);
    FakeAudioContext.instances.push(this);
    if (FakeAudioContext.withPanner)
      this.createStereoPanner = () => {
        const panner = new FakePanner();
        this.panners.push(panner);
        return panner;
      };
  }

  resume(): Promise<void> {
    this.resumes++;
    if (FakeAudioContext.allowStart) this.state = 'running';
    return Promise.resolve();
  }

  decodeAudioData(
    data: ArrayBuffer,
    onSuccess: (buffer: FakeBuffer) => void,
    onError: (error: unknown) => void
  ): void {
    queueMicrotask(() => {
      const buffer = FakeAudioContext.decode(data);
      if (buffer) onSuccess(buffer);
      else onError(new Error('EncodingError'));
    });
  }

  createBuffer(_channels: number, length: number, rate: number): FakeBuffer {
    return { duration: length / rate };
  }

  createBufferSource(): FakeSource {
    const source = new FakeSource();
    this.sources.push(source);
    return source;
  }

  createGain(): FakeGain {
    const gain = new FakeGain();
    this.gains.push(gain);
    return gain;
  }

  static reset(): void {
    FakeAudioContext.instances = [];
    FakeAudioContext.options = [];
    FakeAudioContext.withPanner = true;
    FakeAudioContext.allowStart = true;
    FakeAudioContext.decode = (bytes) => ({
      duration: bytes.byteLength / 1000,
      bytes: bytes.byteLength,
    });
  }
}
