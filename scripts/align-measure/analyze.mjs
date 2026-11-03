#!/usr/bin/env node
// Reads a recording of the test station's renditions program (generate-media.sh:
// every second starts with a click after 100 ms of silence and holds a tone
// at 300 + 25 × (second mod 60) Hz) back to where in the program each second
// was heard, and reports every jump: a quality switch that repeats audio
// shows as a negative jump, one that skips as a positive one, an aligned one
// as (almost) none.
//
//   node scripts/align-measure/analyze.mjs recording.wav [--json]
//
// The recording is a 16-bit PCM WAV (any rate, any channels). No dependencies.
import { readFileSync } from 'node:fs';

const BASE_HZ = 300;
const STEP_HZ = 25;
const NAMES = 60;
/** A jump smaller than this is the measurement's own noise. */
const NOISE_S = 0.012;

export function readWav(path) {
  const b = readFileSync(path);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE')
    throw new Error('not a WAV file');
  let at = 12;
  let rate = 0;
  let channels = 0;
  let bits = 0;
  while (at + 8 <= b.length) {
    const id = b.toString('ascii', at, at + 4);
    let size = b.readUInt32LE(at + 4);
    const body = at + 8;
    if (id === 'fmt ') {
      channels = b.readUInt16LE(body + 2);
      rate = b.readUInt32LE(body + 4);
      bits = b.readUInt16LE(body + 14);
    } else if (id === 'data') {
      if (bits !== 16) throw new Error(`${bits}-bit WAV: 16-bit only`);
      // A recorder that never finished writes 0 or a too large size.
      if (size === 0 || body + size > b.length) size = b.length - body;
      const frames = Math.floor(size / (2 * channels));
      const mono = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        let sum = 0;
        for (let c = 0; c < channels; c++) sum += b.readInt16LE(body + 2 * (i * channels + c));
        mono[i] = sum / channels / 32768;
      }
      return { rate, samples: mono };
    }
    at = body + size + (size & 1);
  }
  throw new Error('no data chunk');
}

/** The power of one frequency over `samples[from, to)` (Goertzel). */
function power(samples, rate, from, to, hz) {
  const k = (2 * Math.cos((2 * Math.PI * hz) / rate));
  let s1 = 0;
  let s2 = 0;
  for (let i = from; i < to; i++) {
    const s0 = samples[i] + k * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return s1 * s1 + s2 * s2 - k * s1 * s2;
}

/** The program's seconds as heard: [recording time of its click, its name (mod 60)]. */
export function seconds({ rate, samples }) {
  const win = Math.round(rate * 0.002);
  const rms = [];
  for (let i = 0; i + win <= samples.length; i += win) {
    let sum = 0;
    for (let j = i; j < i + win; j++) sum += samples[j] * samples[j];
    rms.push(Math.sqrt(sum / win));
  }
  const peak = rms.reduce((m, v) => Math.max(m, v), 0);
  if (peak === 0) return [];
  const loud = peak * 0.08;
  const quiet = peak * 0.02;
  const out = [];
  let silent = 0;
  for (let w = 0; w < rms.length; w++) {
    if (rms[w] < quiet) {
      silent += 1;
      continue;
    }
    // A sound after at least 50 ms of silence: a second's click.
    if (rms[w] >= loud && silent * 2 >= 50) {
      const start = w * win;
      const toneFrom = start + Math.round(rate * 0.05);
      const toneTo = start + Math.round(rate * 0.8);
      if (toneTo < samples.length) {
        let best = -1;
        let bestPower = 0;
        let total = 0;
        for (let n = 0; n < NAMES; n++) {
          const p = power(samples, rate, toneFrom, toneTo, BASE_HZ + STEP_HZ * n);
          total += p;
          if (p > bestPower) {
            bestPower = p;
            best = n;
          }
        }
        // The onset to the sample: the first sample over half the click's peak.
        let onset = start;
        let clickPeak = 0;
        for (let i = start - win; i < start + 2 * win; i++) clickPeak = Math.max(clickPeak, Math.abs(samples[i] ?? 0));
        for (let i = Math.max(0, start - win); i < start + 2 * win; i++) {
          if (Math.abs(samples[i]) >= clickPeak / 2) {
            onset = i;
            break;
          }
        }
        // A whole second: its tone runs on with no gap (a second cut short
        // by a switch, or begun mid-tone, says nothing exact), and one name
        // stands out (not a cut between two seconds).
        let whole = true;
        for (let v = w + 5; v < w + Math.round(0.85 / 0.002) && v < rms.length; v++)
          if (rms[v] < quiet) whole = false;
        if (whole && bestPower > total * 0.5) out.push([onset / rate, best]);
      }
    }
    silent = rms[w] < loud ? silent : 0;
  }
  return out;
}

/**
 * Program time minus recording time for each second heard, the names
 * unwrapped (a jump is taken as the nearest whole number of seconds that
 * its name allows), and the jumps between them.
 */
export function jumps(heard) {
  const offsets = [];
  let program = null;
  let previous = null;
  for (const [t, name] of heard) {
    if (previous == null) {
      program = name;
    } else {
      const elapsed = t - previous[0];
      // Where the program would be had nothing jumped, and the nearest second with this name.
      const expected = program + elapsed;
      const delta = ((name - (Math.round(expected) % NAMES)) % NAMES + NAMES * 1.5) % NAMES - NAMES / 2;
      program = Math.round(expected) + delta;
    }
    offsets.push({ t, program, offset: program - t });
    previous = [t, name];
  }
  const found = [];
  for (let i = 1; i < offsets.length; i++) {
    const jump = offsets[i].offset - offsets[i - 1].offset;
    if (Math.abs(jump) > NOISE_S) found.push({ at: offsets[i].t, jump });
  }
  return { offsets, jumps: found };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: analyze.mjs recording.wav [--json]');
    process.exit(2);
  }
  const heard = seconds(readWav(file));
  const result = jumps(heard);
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ seconds: heard.length, jumps: result.jumps }));
  } else {
    console.log(`${heard.length} seconds heard`);
    for (const j of result.jumps)
      console.log(`${j.at.toFixed(2)} s: ${j.jump > 0 ? 'skipped' : 'repeated'} ${Math.abs(j.jump).toFixed(3)} s`);
    if (result.jumps.length === 0) console.log('no jump');
  }
}
