// The engine's queue: what plays after the current item, which item a skip
// or previous goes to, repeat and shuffle, and the next item prepared behind
// the current one so it starts without a gap. The queue's decisions are
// `QueueModel`'s (conformance/queue); this layer loads what it decides and
// is held to the engine scenarios (conformance/queue.json). Twins: the
// queue section of `ios/Core/PlaybackEngine.swift` and
// `android/.../core/PlaybackEngine.kt`.
//
// The prepared item has a generation of its own from the start. It takes
// over in one of two ways: the driver starts it itself when the current item
// ends (ExoPlayer's playlist) and reports `onAdvanced`, or the engine sees the
// current item end and calls `driver.advance`. Either way the engine makes it
// the current item under that generation: no `ended` in between.

import type { PlayerError } from '../../errors';
import { EngineVideo } from './EngineVideo';
import { QueueModel, type QueueEntry, type RepeatMode } from './QueueModel';
import { RecoveryPolicy } from './RecoveryPolicy';
import { continuesIntent } from './status';
import type { PlayerErrorCode } from '../../types';
import {
  engineError,
  type InterruptionReason,
  type ReadyInfo,
  type SourceDescriptor,
} from './types';

export type { RepeatMode } from './QueueModel';

/** A queue item: an id, and what to play. */
export interface EngineQueueItem extends QueueEntry {
  source: SourceDescriptor;
}

/** The queue's snapshot (`engine.queueState`). */
export interface QueueState {
  /** The items' ids, in list order. */
  ids: string[];
  /** The ids in the order they play (the list's, or shuffled). */
  order: string[];
  /** The current item's place in `ids`, `null` when the queue is empty. */
  index: number | null;
  currentId: string | null;
  repeat: RepeatMode;
  shuffle: boolean;
}

/** States with nothing playing to prepare a next item behind. */
const INACTIVE: ReadonlySet<string> = new Set([
  'error',
  'stopped',
  'ended',
  'idle',
]);

/** A next item the drivers can prepare: finite, one file or manifest, clear. */
function preparable(item: EngineQueueItem): boolean {
  const s = item.source;
  if (item.live || s.liveHint === true) return false;
  return s.renditions == null && s.drm == null;
}

/** Why the current item goes: what was prepared behind it goes too. */
const ITEM_ENDS: ReadonlySet<string> = new Set([
  'open',
  'reset',
  'release',
  'handoff',
]);

/** Errors that are the item's own: the queue goes on to the next one. */
const ITEM_ERRORS: ReadonlySet<PlayerErrorCode> = new Set<PlayerErrorCode>([
  'SOURCE_NOT_FOUND',
  'UNSUPPORTED_FORMAT',
  'DECODER_ERROR',
  'INVALID_SOURCE',
  'DRM_UNSUPPORTED',
  'DRM_LICENSE_FAILED',
]);

function isItemError(error: PlayerError): boolean {
  if (ITEM_ERRORS.has(error.code)) return true;
  const status = error.httpStatus;
  return (
    error.code === 'HTTP_ERROR' &&
    status != null &&
    status >= 400 &&
    status < 500
  );
}

interface Prepared {
  generation: number;
  itemId: string;
  info: ReadyInfo | null;
}

export abstract class EngineQueue extends EngineVideo {
  protected readonly queue = new QueueModel<EngineQueueItem>();
  private prepared: Prepared | null = null;
  /** The last prepared item dropped, and the current generation then. */
  private dropped: { generation: number; under: number } | null = null;
  /** An item whose preparation failed: it is opened normally when its turn comes. */
  private unpreparable: string | null = null;
  private itemReadyAt: number | null = null;
  private prepareDueAt: number | null = null;
  /** `setLoop`'s value; repeat `one` loops on top of it. */
  private userLoop = false;
  /** Items skipped in a row for their own errors. */
  private skipStreak = 0;
  private queueDirty = false;
  private generatedIds = 0;

  get queueState(): QueueState {
    const q = this.queue;
    return {
      ids: q.items.map((item) => item.id),
      order: [...q.order],
      index: q.index,
      currentId: q.current?.id ?? null,
      repeat: q.repeat,
      shuffle: q.shuffle,
    };
  }

  /** The queue's items, in list order. */
  get queueItems(): readonly EngineQueueItem[] {
    return this.queue.items;
  }

  // ── Commands ──

  /** A plain load replaces the queue: what plays is no longer a queue item. */
  load(
    source: SourceDescriptor,
    autoplay: boolean | null,
    startPosition: number | null,
    quality?: string | null
  ): void {
    this.ensureAlive();
    this.emptyQueue();
    super.load(source, autoplay, startPosition, quality);
  }

  reset(): void {
    this.ensureAlive();
    this.emptyQueue();
    super.reset();
  }

  setLoop(value: boolean): void {
    this.ensureAlive();
    this.userLoop = value;
    this.applyLoop();
    this.commit();
  }

  /** Replaces the queue and loads `startIndex` (an empty list resets the player). */
  queueSet(
    items: EngineQueueItem[],
    startIndex = 0,
    startPosition: number | null = null,
    autoplay: boolean | null = null
  ): void {
    this.ensureAlive();
    this.checkIds(items, []);
    this.queue.set(items, startIndex);
    this.queueDirty = true;
    this.skipStreak = 0;
    this.unpreparable = null;
    const current = this.queue.current;
    if (current == null) {
      // No queue: repeat no longer loops anything.
      this.applyLoop();
      super.reset();
      return;
    }
    this.loadItem(current, autoplay, startPosition);
  }

  /**
   * Inserts at `index` (default: the end). A source loaded with `load()`
   * joins the queue first, as its current item; an idle player loads the
   * first item added, paused.
   */
  queueAdd(items: EngineQueueItem[], index?: number): void {
    this.ensureAlive();
    if (items.length === 0) return;
    const joins = this.queue.length === 0 && this._source != null;
    // The loaded source's id too, before it joins.
    const joining = `loaded-${this.generatedIds + 1}`;
    this.checkIds(
      items,
      joins
        ? [...this.queue.items, { id: joining } as EngineQueueItem]
        : this.queue.items
    );
    if (joins && this._source != null) {
      this.generatedIds += 1;
      this.queue.set([
        {
          id: joining,
          live: this._source.liveHint === true,
          source: this._source,
        },
      ]);
    }
    const idle = this.queue.length === 0;
    // A new queue: earlier failures do not count against it.
    if (idle) this.skipStreak = 0;
    this.queue.add(items, index);
    this.queueDirty = true;
    const current = this.queue.current;
    if (idle && current != null) {
      this.loadItem(current, false, null);
      return;
    }
    this.applyLoop();
    this.reconsiderNext();
    this.commit();
  }

  /** Removes these ids; when the current item goes, the next one loads (keeping the intent). */
  queueRemove(ids: string[]): void {
    this.ensureAlive();
    const changed = this.queue.remove(ids);
    this.queueDirty = true;
    const current = this.queue.current;
    if (changed) {
      if (current == null) {
        this.skipStreak = 0;
        this.applyLoop();
        super.reset();
        return;
      }
      this.loadItem(current, null, null);
      return;
    }
    this.applyLoop();
    this.reconsiderNext();
    this.commit();
  }

  queueMove(from: number, to: number): void {
    this.ensureAlive();
    this.queue.move(from, to);
    this.queueDirty = true;
    this.reconsiderNext();
    this.commit();
  }

  /** Every item but the current one goes. */
  queueClear(): void {
    this.ensureAlive();
    this.queue.clear();
    this.queueDirty = true;
    this.reconsiderNext();
    this.commit();
  }

  queueSkipTo(id: string, position: number | null = null): void {
    this.ensureAlive();
    const item = this.queue.find(id);
    if (item == null) {
      throw engineError(
        'INVALID_ARGUMENT',
        `No queue item has the id "${id}".`,
        false
      );
    }
    this.queue.skipTo(id);
    this.queueDirty = true;
    this.skipStreak = 0;
    this.go(item, position);
  }

  /** Skips to the next item; `false` (nothing changes) at the end of the queue. */
  queueNext(): boolean {
    this.ensureAlive();
    const item = this.queue.next(false);
    if (item == null) return false;
    this.queueDirty = true;
    this.skipStreak = 0;
    this.go(item, null);
    return true;
  }

  /**
   * Restarts a finite item more than 3 s in (or with nothing before it),
   * else goes to the item before.
   */
  queuePrevious(): void {
    this.ensureAlive();
    if (this.queue.current == null) return;
    const position = this._source == null ? 0 : this.driver.sample().position;
    const action = this.queue.previous(position);
    this.skipStreak = 0;
    if (action.kind === 'none') return;
    if (action.kind === 'restart') {
      if (
        this.seekable &&
        this._state !== 'error' &&
        this._state !== 'stopped'
      ) {
        this.seek(0);
      } else {
        this.loadItem(this.queue.current!, null, null);
      }
      return;
    }
    this.queueDirty = true;
    this.go(this.queue.current!, null);
  }

  setRepeat(mode: RepeatMode): void {
    this.ensureAlive();
    this.queue.setRepeat(mode);
    this.queueDirty = true;
    this.applyLoop();
    this.reconsiderNext();
    this.commit();
  }

  /** `seed` makes the order reproducible (tests, the twins' conformance). */
  setShuffle(on: boolean, seed?: number): void {
    this.ensureAlive();
    this.queue.setShuffle(on, seed);
    this.queueDirty = true;
    this.reconsiderNext();
    this.commit();
  }

  // ── Driver observation ──

  /**
   * The driver started the prepared item itself as the current one ended
   * (gapless: ExoPlayer's playlist). `playing`: its audio already flows.
   */
  onAdvanced(generation: number, playing: boolean): void {
    if (this.isReleased) return;
    const prepared = this.prepared;
    if (prepared != null && prepared.generation === generation) {
      const next = this.queue.peekNext(true);
      if (next != null && next.id === prepared.itemId) {
        this.queue.next(true);
        this.queueDirty = true;
        this.prepared = null;
        this.takeOver(prepared, next, playing);
        this.commit();
        return;
      }
    }
    const dropped = this.dropped;
    if (
      dropped != null &&
      dropped.generation === generation &&
      dropped.under === this._generation
    ) {
      // It went on to an item the queue no longer wants next: the current
      // item ended all the same.
      this.log('advance to a dropped item', { gen: `${generation}` });
      this.onEnded(this._generation);
      return;
    }
    this.logStale('advanced', generation);
  }

  // ── The prepared item's observations: facts kept for it, never the player's state ──

  onReady(generation: number, info: ReadyInfo): void {
    if (this.isPrepared(generation)) {
      this.prepared!.info = info;
      return this.log('next item', { event: 'ready' });
    }
    const current = this.accepts(generation);
    super.onReady(generation, info);
    if (!current || this.isReleased) return;
    this.queueItemReady();
    this.commit();
  }

  onPlaying(generation: number): void {
    if (this.isPrepared(generation))
      return this.log('next item', { event: 'playing' });
    if (this.accepts(generation)) this.skipStreak = 0;
    super.onPlaying(generation);
  }

  onBuffering(generation: number): void {
    if (this.isPrepared(generation))
      return this.log('next item', { event: 'buffering' });
    super.onBuffering(generation);
  }

  onFailed(generation: number, error: PlayerError): void {
    if (this.isPrepared(generation)) {
      this.unpreparable = this.prepared!.itemId;
      this.dropPrepared(`failed: ${error.code}`);
      return this.commit();
    }
    super.onFailed(generation, error);
  }

  onEnded(generation: number): void {
    if (this.isPrepared(generation))
      return this.log('next item', { event: 'ended' });
    super.onEnded(generation);
  }

  onPausedExternally(generation: number, reason: InterruptionReason): void {
    if (this.isPrepared(generation))
      return this.log('next item', { event: 'paused' });
    super.onPausedExternally(generation, reason);
  }

  // ── Hooks the core calls ──

  /**
   * The current item goes (an open, a stop, a reset, a handoff): so does
   * what was prepared behind it. A seek, a pause or a quality change keep it.
   */
  protected cancelSwap(reason: string): void {
    super.cancelSwap(reason);
    if (ITEM_ENDS.has(reason)) this.cancelPrepared(reason);
  }

  private cancelPrepared(reason: string): void {
    this.dropPrepared(reason);
    this.itemReadyAt = null;
    this.prepareDueAt = null;
  }

  protected advanceAtEnd(): boolean {
    const next = this.queue.peekNext(true);
    const current = this.queue.current;
    if (next == null || current == null || next.id === current.id) return false;
    this.queue.next(true);
    this.queueDirty = true;
    const prepared = this.prepared;
    if (
      prepared != null &&
      prepared.itemId === next.id &&
      this._playWhenReady
    ) {
      this.prepared = null;
      this.driver.advance?.(prepared.generation);
      this.takeOver(prepared, next, false);
    } else {
      this.loadItem(next, this._playWhenReady, null);
    }
    return true;
  }

  protected afterFatalFailure(error: PlayerError, wanted: boolean): void {
    if (this.queue.length === 0 || !isItemError(error)) return;
    this.skipStreak += 1;
    if (this.skipStreak >= this.queue.length) {
      this.log('queue stopped', { note: 'every item failed' });
      return;
    }
    const failed = this.queue.current;
    const next = this.queue.peekNext(false);
    if (failed == null || next == null || next.id === failed.id) return;
    // After the error's status and event: the app hears that this item failed.
    this.pendingEvents.push(() => {
      if (
        this.isReleased ||
        this._state !== 'error' ||
        this.lastError !== error ||
        this.queue.current?.id !== failed.id
      )
        return;
      this.queue.next(false);
      this.queueDirty = true;
      this.log('skipped', { code: error.code });
      this.loadItem(next, wanted, null);
    });
  }

  private isPrepared(generation: number): boolean {
    return !this.isReleased && this.prepared?.generation === generation;
  }

  private queueItemReady(): void {
    this.itemReadyAt ??= this.now;
    this.reconsiderNext();
  }

  // The core's clock hooks (named for video, which used them first).
  protected videoWakeup(t: number): void {
    super.videoWakeup(t);
    const due = this.prepareDueAt;
    if (due == null || due > t) return;
    this.prepareDueAt = null;
    this.reconsiderNext();
  }

  protected videoWakeups(candidates: number[]): void {
    super.videoWakeups(candidates);
    if (this.prepareDueAt != null) candidates.push(this.prepareDueAt);
  }

  protected commit(): void {
    if (this.queueDirty) {
      this.queueDirty = false;
      this.pendingEvents.push(() => this.delegate?.engineQueueChanged?.());
    }
    super.commit();
  }

  // ── Internals ──

  private emptyQueue(): void {
    if (this.queue.length === 0) return;
    this.queue.set([]);
    this.queueDirty = true;
    this.unpreparable = null;
    this.skipStreak = 0;
    this.applyLoop();
  }

  private checkIds(
    items: EngineQueueItem[],
    existing: readonly EngineQueueItem[]
  ): void {
    const seen = new Set(existing.map((item) => item.id));
    for (const item of items) {
      if (seen.has(item.id)) {
        throw engineError(
          'INVALID_ARGUMENT',
          `Two queue items have the id "${item.id}".`,
          false
        );
      }
      seen.add(item.id);
    }
  }

  /** Loads a queue item as a plain load would, keeping the queue. */
  private loadItem(
    item: EngineQueueItem,
    autoplay: boolean | null,
    startPosition: number | null
  ): void {
    this.applyLoop();
    // The intent is decided before the host may move the output (a Cast
    // receiver handing an item it cannot play back stops it there).
    const wanted =
      autoplay ?? (this._playWhenReady && continuesIntent(this._state));
    this.delegate?.engineQueueItemStarts?.(item.id, true);
    super.load(item.source, wanted, startPosition);
  }

  /** Goes to a queue item, through what was prepared when it is that item. */
  private go(item: EngineQueueItem, position: number | null): void {
    const prepared = this.prepared;
    const ready = prepared?.itemId === item.id && prepared.info != null;
    if (prepared != null && ready && position == null && this._playWhenReady) {
      this.prepared = null;
      this.driver.advance?.(prepared.generation);
      this.applyLoop();
      this.takeOver(prepared, item, false);
      this.commit();
      return;
    }
    this.loadItem(item, null, position);
  }

  /** The prepared item becomes the current one, under its own generation. */
  private takeOver(
    prepared: Prepared,
    item: EngineQueueItem,
    playing: boolean
  ): void {
    this.delegate?.engineQueueItemStarts?.(item.id, false);
    this.cancelFadeOut();
    this.settlePendingLoad({ kind: 'superseded' });
    this.chooseQuality(item.source, undefined);
    this._source = item.source;
    this._loadId += 1;
    this.pendingLoadId = this._loadId;
    this.isLive = item.source.liveHint ?? false;
    this.duration = null;
    this.seekable = false;
    this.lastError = null;
    this._interruption = null;
    this.resetRecovery();
    this.resumePosition = null;
    this._playWhenReady = true;
    this.videoLoad();
    this.log('advance', {
      uri: item.source.uri,
      gen: `${prepared.generation}`,
    });
    this.beginItem(prepared.generation, null, 'advance');
    this.itemReadyAt = null;
    this.prepareDueAt = null;
    this.videoOpened();
    const info = prepared.info;
    if (info != null) {
      this.applyFacts(info);
      this.readyForGeneration = true;
      this.setState('buffering', 'ready');
      this.beginWaiting();
      this.settlePendingLoad({ kind: 'ready' });
      this.queueItemReady();
    }
    if (playing) this.onPlaying(prepared.generation);
  }

  private dropPrepared(reason: string): void {
    const prepared = this.prepared;
    if (prepared == null) return;
    this.prepared = null;
    this.dropped = { generation: prepared.generation, under: this._generation };
    this.driver.cancelNext?.(prepared.generation);
    this.log('next item dropped', { reason });
  }

  private applyLoop(): void {
    // Repeat `one`, or `all` with one item: the item loops, seamlessly.
    const q = this.queue;
    const repeats =
      q.repeat === 'one' || (q.repeat === 'all' && q.length === 1);
    const loop = this.userLoop || (q.length > 0 && repeats);
    if (loop === this.loop) return;
    this.loop = loop;
    this.driver.setLoop?.(loop);
  }

  /** The item to prepare now, if any. */
  private nextToPrepare(): EngineQueueItem | null {
    const local = this.driver.prepareNext != null && !this.remote;
    const finite = this.readyForGeneration && !this.isLive;
    if (!local || this.loop || !finite || this.duration == null) return null;
    if (INACTIVE.has(this._state)) return null;
    const current = this.queue.current;
    const next = this.queue.peekNext(true);
    if (current == null || next == null || next.id === current.id) return null;
    return preparable(next) && next.id !== this.unpreparable ? next : null;
  }

  /** Drops a prepared item that is no longer next; prepares the next one when due. */
  private reconsiderNext(): void {
    const target = this.nextToPrepare();
    if (this.prepared != null && this.prepared.itemId !== target?.id) {
      this.dropPrepared('next changed');
    }
    if (target == null || this.prepared != null || this.itemReadyAt == null) {
      this.prepareDueAt = null;
      return;
    }
    const lead = Math.min(
      RecoveryPolicy.PREPARE_NEXT_AFTER_MS,
      (this.duration ?? 0) * 250
    );
    const due = this.itemReadyAt + lead;
    if (this.now < due) {
      this.prepareDueAt = due;
      return;
    }
    this.prepareDueAt = null;
    const generation = this.issueGeneration();
    this.prepared = { generation, itemId: target.id, info: null };
    this.log('next item prepared', {
      uri: target.source.uri,
      gen: `${generation}`,
    });
    this.driver.prepareNext!({
      generation,
      source: target.source,
      startPosition: null,
      playWhenReady: false,
      allowReconnect: this.options.reconnect,
    });
  }
}
