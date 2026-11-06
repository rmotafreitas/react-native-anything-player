/// <reference types="node" />
// A web player's queue, through `WebModule`: the engine's decisions are the
// conformance suite's (conformance/queue.json); these cover the browser
// layer — the second element playing the next item, the lock-screen fields
// and the Media Session's next / previous.

import { install, uninstall, type FakeWorld } from './FakeBrowser';
import { WebModule } from '../platform/WebModule';

type Event = Record<string, unknown> & { type: string };

let world: FakeWorld;
let module: WebModule;
let events: Event[];

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await jest.advanceTimersByTimeAsync(0);
}
const ofType = (type: string) => events.filter((e) => e.type === type);
const state = (id: string) => (module.getStatus(id) as { state: string }).state;

const items = [
  {
    id: 'a',
    uri: 'https://cdn.example/a.mp3',
    live: false,
    metadata: { title: 'A' },
  },
  {
    id: 'b',
    uri: 'https://cdn.example/b.mp3',
    live: false,
    metadata: { title: 'B' },
  },
];

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'nextTick'] });
  world = install({});
  module = new WebModule();
  events = [];
  module.onPlayerEvent((e) => events.push(e as Event));
});

afterEach(() => {
  uninstall();
  jest.useRealTimers();
});

describe('web queue', () => {
  it('plays the next item from the second element when the first ends, with no ended event', async () => {
    const id = module.createPlayer({});
    await module.queueCommand(id, { op: 'set', items, autoplay: true });
    const first = world.element();
    expect(first.src).toBe('https://cdn.example/a.mp3');
    first.becomeReady(100);
    first.startPlaying();
    await flush();
    expect(world.session.metadata).toMatchObject({ init: { title: 'A' } });
    // Prepared two seconds after it is ready.
    jest.advanceTimersByTime(2_100);
    await flush();
    const second = world.elements[1]!;
    expect(second.src).toBe('https://cdn.example/b.mp3');
    expect(second.plays).toBe(0);
    second.becomeReady(80);
    await flush();

    first.dispatch('ended');
    await flush();
    expect(second.plays).toBe(1);
    second.startPlaying();
    await flush();
    expect(state(id)).toBe('playing');
    expect(ofType('ended')).toHaveLength(0);
    expect(module.getQueue(id)).toMatchObject({ currentId: 'b', index: 1 });
    expect(ofType('queue').pop()).toMatchObject({ currentId: 'b' });
    expect(world.session.metadata).toMatchObject({ init: { title: 'B' } });

    second.dispatch('ended');
    await flush();
    expect(ofType('ended')).toHaveLength(1);
    expect(state(id)).toBe('ended');
  });

  it('handles the Media Session next and previous itself while there is a queue', async () => {
    const id = module.createPlayer({});
    const session = world.session;
    await module.queueCommand(id, { op: 'set', items, autoplay: true });
    world.element().becomeReady(100);
    await flush();
    expect(session.handlers.get('nexttrack')).not.toBeNull();
    session.trigger('nexttrack');
    await flush();
    expect(module.getQueue(id)).toMatchObject({ currentId: 'b' });
    session.trigger('previoustrack');
    await flush();
    expect(module.getQueue(id)).toMatchObject({ currentId: 'a' });
    expect(ofType('remoteCommand')).toHaveLength(0);

    // A plain load empties the queue: the buttons are the app's again.
    module
      .load(id, { uri: 'https://radio.example/live', live: true }, {})
      .catch(() => undefined);
    await flush();
    expect(module.getQueue(id)).toMatchObject({ ids: [], currentId: null });
    expect(session.handlers.get('nexttrack')).toBeNull();
  });

  it('rejects a malformed command and keeps the queue', async () => {
    const id = module.createPlayer({});
    await module.queueCommand(id, { op: 'set', items });
    await expect(
      module.queueCommand(id, { op: 'add', items: [{ id: 'a', uri: 'x' }] })
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(
      module.queueCommand(id, { op: 'repeat', mode: 'twice' })
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(module.getQueue(id)).toMatchObject({ ids: ['a', 'b'] });
  });
});
