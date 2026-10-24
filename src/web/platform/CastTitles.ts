// Titles while the audio plays on a Cast receiver. A receiver fetches the
// stream itself, so the page never sees its ICY metadata. While a live HTTP
// stream plays on Cast, the page keeps a second connection open that only
// reads the titles: it asks for ICY metadata, de-interleaves the body with the
// same parser the MSE path uses, throws the audio away and hands each title to
// the player at once (ahead of the receiver by its buffer).
//
// The reader is the page's own business: whatever goes wrong with it —
// a refusal, CORS, a dropped connection — never touches the receiver.

import {
  IcyDeinterleaver,
  IcyParser,
  type StreamMetadata,
  type StreamTitleFormat,
} from '../engine/StreamMetadata';
import type { EngineStatus, SourceDescriptor } from '../engine/types';
import { castableUrl } from './CastService';
import { browser, monotonicNow, type ResponseLike } from './dom';
import { discard, stationFromHeaders } from './MseStream';
import type { WebPlayerController } from './WebPlayerController';

/** The wait after a failed connection: doubles up to the maximum. */
const RETRY_START_MS = 1_000;
const RETRY_MAX_MS = 30_000;
/** A connection that stayed up this long earns a fresh start of the backoff. */
const STABLE_MS = 10_000;

type Outcome = 'ended' | 'failed' | 'unsupported';

export class IcyTitleReader {
  private stopped = false;
  private abort: (() => void) | null = null;
  private retry: number | null = null;
  private announced: string | null = null;

  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string>,
    private readonly format: StreamTitleFormat,
    private readonly deliver: (metadata: StreamMetadata) => void
  ) {}

  start(): void {
    this.loop(RETRY_START_MS);
  }

  stop(): void {
    this.stopped = true;
    this.abort?.();
    this.abort = null;
    browser().clearTimeout(this.retry);
    this.retry = null;
  }

  private loop(delay: number): void {
    const startedAt = monotonicNow();
    this.connect().then((outcome) => {
      if (this.stopped || outcome === 'unsupported') return;
      const stable = monotonicNow() - startedAt >= STABLE_MS;
      const wait = stable ? RETRY_START_MS : delay;
      this.retry = browser().setTimeout(
        () =>
          this.loop(
            stable ? RETRY_START_MS : Math.min(delay * 2, RETRY_MAX_MS)
          ),
        wait
      );
    });
  }

  /** One connection, read until it ends. Never throws. */
  private async connect(): Promise<Outcome> {
    const g = browser();
    const controller = new g.AbortController();
    this.abort = () => controller.abort();
    let response: ResponseLike;
    try {
      response = await g.fetch(this.url, {
        headers: { ...this.headers, 'Icy-MetaData': '1' },
        signal: controller.signal,
        cache: 'no-store',
        mode: 'cors',
      });
    } catch {
      return 'failed';
    }
    if (this.stopped || !response.ok || !response.body) {
      discard(response);
      return 'failed';
    }
    const metaint = Number.parseInt(
      response.headers.get('icy-metaint') ?? '0',
      10
    );
    if (metaint <= 0 || Number.isNaN(metaint)) {
      // Not an ICY stream, or CORS hides the interval: there are no titles to read.
      discard(response);
      return 'unsupported';
    }
    this.announce(response);
    await this.read(response, new IcyDeinterleaver(metaint));
    return 'ended';
  }

  private announce(response: ResponseLike): void {
    const station = stationFromHeaders(response.headers, this.format);
    const key = `${station?.station ?? ''}|${station?.genre ?? ''}`;
    if (!station || key === this.announced) return;
    this.announced = key;
    this.deliver(station);
  }

  private async read(
    response: ResponseLike,
    deinterleaver: IcyDeinterleaver
  ): Promise<void> {
    const reader = response.body!.getReader();
    for (;;) {
      let chunk: { done: boolean; value?: Uint8Array };
      try {
        chunk = await reader.read();
      } catch {
        return;
      }
      if (this.stopped || chunk.done || !chunk.value) return;
      for (const block of deinterleaver.consume(chunk.value).blocks) {
        const metadata = IcyParser.metadataFromBlock(block.bytes, this.format);
        if (Object.keys(metadata.raw).length > 0) this.deliver(metadata);
      }
    }
  }
}

/** The readers of the players that play on Cast: one each, while it makes sense. */
export class CastTitles {
  private readonly readers = new Map<
    WebPlayerController,
    { key: string; reader: IcyTitleReader }
  >();

  /**
   * Starts, keeps, restarts or stops `controller`'s reader to match what it
   * plays now. Call it whenever its status, source or output changes.
   */
  update(controller: WebPlayerController, onCast: boolean): void {
    const wanted = onCast ? readable(controller) : null;
    const current = this.readers.get(controller);
    const key = wanted ? `${controller.status.loadId}|${wanted.url}` : null;
    if (current?.key === key) return;
    this.stop(controller);
    if (!wanted || !key) return;
    const reader = new IcyTitleReader(
      wanted.url,
      wanted.headers,
      controller.options.titleFormat,
      // The generation of the moment: a reopen must not strand the titles.
      (metadata) =>
        controller.onStreamMetadata(controller.engine.generation, metadata)
    );
    this.readers.set(controller, { key, reader });
    reader.start();
  }

  stop(controller: WebPlayerController): void {
    this.readers.get(controller)?.reader.stop();
    this.readers.delete(controller);
  }
}

/** The stream to read titles from: live, over HTTP, wanted playing. */
function readable(
  controller: WebPlayerController
): { url: string; headers: Record<string, string> } | null {
  const status: EngineStatus = controller.status;
  const source: SourceDescriptor | null = controller.engine.source;
  if (!source || !status.isLive || !status.playWhenReady) return null;
  if (
    status.state === 'idle' ||
    status.state === 'stopped' ||
    status.state === 'ended' ||
    status.state === 'error'
  )
    return null;
  const url = castableUrl(source.uri);
  return url ? { url, headers: source.headers } : null;
}
