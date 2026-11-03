/// <reference types="node" />
// The live offset estimator against `conformance/align/offset.json` (shared
// with the Kotlin and Swift twins): each case feeds readings in order and
// checks the offset and whether it settled.

import * as fs from 'fs';
import * as path from 'path';
import { LiveOffset, type OffsetReading } from '../engine/LiveOffset';

interface Step extends OffsetReading {
  t: number;
  expect?: { offset: number | null; settled: boolean };
}

const FILE = path.resolve(__dirname, '../../../conformance/align/offset.json');
const cases: Array<{ name: string; steps: Step[] }> = JSON.parse(
  fs.readFileSync(FILE, 'utf8')
);

describe('align/offset.json', () => {
  it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const estimator = new LiveOffset();
    for (const step of c.steps) {
      const value = estimator.read(step.t, step);
      if (!step.expect) continue;
      expect(value.settled).toBe(step.expect.settled);
      if (step.expect.offset == null) expect(value.offset).toBeNull();
      else expect(value.offset).toBeCloseTo(step.expect.offset, 6);
    }
  });
});
