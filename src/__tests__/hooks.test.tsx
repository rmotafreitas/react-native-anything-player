import { act, render, screen } from '@testing-library/react-native';
import { AppState, Text } from 'react-native';
import { fake } from './FakeNative';

jest.mock('../native/NativeAnythingPlayer', () => ({
  __esModule: true,
  default: require('./FakeNative').fake,
}));

import { Player } from '../Player';
import {
  usePlaybackState,
  usePlayerEvent,
  usePlayerStatus,
  useProgress,
  useStreamMetadata,
} from '../hooks';

function Probe({ player }: { player: Player }) {
  const status = usePlayerStatus(player);
  const state = usePlaybackState(player);
  const metadata = useStreamMetadata(player);
  const progress = useProgress(player, 100);
  usePlayerEvent(player, 'ended', () => endedSpy());
  return (
    <Text testID="out">
      {status.state}|{state}|{metadata?.title ?? '-'}|{progress.position}
    </Text>
  );
}
const endedSpy = jest.fn();

describe('hooks', () => {
  it('render native state and update on events', async () => {
    const player = new Player();
    await render(<Probe player={player} />);
    expect(screen.getByTestId('out').props.children.join('')).toBe(
      'idle|idle|-|12.5'
    );
    await act(async () =>
      fake.emitStatus(player.id, { seq: 1, state: 'playing' })
    );
    await act(async () =>
      fake.emit({
        playerId: player.id,
        seq: 2,
        type: 'metadata',
        metadata: { title: 'Song', timestamp: 1 },
      })
    );
    await act(async () =>
      fake.emit({ playerId: player.id, seq: 3, type: 'ended' })
    );
    expect(screen.getByTestId('out').props.children.join('')).toBe(
      'playing|playing|Song|12.5'
    );
    expect(endedSpy).toHaveBeenCalledTimes(1);
    await player.release();
  });

  it('useProgress polls only while active and cleans up', async () => {
    jest.useFakeTimers();
    const player = new Player();
    const spy = jest.spyOn(fake, 'getProgress');
    const { unmount } = await render(<Probe player={player} />);
    const calls = spy.mock.calls.length;
    await act(async () => jest.advanceTimersByTime(350));
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(calls + 3);
    const change = (AppState.addEventListener as jest.Mock).mock.calls
      .filter((c) => c[0] === 'change')
      .at(-1)[1];
    await act(async () => change('background'));
    const paused = spy.mock.calls.length;
    await act(async () => jest.advanceTimersByTime(1000));
    expect(spy.mock.calls.length).toBe(paused);
    await act(async () => change('active'));
    expect(spy.mock.calls.length).toBeGreaterThan(paused);
    const listenersBefore = player.listenerCount();
    await unmount();
    expect(player.listenerCount()).toBeLessThan(listenersBefore);
    expect(player.listenerCount()).toBe(0);
    jest.useRealTimers();
    spy.mockRestore();
    await player.release();
  });

  it('useProgress on a released player returns an empty reading', async () => {
    const player = new Player();
    await player.release();
    await render(<Probe player={player} />);
    expect(screen.getByTestId('out').props.children.join('')).toBe(
      'idle|idle|-|0'
    );
  });
});
