// `player.queue`: the JS side of a player's queue. The queue itself lives in
// the engine (native on iOS and Android, the web engine in a browser): it
// advances, skips and repeats while JavaScript is frozen. This mirrors its
// snapshot and keeps each item as the app gave it.

import { PlayerError } from '../errors';
import { isPlaylistUri, resolvePlaylistSource } from './playlists';
import type {
  BlobInput,
  QueueItem,
  QueueItemInput,
  QueueSetOptions,
  QueueState,
  RepeatMode,
  Source,
} from '../types';

/** The engine's snapshot. */
interface NativeQueue {
  ids: string[];
  order: string[];
  index: number | null;
  currentId: string | null;
  repeat: RepeatMode;
  shuffle: boolean;
}

const EMPTY: NativeQueue = {
  ids: [],
  order: [],
  index: null,
  currentId: null,
  repeat: 'off',
  shuffle: false,
};

const REPEAT_MODES: ReadonlySet<string> = new Set(['off', 'one', 'all']);

/** What the queue needs from its `Player`. */
export interface QueueOwner {
  /** Sends a queue command and applies the status it resolves with. */
  command(command: Record<string, unknown>): Promise<void>;
  /** The engine's snapshot now. */
  read(): object;
  /** Normalizes an item's source as `load()` does. */
  normalize(
    input: Source | string | number | BlobInput
  ): Record<string, unknown>;
  /** A queue item became current: its hooks (refresh, DRM, thumbnails) answer now. */
  itemStarted(item: QueueItem | null): void;
  /** What `load()` last loaded (a `queue.add` after it makes it the first item). */
  loaded(): Source | null;
  /** Tells the app (`queueChange`). */
  changed(state: QueueState): void;
  /**
   * A command that replaces what plays (`load`, `queue.set`) begins: the
   * returned check is false once a later one began (a playlist fetch made
   * this one wait).
   */
  replaceTurn(): () => boolean;
  /** Whether a replacing command began since `turn` was taken (for `add`). */
  currentReplaceTurn(): number;
}

function invalid(message: string): PlayerError {
  return new PlayerError({
    code: 'INVALID_ARGUMENT',
    message,
    recoverable: false,
  });
}

function isPlainSource(value: unknown): value is Source & { id?: unknown } {
  if (typeof value !== 'object' || value == null) return false;
  const Blob = (globalThis as { Blob?: abstract new () => object }).Blob;
  return !(typeof Blob === 'function' && value instanceof Blob);
}

function parseNative(raw: unknown): NativeQueue {
  const map = (raw ?? {}) as Partial<NativeQueue>;
  return {
    ids: Array.isArray(map.ids) ? map.ids.map(String) : [],
    order: Array.isArray(map.order) ? map.order.map(String) : [],
    index: typeof map.index === 'number' ? map.index : null,
    currentId: typeof map.currentId === 'string' ? map.currentId : null,
    repeat: REPEAT_MODES.has(String(map.repeat))
      ? (map.repeat as RepeatMode)
      : 'off',
    shuffle: map.shuffle === true,
  };
}

/** A player's queue (`player.queue`). See the Queue guide. */
export class PlayerQueue {
  private snapshot: NativeQueue = EMPTY;
  /** The items as the app gave them, by id. */
  private readonly entries = new Map<string, QueueItem>();
  private generated = 0;

  /** @internal */
  constructor(private readonly owner: QueueOwner) {}

  // ── State ──

  /** The items, in list order. */
  get items(): QueueItem[] {
    return this.snapshot.ids.map((id) => this.item(id));
  }

  /** The current item's place in `items`, `null` when the queue is empty. */
  get index(): number | null {
    return this.snapshot.index;
  }

  /** The current item, `null` when the queue is empty. */
  get current(): QueueItem | null {
    const id = this.snapshot.currentId;
    return id == null ? null : this.item(id);
  }

  /** How the queue repeats: `off`, `one` (the current item) or `all`. */
  get repeat(): RepeatMode {
    return this.snapshot.repeat;
  }

  /** Whether the queue plays in shuffled order. */
  get shuffle(): boolean {
    return this.snapshot.shuffle;
  }

  /** Everything at once (what `queueChange` carries). */
  get state(): QueueState {
    return {
      items: this.items,
      index: this.snapshot.index,
      current: this.current,
      order: [...this.snapshot.order],
      repeat: this.snapshot.repeat,
      shuffle: this.snapshot.shuffle,
    };
  }

  // ── Commands ──

  /**
   * Replaces the queue and loads `startIndex` (an empty list unloads the
   * player). The queue then advances on its own, without a gap where the
   * platform can.
   */
  async set(
    items: QueueItemInput[],
    options: QueueSetOptions = {}
  ): Promise<void> {
    const current = this.owner.replaceTurn();
    const resolved = namesPlaylists(items)
      ? await resolvePlaylists(items)
      : items;
    // A newer load or set replaced what plays while the playlist was fetched.
    if (!current()) return;
    const prepared = this.prepare(resolved, new Set());
    const command: Record<string, unknown> = {
      op: 'set',
      items: prepared.map((p) => p.wire),
    };
    if (options.startIndex != null)
      command.startIndex = this.integer('startIndex', options.startIndex);
    if (options.startPosition != null)
      command.startPosition = this.finite(
        'startPosition',
        options.startPosition
      );
    if (options.autoplay != null) command.autoplay = options.autoplay;
    const before = this.snapshot;
    await this.send(command, prepared);
    // The same ids as before, given anew: the items changed all the same.
    if (this.snapshot === before) this.owner.changed(this.state);
    // The same current id: its new hooks answer from now on.
    const now = this.current;
    if (now != null && now.id === before.currentId) this.owner.itemStarted(now);
  }

  /** Inserts at `index` (default: the end). The current item plays on. */
  async add(
    items: QueueItemInput[],
    options: { index?: number } = {}
  ): Promise<void> {
    const turn = this.owner.currentReplaceTurn();
    const resolved = namesPlaylists(items)
      ? await resolvePlaylists(items)
      : items;
    // The queue it was meant for was replaced while the playlist was fetched.
    if (turn !== this.owner.currentReplaceTurn()) return;
    const prepared = this.prepare(resolved, new Set(this.snapshot.ids));
    const command: Record<string, unknown> = {
      op: 'add',
      items: prepared.map((p) => p.wire),
    };
    if (options.index != null)
      command.index = this.integer('index', options.index);
    await this.send(command, prepared);
  }

  /**
   * Removes items by id or index. When the current item goes, the next one
   * loads, keeping the play intent.
   */
  async remove(
    target: string | number | Array<string | number>
  ): Promise<void> {
    const list = Array.isArray(target) ? target : [target];
    await this.send({ op: 'remove', ids: list.map((t) => this.idOf(t)) });
  }

  /** Moves the item at `from` to `to` (indexes in `items`). */
  async move(from: number, to: number): Promise<void> {
    await this.send({
      op: 'move',
      from: this.integer('from', from),
      to: this.integer('to', to),
    });
  }

  /** Removes every item but the current one. */
  async clear(): Promise<void> {
    await this.send({ op: 'clear' });
  }

  /** Plays the item with this id (or at this index), from `position` seconds. */
  async skipTo(
    target: string | number,
    options: { position?: number } = {}
  ): Promise<void> {
    const command: Record<string, unknown> = {
      op: 'skipTo',
      id: this.idOf(target),
    };
    if (options.position != null)
      command.position = this.finite('position', options.position);
    await this.send(command);
  }

  /** The next item (with repeat `all`, the first after the last). Nothing at the end. */
  async next(): Promise<void> {
    await this.send({ op: 'next' });
  }

  /** Restarts the item more than 3 s in, else goes to the one before. */
  async previous(): Promise<void> {
    await this.send({ op: 'previous' });
  }

  /** `off`, `one` (loops the current item seamlessly) or `all` (wraps). */
  async setRepeat(mode: RepeatMode): Promise<void> {
    if (!REPEAT_MODES.has(mode))
      throw invalid(`Unknown repeat mode "${String(mode)}".`);
    await this.send({ op: 'repeat', mode });
  }

  /** Shuffled: the current item first, then the rest in random order. */
  async setShuffle(enabled: boolean): Promise<void> {
    await this.send({ op: 'shuffle', enabled });
  }

  // ── Internals ──

  /** @internal The engine's snapshot changed (a `queue` event, or a read). */
  _apply(raw: unknown): void {
    const next = parseNative(raw);
    const previous = this.snapshot;
    if (sameQueue(previous, next)) return;
    this.snapshot = next;
    const kept = new Set(next.ids);
    for (const id of [...this.entries.keys()]) {
      if (!kept.has(id)) this.entries.delete(id);
    }
    // A source loaded with `load()` that joined the queue (`add`): the
    // engine named it `loaded-…`; it is what was loaded, already started.
    const adopted = next.ids.find(
      (id) => id.startsWith('loaded-') && !this.entries.has(id)
    );
    const loaded = adopted != null ? this.owner.loaded() : null;
    if (adopted != null && loaded != null)
      this.entries.set(adopted, { ...loaded, id: adopted });
    const started =
      next.currentId != null &&
      next.currentId !== previous.currentId &&
      next.currentId !== adopted;
    // An emptied queue (a plain `load`) leaves the loaded source's hooks alone.
    if (started) this.owner.itemStarted(this.current);
    this.owner.changed(this.state);
  }

  /** @internal Reads the engine's snapshot (a player attached to a native one). */
  _refresh(): void {
    this._apply(this.owner.read());
  }

  private item(id: string): QueueItem {
    return this.entries.get(id) ?? { id, uri: '' };
  }

  private async send(
    command: Record<string, unknown>,
    added: Array<{ item: QueueItem }> = []
  ): Promise<void> {
    const before = new Map(
      added.map(({ item }) => [item.id, this.entries.get(item.id)])
    );
    added.forEach(({ item }) => this.entries.set(item.id, item));
    try {
      await this.owner.command(command);
    } catch (error) {
      // A refused command changed nothing: its items go, the ones it would
      // have replaced come back.
      before.forEach((previous, id) => {
        if (previous != null) this.entries.set(id, previous);
        else this.entries.delete(id);
      });
      throw error;
    }
    this._refresh();
  }

  private prepare(
    inputs: QueueItemInput[],
    taken: Set<string>
  ): Array<{ item: QueueItem; wire: Record<string, unknown> }> {
    if (!Array.isArray(inputs)) throw invalid('Queue items must be an array.');
    return inputs.map((input) => {
      const given = isPlainSource(input) && input.id != null ? input.id : null;
      if (given != null && (typeof given !== 'string' || given === '')) {
        throw invalid('A queue item id must be a non-empty string.');
      }
      let id = given;
      if (id == null) {
        do {
          this.generated += 1;
          id = `q${this.generated}`;
        } while (taken.has(id) || this.entries.has(id));
      }
      if (taken.has(id)) throw invalid(`Two queue items have the id "${id}".`);
      taken.add(id);
      const source = isPlainSource(input) ? { ...input } : input;
      if (isPlainSource(source)) delete (source as { id?: unknown }).id;
      const wire: Record<string, unknown> = {
        ...this.owner.normalize(source),
        id,
      };
      let item: QueueItem;
      if (typeof input === 'string') item = { id, uri: input };
      else if (typeof input === 'number') item = { id, uri: String(wire.uri) };
      else if (isPlainSource(input)) item = { ...(input as Source), id };
      else item = { id, uri: '', blob: input };
      return { item, wire };
    });
  }

  private idOf(target: string | number): string {
    if (typeof target === 'string') return target;
    const id = this.snapshot.ids[this.integer('index', target)];
    if (id == null) throw invalid(`No queue item at index ${target}.`);
    return id;
  }

  private integer(name: string, value: number): number {
    if (!Number.isInteger(value)) throw invalid(`${name} must be an integer.`);
    return value;
  }

  private finite(name: string, value: number): number {
    if (!Number.isFinite(value) || value < 0)
      throw invalid(`${name} must be a finite number ≥ 0.`);
    return value;
  }
}

/** A playlist file among the items (a station's `listen.pls`) plays its first entry. */
async function resolvePlaylists(
  items: QueueItemInput[]
): Promise<QueueItemInput[]> {
  if (!Array.isArray(items)) throw invalid('Queue items must be an array.');
  return Promise.all(items.map(resolvePlaylist));
}

/** Whether any item names a playlist file (only then does a command wait for a fetch). */
function namesPlaylists(items: QueueItemInput[]): boolean {
  return Array.isArray(items) && items.some(namesPlaylist);
}

function namesPlaylist(input: QueueItemInput): boolean {
  if (typeof input === 'string') return isPlaylistUri(input);
  const uri = isPlainSource(input) ? input.uri : null;
  return typeof uri === 'string' && isPlaylistUri(uri);
}

async function resolvePlaylist(input: QueueItemInput): Promise<QueueItemInput> {
  if (typeof input === 'string') {
    return isPlaylistUri(input) ? resolvePlaylistSource({ uri: input }) : input;
  }
  const uri = isPlainSource(input) ? input.uri : undefined;
  if (typeof uri !== 'string' || !isPlaylistUri(uri)) return input;
  return resolvePlaylistSource(input as Source);
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

function sameQueue(a: NativeQueue, b: NativeQueue): boolean {
  const position = a.index === b.index && a.currentId === b.currentId;
  const modes = a.repeat === b.repeat && a.shuffle === b.shuffle;
  return (
    position && modes && sameList(a.ids, b.ids) && sameList(a.order, b.order)
  );
}
