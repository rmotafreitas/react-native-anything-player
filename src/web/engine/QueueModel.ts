// A player's queue: which item is current, what comes next and before, in
// list or shuffled order, and how edits move the current item. Pure state:
// the host loads what it decides. Twins: `ios/Core/QueueModel.swift`,
// `android/.../core/QueueModel.kt`; held to `conformance/queue`.

export type RepeatMode = 'off' | 'one' | 'all';

/** What the model needs to know of an item. */
export interface QueueEntry {
  id: string;
  /** A live stream: never ends on its own, `previous` never restarts it. */
  live: boolean;
}

/** What `previous` does. */
export type PreviousAction =
  { kind: 'restart' } | { kind: 'item'; id: string } | { kind: 'none' };

/** `previous` more than this far into a finite item restarts it, seconds. */
export const RESTART_THRESHOLD_S = 3;

/**
 * xorshift32: the shuffle's generator, the same in every twin so a seed
 * gives the same order everywhere.
 */
/* eslint-disable no-bitwise -- xorshift32 is bitwise by nature */
export class QueueRandom {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0 || 0x9e3779b9;
  }

  /** The next value, 0 ≤ n < 2³². */
  next(): number {
    let x = this.state;
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    this.state = x;
    return x;
  }

  /** 0 ≤ n < bound. */
  below(bound: number): number {
    return this.next() % bound;
  }
}

/* eslint-enable no-bitwise */

export class QueueModel<T extends QueueEntry = QueueEntry> {
  private list: T[] = [];
  /** Ids in play order: the list's order, or a permutation of it while shuffled. */
  private playOrder: string[] = [];
  private currentId: string | null = null;
  private repeatMode: RepeatMode = 'off';
  private shuffled = false;
  private random: QueueRandom;

  constructor(seed: number = Date.now()) {
    this.random = new QueueRandom(seed);
  }

  get items(): readonly T[] {
    return this.list;
  }

  /** Ids in the order they play. */
  get order(): readonly string[] {
    return this.playOrder;
  }

  get current(): T | null {
    return this.currentId == null ? null : this.find(this.currentId);
  }

  /** The current item's place in `items`, `null` when none. */
  get index(): number | null {
    if (this.currentId == null) return null;
    const i = this.indexOf(this.currentId);
    return i < 0 ? null : i;
  }

  get repeat(): RepeatMode {
    return this.repeatMode;
  }

  get shuffle(): boolean {
    return this.shuffled;
  }

  get length(): number {
    return this.list.length;
  }

  find(id: string): T | null {
    return this.list.find((item) => item.id === id) ?? null;
  }

  indexOf(id: string): number {
    return this.list.findIndex((item) => item.id === id);
  }

  // ── Edits ──

  /** Replaces every item; `startIndex` becomes current (clamped), none when empty. */
  set(items: T[], startIndex = 0): void {
    this.list = [...items];
    this.currentId =
      items.length === 0
        ? null
        : items[Math.min(Math.max(0, startIndex), items.length - 1)]!.id;
    this.reorder();
  }

  /** Inserts at `index` (default: the end). The current item stays current. */
  add(items: T[], index: number = this.list.length): void {
    if (items.length === 0) return;
    const at = Math.min(Math.max(0, index), this.list.length);
    this.list.splice(at, 0, ...items);
    if (!this.shuffled) {
      this.playOrder = this.list.map((item) => item.id);
    } else {
      for (const item of items) {
        const pos =
          this.currentId == null ? -1 : this.playOrder.indexOf(this.currentId);
        const slots = this.playOrder.length - pos;
        this.playOrder.splice(pos + 1 + this.random.below(slots), 0, item.id);
      }
    }
    if (this.currentId == null) this.currentId = this.playOrder[0] ?? null;
  }

  /**
   * Removes these ids. When the current item goes, the one that took its
   * place in play order becomes current (the one before when it was last).
   * Returns whether the current item changed.
   */
  remove(ids: string[]): boolean {
    const gone = new Set(ids);
    const before = this.currentId;
    let replacement: string | null = null;
    if (before != null && gone.has(before)) {
      const pos = this.playOrder.indexOf(before);
      const after = this.playOrder.slice(pos + 1).find((id) => !gone.has(id));
      const earlier = this.playOrder
        .slice(0, pos)
        .reverse()
        .find((id) => !gone.has(id));
      replacement = after ?? earlier ?? null;
    } else {
      replacement = before;
    }
    this.list = this.list.filter((item) => !gone.has(item.id));
    this.playOrder = this.playOrder.filter((id) => !gone.has(id));
    this.currentId = replacement;
    return this.currentId !== before;
  }

  /** Moves the item at `from` to `to` in the list (play order follows unless shuffled). */
  move(from: number, to: number): void {
    if (from < 0 || from >= this.list.length) return;
    const target = Math.min(Math.max(0, to), this.list.length - 1);
    const [item] = this.list.splice(from, 1);
    this.list.splice(target, 0, item!);
    if (!this.shuffled) this.playOrder = this.list.map((i) => i.id);
  }

  /** Every item but the current one goes. */
  clear(): void {
    const current = this.current;
    this.list = current ? [current] : [];
    this.playOrder = current ? [current.id] : [];
  }

  /** Makes this item current. */
  skipTo(id: string): boolean {
    if (this.find(id) == null) return false;
    this.currentId = id;
    return true;
  }

  setRepeat(mode: RepeatMode): void {
    this.repeatMode = mode;
  }

  /**
   * Shuffled: the current item first, then the rest in random order. Back
   * to list order: play goes on from the current item.
   */
  setShuffle(on: boolean, seed?: number): void {
    if (seed != null) this.random = new QueueRandom(seed);
    this.shuffled = on;
    this.reorder();
  }

  // ── Navigation ──

  /**
   * The item after the current one. `auto`: the current item ended on its
   * own (repeat `one` plays it again); otherwise the user skipped, and
   * repeat `one` acts as `all`. `null` at the end of the queue.
   */
  peekNext(auto: boolean): T | null {
    const current = this.currentId;
    if (current == null) return null;
    if (auto && this.repeatMode === 'one') return this.current;
    const pos = this.playOrder.indexOf(current);
    const wraps = this.repeatMode !== 'off';
    let id = this.playOrder[pos + 1];
    if (id == null && wraps) id = this.playOrder[0];
    return id == null ? null : this.find(id);
  }

  /** The item before the current one, `null` at the start. */
  peekPrevious(): T | null {
    const current = this.currentId;
    if (current == null) return null;
    const pos = this.playOrder.indexOf(current);
    const wraps = this.repeatMode !== 'off';
    let id = pos > 0 ? this.playOrder[pos - 1] : undefined;
    if (id == null && wraps) id = this.playOrder[this.playOrder.length - 1];
    return id == null ? null : this.find(id);
  }

  /** Moves to the next item; `null` (nothing changes) at the end. */
  next(auto: boolean): T | null {
    const item = this.peekNext(auto);
    if (item != null) this.currentId = item.id;
    return item;
  }

  /**
   * What previous does `position` seconds into the current item: restart a
   * finite item past the threshold (or with nothing before it), else move
   * to the item before.
   */
  previous(position: number): PreviousAction {
    const current = this.current;
    if (current == null) return { kind: 'none' };
    if (!current.live && position > RESTART_THRESHOLD_S) {
      return { kind: 'restart' };
    }
    const before = this.peekPrevious();
    if (before == null || before.id === current.id) {
      return current.live ? { kind: 'none' } : { kind: 'restart' };
    }
    this.currentId = before.id;
    return { kind: 'item', id: before.id };
  }

  private reorder(): void {
    const ids = this.list.map((item) => item.id);
    if (!this.shuffled) {
      this.playOrder = ids;
      return;
    }
    const rest = ids.filter((id) => id !== this.currentId);
    for (let i = rest.length - 1; i > 0; i -= 1) {
      const j = this.random.below(i + 1);
      [rest[i], rest[j]] = [rest[j]!, rest[i]!];
    }
    this.playOrder = this.currentId == null ? rest : [this.currentId, ...rest];
  }
}
