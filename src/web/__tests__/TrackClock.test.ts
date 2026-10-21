// Twin of `TrackClockTest.kt` / `TrackClockTests.swift`.
import { TrackClock } from '../engine/TrackClock';

describe('TrackClock', () => {
  it('advances only while running', () => {
    const clock = new TrackClock(10, 200, 0, true);
    expect(clock.elapsed(5_000)).toBeCloseTo(15);
    clock.setRunning(false, 5_000);
    expect(clock.elapsed(60_000)).toBeCloseTo(15);
    clock.setRunning(true, 60_000);
    expect(clock.elapsed(62_500)).toBeCloseTo(17.5);
  });

  it('clamps to the song', () => {
    expect(new TrackClock(-3, 30, 0, false).elapsed(0)).toBe(0);
    expect(new TrackClock(25, 30, 0, true).elapsed(60_000)).toBe(30);
    expect(new TrackClock(99, 30, 0, false).elapsed(0)).toBe(30);
  });

  it('treats a repeated state as a no-op', () => {
    const clock = new TrackClock(0, 100, 0, true);
    clock.setRunning(true, 4_000);
    expect(clock.elapsed(10_000)).toBeCloseTo(10);
    clock.setRunning(false, 10_000);
    clock.setRunning(false, 20_000);
    expect(clock.elapsed(30_000)).toBeCloseTo(10);
  });
});
