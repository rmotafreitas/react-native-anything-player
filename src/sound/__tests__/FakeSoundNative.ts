/** In-memory stand-in for the `AnythingPlayerSound` TurboModule: records every call. */
export class FakeSoundNative {
  calls: Array<[string, ...unknown[]]> = [];
  available = true;
  nextId = 1;
  rejectLoad: { code: string; message: string } | null = null;

  isAvailable(): boolean {
    return this.available;
  }

  async configure(options: object): Promise<void> {
    this.calls.push(['configure', options]);
  }

  async load(source: object, options: object): Promise<object> {
    this.calls.push(['load', source, options]);
    if (this.rejectLoad) throw this.rejectLoad;
    return { id: `s${this.nextId++}`, duration: 0.5 };
  }

  async unload(soundId: string): Promise<void> {
    this.calls.push(['unload', soundId]);
  }

  play(...args: unknown[]): void {
    this.calls.push(['play', ...args]);
  }

  setVoice(...args: unknown[]): void {
    this.calls.push(['setVoice', ...args]);
  }

  stopVoice(...args: unknown[]): void {
    this.calls.push(['stopVoice', ...args]);
  }

  stopSound(...args: unknown[]): void {
    this.calls.push(['stopSound', ...args]);
  }

  stopAll(): void {
    this.calls.push(['stopAll']);
  }

  last(name: string): unknown[] | undefined {
    return this.calls.filter((c) => c[0] === name).at(-1);
  }
}

/** The instance the tests' `jest.mock` hands to the code under test. */
export const sharedFake = new FakeSoundNative();
