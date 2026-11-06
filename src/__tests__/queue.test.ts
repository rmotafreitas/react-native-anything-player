// `player.queue` on React Native: what it sends native, and how it mirrors
// the engine's queue. The engine's decisions are conformance/queue's.
import { fake } from './FakeNative';

jest.mock('../native/NativeAnythingPlayer', () => ({
  __esModule: true,
  default: require('./FakeNative').fake,
}));

import { Player } from '../Player';
import type { QueueState } from '../types';

beforeEach(() => {
  fake.calls = [];
  fake.rejectNext = null;
});

const sent = (id: string) =>
  fake.calls
    .filter((c) => c[0] === 'queueCommand' && c[1] === id)
    .map((c) => c[2] as Record<string, unknown>);

describe('player.queue', () => {
  it('sends normalized items with ids, and mirrors the queue as the app gave it', async () => {
    const p = new Player();
    const changes: QueueState[] = [];
    p.on('queueChange', (s) => changes.push(s));
    await p.queue.set(
      [
        'https://cdn.example/a.mp3',
        {
          id: 'ep2',
          uri: 'https://cdn.example/b.mp3',
          metadata: { title: 'B' },
        },
      ],
      { startIndex: 1, autoplay: true, startPosition: 30 }
    );
    expect(sent(p.id)).toEqual([
      {
        op: 'set',
        items: [
          { uri: 'https://cdn.example/a.mp3', id: 'q1' },
          {
            uri: 'https://cdn.example/b.mp3',
            metadata: { title: 'B' },
            id: 'ep2',
          },
        ],
        startIndex: 1,
        startPosition: 30,
        autoplay: true,
      },
    ]);
    expect(p.queue.items.map((i) => i.id)).toEqual(['q1', 'ep2']);
    expect(p.queue.index).toBe(1);
    expect(p.queue.current).toEqual({
      id: 'ep2',
      uri: 'https://cdn.example/b.mp3',
      metadata: { title: 'B' },
    });
    expect(changes).toHaveLength(1);
    expect(changes[0]!.current?.id).toBe('ep2');
    await p.release();
  });

  it('removes and skips by index or id, and follows native events', async () => {
    const p = new Player();
    await p.queue.set([
      'https://x.example/1',
      'https://x.example/2',
      'https://x.example/3',
    ]);
    await p.queue.remove(0);
    expect(sent(p.id).pop()).toEqual({ op: 'remove', ids: ['q1'] });
    await p.queue.skipTo(1, { position: 5 });
    expect(sent(p.id).pop()).toEqual({ op: 'skipTo', id: 'q3', position: 5 });
    expect(p.queue.current?.id).toBe('q3');
    // The engine moved on by itself (JS was frozen): the event catches up.
    fake.emit({
      playerId: p.id,
      type: 'queue',
      seq: 99,
      ids: ['q2', 'q3'],
      order: ['q2', 'q3'],
      index: 0,
      currentId: 'q2',
      repeat: 'all',
      shuffle: false,
    });
    expect(p.queue.current?.id).toBe('q2');
    expect(p.queue.repeat).toBe('all');
    await p.release();
  });

  it('refuses bad input before anything is sent', async () => {
    const p = new Player();
    await expect(
      p.queue.set([
        'https://a',
        { id: 'x', uri: 'https://b' },
        { id: 'x', uri: 'https://c' },
      ])
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(
      p.queue.set([{ id: '', uri: 'https://b' }])
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(p.queue.skipTo(3)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    await expect(p.queue.move(0.5, 1)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    await expect(p.queue.setRepeat('twice' as 'all')).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    await expect(p.queue.set(['ftp://nope'])).rejects.toMatchObject({
      code: 'INVALID_SOURCE',
    });
    expect(sent(p.id)).toEqual([]);
    await p.release();
  });

  it('a refused command leaves no trace of its items', async () => {
    const p = new Player();
    fake.rejectNext = { code: 'INVALID_ARGUMENT', message: 'no' };
    await expect(p.queue.add(['https://a'])).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    expect(p.queue.items).toEqual([]);
    await p.queue.add([{ id: 'k', uri: 'https://k' }]);
    expect(p.queue.items).toEqual([{ id: 'k', uri: 'https://k' }]);
    await p.release();
  });

  it('a queue item’s own refresh answers once it is current', async () => {
    const p = new Player();
    const refresh = jest.fn(async () => 'https://cdn.example/signed2');
    await p.queue.set([
      { id: 'a', uri: 'https://cdn.example/signed', refresh },
    ]);
    expect(sent(p.id)[0]!.items).toEqual([
      { uri: 'https://cdn.example/signed', refreshable: true, id: 'a' },
    ]);
    fake.emit({
      playerId: p.id,
      type: 'refreshRequest',
      seq: 50,
      loadId: 1,
      reason: 'unauthorized',
    });
    await new Promise<void>((r) => setImmediate(() => r()));
    expect(refresh).toHaveBeenCalledWith({ reason: 'unauthorized' });
    await p.release();
  });
});

describe('player.queue entries', () => {
  it('a refused set that reuses an id keeps the item native still plays', async () => {
    const p = new Player();
    await p.queue.set([{ id: 'a', uri: 'https://cdn.example/old.mp3' }]);
    fake.rejectNext = { code: 'INVALID_ARGUMENT', message: 'no' };
    await expect(
      p.queue.set([{ id: 'a', uri: 'https://cdn.example/new.mp3' }])
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(p.queue.current).toEqual({
      id: 'a',
      uri: 'https://cdn.example/old.mp3',
    });
    await p.release();
  });
});

describe('player.queue with load()', () => {
  it('a load after a queue keeps the new source’s refresh', async () => {
    const p = new Player();
    await p.queue.set([{ id: 'a', uri: 'https://cdn.example/a.mp3' }]);
    const refresh = jest.fn(async () => 'https://cdn.example/b2.mp3');
    await p.load({ uri: 'https://cdn.example/b.mp3', refresh });
    expect(p.queue.items).toEqual([]);
    fake.emit({
      playerId: p.id,
      type: 'refreshRequest',
      seq: 2e6,
      loadId: 2,
      reason: 'unauthorized',
    });
    await new Promise<void>((r) => setImmediate(() => r()));
    expect(refresh).toHaveBeenCalled();
    await p.release();
  });

  it('an add after a load mirrors the loaded source as the first item, its refresh kept', async () => {
    const p = new Player();
    const refresh = jest.fn(async () => 'https://cdn.example/s2.mp3');
    await p.load({ uri: 'https://cdn.example/s.mp3', refresh });
    fake.emit({
      playerId: p.id,
      type: 'queue',
      seq: 3e6,
      ids: ['loaded-1', 'n'],
      order: ['loaded-1', 'n'],
      index: 0,
      currentId: 'loaded-1',
      repeat: 'off',
      shuffle: false,
    });
    expect(p.queue.current).toEqual({
      uri: 'https://cdn.example/s.mp3',
      refresh,
      id: 'loaded-1',
    });
    fake.emit({
      playerId: p.id,
      type: 'refreshRequest',
      seq: 3e6 + 1,
      loadId: 1,
      reason: 'expiring',
    });
    await new Promise<void>((r) => setImmediate(() => r()));
    expect(refresh).toHaveBeenCalled();
    await p.release();
  });
});

describe('player.queue events', () => {
  it('a set with the same ids and new sources is a change', async () => {
    const p = new Player();
    await p.queue.set([{ id: 'a', uri: 'https://cdn.example/a.mp3?sig=1' }]);
    const seen: string[] = [];
    p.on('queueChange', (s) => seen.push(s.current?.uri ?? ''));
    await p.queue.set([{ id: 'a', uri: 'https://cdn.example/a.mp3?sig=2' }]);
    expect(seen).toEqual(['https://cdn.example/a.mp3?sig=2']);
    await p.release();
  });
});
