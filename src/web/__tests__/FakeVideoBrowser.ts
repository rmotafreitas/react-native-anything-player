/**
 * What a video player needs of the page on top of `FakeBrowser`: `<div>`
 * boxes that hold children and a style, and `<video>` elements with one too.
 */
import type { FakeWorld } from './FakeBrowser';

export class FakeBox {
  style: Record<string, string> = {};
  children: unknown[] = [];
  parentNode: FakeBox | null = null;
  textContent: string | null = null;
  listeners = new Map<string, Array<() => void>>();

  appendChild(child: unknown): unknown {
    this.children.push(child);
    (child as { parentNode: FakeBox | null }).parentNode = this;
    return child;
  }

  remove(): void {
    const parent = this.parentNode;
    if (parent) parent.children = parent.children.filter((c) => c !== this);
    this.parentNode = null;
  }

  replaceChildren(...children: unknown[]): void {
    this.children = children;
  }

  addEventListener(type: string, listener: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((l) => l !== listener)
    );
  }
}

type CreateElement = (tag: string) => unknown;

/** Makes the world's document create boxes and video elements a player can use. */
export function enableVideo(world: FakeWorld): void {
  const document = world.document as unknown as {
    createElement: CreateElement;
  };
  const original = document.createElement.bind(document);
  document.createElement = (tag) => {
    if (tag !== 'video') return tag === 'div' ? new FakeBox() : original(tag);
    return Object.assign(original(tag) as object, {
      style: {} as Record<string, string>,
      parentNode: null,
      poster: '',
      controls: false,
      loop: false,
      playsInline: false,
      videoWidth: 0,
      videoHeight: 0,
      attributes: {} as Record<string, string>,
      setAttribute(name: string, value: string) {
        this.attributes[name] = value;
      },
    });
  };
}
