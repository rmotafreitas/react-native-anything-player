/// <reference types="node" />
// Runs conformance/queue/model.json against the TypeScript queue model.
// Twins: `android/src/test/.../QueueModelTest.kt`,
// `ios/Tests/AnythingPlayerCoreTests/QueueModelTests.swift`.

import fs from 'node:fs';
import path from 'node:path';
import {
  QueueModel,
  QueueRandom,
  type QueueEntry,
  type RepeatMode,
} from '../engine/QueueModel';

type Step = Record<string, unknown>;
interface Scenario {
  name: string;
  steps: Step[];
}

const FILE = path.resolve(__dirname, '../../../conformance/queue/model.json');
const scenarios = JSON.parse(fs.readFileSync(FILE, 'utf8')) as Scenario[];

function entries(value: unknown): QueueEntry[] {
  return (value as Array<string | { id: string; live?: boolean }>).map((v) =>
    typeof v === 'string'
      ? { id: v, live: false }
      : { id: v.id, live: !!v.live }
  );
}

function run(steps: Step[]): void {
  const q = new QueueModel(1);
  steps.forEach((step, i) => {
    const at = `step ${i}: ${JSON.stringify(step)}`;
    const expect_ = step.expect as Record<string, unknown> | undefined;
    if (expect_) {
      const actual: Record<string, unknown> = {
        current: q.current?.id ?? null,
        index: q.index,
        items: q.items.map((x) => x.id),
        order: [...q.order],
        next: q.peekNext(false)?.id ?? null,
        nextAuto: q.peekNext(true)?.id ?? null,
        previous: q.peekPrevious()?.id ?? null,
      };
      for (const key of Object.keys(expect_)) {
        expect([at, key, actual[key]]).toEqual([at, key, expect_[key]]);
      }
      return;
    }
    let result: unknown;
    switch (step.call) {
      case 'set':
        q.set(entries(step.items), (step.start as number | undefined) ?? 0);
        break;
      case 'add':
        q.add(entries(step.items), step.index as number | undefined);
        break;
      case 'remove':
        result = q.remove(step.ids as string[]);
        break;
      case 'move':
        q.move(step.from as number, step.to as number);
        break;
      case 'clear':
        q.clear();
        break;
      case 'skipTo':
        result = q.skipTo(step.id as string);
        break;
      case 'repeat':
        q.setRepeat(step.value as RepeatMode);
        break;
      case 'shuffle':
        q.setShuffle(step.value as boolean, step.seed as number | undefined);
        break;
      case 'next':
        result = q.next(!!step.auto)?.id ?? null;
        break;
      case 'previous': {
        const action = q.previous(step.position as number);
        result = action.kind === 'item' ? `item:${action.id}` : action.kind;
        break;
      }
      default:
        throw new Error(`unknown call in ${at}`);
    }
    if ('result' in step) {
      expect([at, result]).toEqual([at, step.result]);
    }
  });
}

describe('queue model (conformance/queue/model.json)', () => {
  it.each(scenarios.map((s) => [s.name, s] as const))('%s', (_, s) =>
    run(s.steps)
  );

  it('xorshift32 gives the same sequence as the twins', () => {
    const r = new QueueRandom(42);
    expect([r.next(), r.next(), r.next()]).toEqual([
      11355432, 2836018348, 476557059,
    ]);
    expect(new QueueRandom(0).next()).toBe(new QueueRandom(0x9e3779b9).next());
  });
});
