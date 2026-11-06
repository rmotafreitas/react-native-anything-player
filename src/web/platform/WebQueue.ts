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
        const items = this.parseItems(command.items);
        try {
          e.queueSet(
            items,
            optionalNumber(command.startIndex) ?? 0,
            optionalNumber(command.startPosition),
            typeof command.autoplay === 'boolean' ? command.autoplay : null
          );
        } catch (error) {
          this.forget(items);
          throw error;
        }
        break;
      }
      case 'add': {
        const items = this.parseItems(command.items);
        try {
          e.queueAdd(items, optionalNumber(command.index) ?? undefined);
        } catch (error) {
          this.forget(items);
          throw error;
        }
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

  private parseItems(value: unknown): EngineQueueItem[] {
    if (!Array.isArray(value)) throw invalid('Queue items must be an array.');
    const made: string[] = [];
    try {
      return value.map((raw) => {
        const map = (raw ?? {}) as Dict;
        const id = typeof map.id === 'string' ? map.id : '';
        if (id === '') throw invalid('Every queue item needs an id.');
        const blob = map.blob;
        const objectUrl =
          blob == null ? null : browser().URL.createObjectURL(blob);
        if (objectUrl != null) made.push(objectUrl);
        const [source, fields] = parseSource(
          objectUrl == null ? map : { ...map, uri: objectUrl }
        );
        const previous = this.parts.get(id);
        if (previous != null) this.revoke(previous);
        this.parts.set(id, { fields, objectUrl, video: parseVideoParts(map) });
        return { id, live: source.liveHint === true, source };
      });
    } catch (error) {
      made.forEach((url) => browser().URL.revokeObjectURL(url));
      throw error;
    }
  }

  /** Items a refused command brought: their parts go (unless an item of the queue has the id). */
  private forget(items: EngineQueueItem[]): void {
    const kept = new Set(this.engine.queueState.ids);
    for (const item of items) {
      if (kept.has(item.id)) continue;
      const parts = this.parts.get(item.id);
      if (parts) this.revoke(parts);
      this.parts.delete(item.id);
    }
  }

  private revoke(parts: QueueItemParts): void {
    if (parts.objectUrl != null) browser().URL.revokeObjectURL(parts.objectUrl);
  }
}
