// A scripted hls.js: the constructor RNAP is given with `configureHls`, with
// the parts of the real class it uses. Tests emit its events.

type Handler = (event: string, data: unknown) => void;

export class FakeHls {
  static supported = true;
  static instances: FakeHls[] = [];
  static Events = {
    MANIFEST_PARSED: 'hlsManifestParsed',
    LEVEL_LOADED: 'hlsLevelLoaded',
    FRAG_PARSING_METADATA: 'hlsFragParsingMetadata',
    ERROR: 'hlsError',
  };
  static ErrorTypes = {
    NETWORK_ERROR: 'networkError',
    MEDIA_ERROR: 'mediaError',
  };

  static isSupported(): boolean {
    return FakeHls.supported;
  }

  static reset(): void {
    FakeHls.supported = true;
    FakeHls.instances = [];
  }

  source: string | null = null;
  media: unknown = null;
  destroyed = false;
  latency: number | undefined = undefined;
  private readonly handlers = new Map<string, Handler[]>();

  constructor(readonly config: Record<string, any> = {}) {
    FakeHls.instances.push(this);
  }

  static last(): FakeHls {
    return FakeHls.instances[FakeHls.instances.length - 1]!;
  }

  loadSource(url: string): void {
    this.source = url;
  }

  attachMedia(media: unknown): void {
    this.media = media;
  }

  destroy(): void {
    this.destroyed = true;
  }

  on(event: string, handler: Handler): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
  }

  // ── Test controls ──

  emit(event: string, data: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) handler(event, data);
  }

  level(live: boolean, totalduration = 0): void {
    this.emit(FakeHls.Events.LEVEL_LOADED, {
      details: { live, totalduration },
    });
  }

  fatal(type: string, details = 'fragLoadError', code?: number): void {
    this.emit(FakeHls.Events.ERROR, {
      type,
      details,
      fatal: true,
      response: code ? { code } : undefined,
    });
  }
}
