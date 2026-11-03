/// <reference types="node" />
// The live aligner against `conformance/align/live.json` (shared with the Kotlin
// and Swift twins): each case runs a simulated pair of connections, the old
// one heard and the new one muted, and checks how the aligner lines them up.

import * as fs from 'fs';
import * as path from 'path';
import {
  LiveAligner,
  type AlignAction,
  type AlignCaps,
  type AlignReading,
} from '../engine/LiveAligner';

/** Two connections of one station (see `conformance/README.md`, "Aligner"). */
interface World {
  oldPosition: number;
  oldLag: number;
  burst: number;
  burstSpeed: number;
  chunkMs: number;
  startLatencyMs: number;
  endsAfterBurst?: boolean;
  oldStallAt?: number;
  oldReconnectingAt?: number;
  interruptAt?: number;
  nextReadyAt?: number;
  /** Each connection's own chunk beat (default `chunkMs`, phase 0). */
  oldChunkMs?: number;
  nextChunkMs?: number;
  oldPhaseMs?: number;
  nextPhaseMs?: number;
  /** The new playhead reads this much off, alternately early and late (coarse readings). */
  positionJitter?: number;
  /** The app's rate: both players run at it (× what the aligner asks of the new one). */
  appRate?: number;
  /** The ticks' lengths, in turn (late timers); default every 40 ms. */
  ticksMs?: number[];
  /** Readings carry when each edge's audio arrived (`edgeAt`). */
  edgeArrival?: boolean;
  /** Readings carry the stream's clock (`clock`: program dates, HLS/DASH). */
  programDates?: boolean;
  /** The new player starts this far along its own timeline (it can be moved back to 0). */
  nextStartAt?: number;
  /** Where the new player's live window starts (default 0): it cannot be moved back further. */
  nextWindowStart?: number;
  /** The new player's window start moves on with the clock (1 s/s), as a live window does. */
  nextWindowSlides?: boolean;
}

/** The stream clock's epoch seconds at the old connection's live point at `t` 0. */
const EPOCH = 1_700_000_000;

/** The time of the last chunk at `t`: chunks arrive every `every` ms from `phase`. */
function lastChunk(t: number, every: number, phase: number): number {
  return Math.floor((t - phase) / every) * every + phase;
}

interface AlignCase {
  name: string;
  caps: AlignCaps;
  world: World;
  expect: {
    outcome: string;
    at: number;
    actions: string[];
    maxResidual?: number;
    /** At most this many jumps (repeats too). */
    maxJumps?: number;
  };
}

interface Outcome {
  outcome: string;
  at: number;
  actions: string[];
  residual: number | null;
  /** Every jump, repeats too. */
  jumps: number;
}

const TICK_MS = 40;
const LIMIT_MS = 60_000;

/** Runs one case: the readings every tick, the aligner's answers applied. */
export function simulate(caps: AlignCaps, world: World): Outcome {
  const aligner = new LiveAligner(caps);
  const actions: string[] = [];
  const note = (kind: string) => {
    if (actions.at(-1) !== kind) actions.push(kind);
  };
  const k =
    world.burst - world.oldPosition - world.oldLag + (world.nextStartAt ?? 0);
  const nextStart = world.nextStartAt ?? 0;
  let x = nextStart;
  let jumps = 0;
  let rate = 0;
  let moveFrom: number | null = null;
  let lastT = 0;
  const ticks = world.ticksMs ?? [TICK_MS];
  const appRate = world.appRate ?? 1;
  for (let i = 0, t = 0; t <= LIMIT_MS; t += ticks[i % ticks.length]!, i++) {
    if (rate > 0 && moveFrom != null) {
      const from = Math.max(lastT, moveFrom);
      if (t > from) x += (rate * appRate * (t - from)) / 1000;
    }
    const tq = Math.max(
      0,
      lastChunk(t, world.nextChunkMs ?? world.chunkMs, world.nextPhaseMs ?? 0)
    );
    const arrived = (world.burstSpeed * tq) / 1000;
    const received =
      nextStart +
      (world.endsAfterBurst
        ? Math.min(arrived, world.burst)
        : Math.min(arrived, world.burst + tq / 1000));
    x = Math.min(x, received);
    const stallAt = world.oldStallAt;
    const stalled = stallAt != null && t >= stallAt;
    const oldT = stalled ? stallAt : t;
    const oldTq = lastChunk(
      oldT,
      world.oldChunkMs ?? world.chunkMs,
      world.oldPhaseMs ?? 0
    );
    const oldPosition = world.oldPosition + (appRate * oldT) / 1000;
    const arrival = world.edgeArrival === true;
    const old: AlignReading = {
      position: oldPosition,
      edge: world.oldPosition + world.oldLag + oldTq / 1000,
      ...(arrival ? { edgeAt: oldTq } : {}),
      ...(world.programDates
        ? { clock: EPOCH - world.oldPosition - world.oldLag }
        : {}),
      playing: !stalled,
      reconnecting:
        world.oldReconnectingAt != null && t >= world.oldReconnectingAt,
    };
    const jitter = world.positionJitter ?? 0;
    const next: AlignReading = {
      position: x + (i % 2 === 0 ? jitter : -jitter),
      edge: received,
      ...(arrival ? { edgeAt: tq } : {}),
      ...(world.programDates
        ? {
            clock: EPOCH - world.burst - nextStart,
            start:
              (world.nextWindowStart ?? 0) +
              (world.nextWindowSlides ? t / 1000 : 0),
          }
        : {}),
      playing: rate > 0 && moveFrom != null && t >= moveFrom && x < received,
      ready: world.nextReadyAt == null || t >= world.nextReadyAt,
    };
    const action: AlignAction =
      world.interruptAt != null && t >= world.interruptAt
        ? aligner.interrupt()
        : aligner.step(t, old, next);
    lastT = t;
    switch (action.kind) {
      case 'wait':
        break;
      case 'rate':
        note('rate');
        if (action.rate === 0) {
          rate = 0;
          moveFrom = null;
        } else {
          if (rate === 0)
            moveFrom = t + (action.afterMs ?? 0) + world.startLatencyMs;
          rate = action.rate;
        }
        break;
      case 'jump':
        note('jump');
        jumps += 1;
        x = Math.min(action.to, received);
        break;
      case 'takeOver':
        note('takeOver');
        return {
          outcome: 'takeOver',
          at: t,
          actions,
          residual: x - (oldPosition + k),
          jumps,
        };
      case 'fallback':
        note('fallback');
        return {
          outcome: `fallback:${action.reason}`,
          at: t,
          actions,
          residual: null,
          jumps,
        };
    }
  }
  return { outcome: 'none', at: LIMIT_MS, actions, residual: null, jumps };
}

const FILE = path.resolve(__dirname, '../../../conformance/align/live.json');
const cases: AlignCase[] = JSON.parse(fs.readFileSync(FILE, 'utf8'));

describe('align/live.json', () => {
  it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const result = simulate(c.caps, c.world);
    if (process.env.RNAP_PRINT_ALIGN === '1')
      console.log(c.name, JSON.stringify(result));
    expect({
      outcome: result.outcome,
      at: result.at,
      actions: result.actions,
    }).toEqual({
      outcome: c.expect.outcome,
      at: c.expect.at,
      actions: c.expect.actions,
    });
    if (c.expect.maxJumps != null)
      expect(result.jumps).toBeLessThanOrEqual(c.expect.maxJumps);
    if (c.expect.maxResidual != null)
      expect(Math.abs(result.residual!)).toBeLessThanOrEqual(
        c.expect.maxResidual
      );
  });
});
