// A web player's queue commands (`queueCommand`), and what the page keeps
// for each queue item besides its source: its lock-screen fields, the object
// URL of a `Blob`/`File`, its poster. The queue itself is the engine's
// (`EngineQueue`); this is the host side, like the controller's `load`.

import type { PlaybackEngine } from '../engine/PlaybackEngine';
import type { EngineQueueItem, RepeatMode } from '../engine/EngineQueue';
import { engineError } from '../engine/types';
import { browser } from './dom';
import {
  parseSource,
  parseVideoParts,
  type NowPlayingFields,
  type VideoLoadParts,
} from './serialization';

/** What the host applies when a queue item becomes current. */
export interface QueueItemParts {
  fields: NowPlayingFields;
  /** The item's `Blob`/`File` object URL: the queue owns it, and revokes it when the item goes. */
  objectUrl: string | null;
  video: VideoLoadParts;
}

type Dict = Record<string, unknown>;

/** Items a command brings, and their parts, before it runs. */
interface Staged {
  items: EngineQueueItem[];
  parts: Map<string, QueueItemParts>;
}

const NO_VIDEO_PARTS: VideoLoadParts = {
  poster: null,
  session: null,
  subtitles: [],
};

const REPEAT: ReadonlySet<string> = new Set(['off', 'one', 'all']);

function invalid(message: string): Error {
  return engineError('INVALID_ARGUMENT', message, false);
}

function optionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export class WebQueue {
  private readonly parts = new Map<string, QueueItemParts>();

  constructor(private readonly engine: PlaybackEngine) {}

  get(id: string): QueueItemParts | undefined {
    return this.parts.get(id);
  }

  /** `{ ids, order, index, currentId, repeat, shuffle }`. */
  map(): Dict {
    return { ...this.engine.queueState };
  }

  command(command: Dict): void {
    const e = this.engine;
    switch (command.op) {
      case 'set': {
        const staged = this.parseItems(command.items);
        this.commit(staged, () =>
          e.queueSet(
            staged.items,
            optionalNumber(command.startIndex) ?? 0,
            optionalNumber(command.startPosition),
            typeof command.autoplay === 'boolean' ? command.autoplay : null
          )
        );
        break;
      }
      case 'add': {
        const staged = this.parseItems(command.items);
        this.commit(staged, () =>
          e.queueAdd(staged.items, optionalNumber(command.index) ?? undefined)
        );
        break;
      }
      case 'remove':
        e.queueRemove(this.ids(command.ids));
        break;
      case 'move':
        e.queueMove(
          optionalNumber(command.from) ?? -1,
          optionalNumber(command.to) ?? -1
        );
        break;
      case 'clear':
        e.queueClear();
        break;
      case 'skipTo':
        e.queueSkipTo(String(command.id), optionalNumber(command.position));
        break;
      case 'next':
        e.queueNext();
        break;
      case 'previous':
        e.queuePrevious();
        break;
      case 'repeat': {
        const mode = String(command.mode);
        if (!REPEAT.has(mode)) throw invalid(`Unknown repeat mode "${mode}".`);
        e.setRepeat(mode as RepeatMode);
        break;
      }
      case 'shuffle':
        e.setShuffle(command.enabled === true);
        break;
      default:
        throw invalid(`Unknown queue command "${String(command.op)}".`);
    }
    this.prune();
  }

  /**
   * The engine made a loaded source the queue's first item (`loaded-…`, a
   * `queue.add` after `load`): it keeps the fields and file the player had
   * for it. `true` when it took the file.
   */
  adoptLoaded(fields: NowPlayingFields, objectUrl: string | null): boolean {
    const id = this.engine.queueState.ids.find(
      (i) => i.startsWith('loaded-') && !this.parts.has(i)
    );
    if (id == null) return false;
    this.parts.set(id, { fields, objectUrl, video: NO_VIDEO_PARTS });
    return objectUrl != null;
  }

  /** Lets go of the items that left the queue. */
  prune(): void {
    const kept = new Set(this.engine.queueState.ids);
    for (const [id, parts] of this.parts) {
      if (kept.has(id)) continue;
      this.revoke(parts);
      this.parts.delete(id);
    }
  }

  release(): void {
    this.parts.forEach((parts) => this.revoke(parts));
    this.parts.clear();
  }

  private ids(value: unknown): string[] {
    if (!Array.isArray(value)) throw invalid('`ids` must be an array.');
    return value.map(String);
  }

  /**
   * Runs a command that brings items: their parts are in place while it
   * runs (the engine asks for the first item's), and kept if it succeeds; a
   * refused command leaves the parts as they were and revokes its own URLs.
   */
  private commit(staged: Staged, run: () => void): void {
    const before = new Map(
      staged.items.map((item) => [item.id, this.parts.get(item.id)])
    );
    staged.parts.forEach((parts, id) => this.parts.set(id, parts));
    try {
      run();
    } catch (error) {
      before.forEach((previous, id) => {
        if (previous != null) this.parts.set(id, previous);
        else this.parts.delete(id);
      });
      staged.parts.forEach((parts) => this.revoke(parts));
      throw error;
    }
    // Replaced items' files are gone from the queue now.
    before.forEach((previous) => {
      if (previous != null) this.revoke(previous);
    });
  }

  private parseItems(value: unknown): Staged {
    if (!Array.isArray(value)) throw invalid('Queue items must be an array.');
    const parts = new Map<string, QueueItemParts>();
    try {
      const items = value.map((raw) => {
        const map = (raw ?? {}) as Dict;
        const id = typeof map.id === 'string' ? map.id : '';
        if (id === '') throw invalid('Every queue item needs an id.');
        const blob = map.blob;
        const objectUrl =
          blob == null ? null : browser().URL.createObjectURL(blob);
        const [source, fields] = parseSource(
          objectUrl == null ? map : { ...map, uri: objectUrl }
        );
        parts.set(id, { fields, objectUrl, video: parseVideoParts(map) });
        return { id, live: source.liveHint === true, source };
      });
      return { items, parts };
    } catch (error) {
      parts.forEach((p) => this.revoke(p));
      throw error;
    }
  }

  private revoke(parts: QueueItemParts): void {
    if (parts.objectUrl != null) browser().URL.revokeObjectURL(parts.objectUrl);
  }
}
