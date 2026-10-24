/// <reference types="node" />
// Runs `conformance/metadata/icy.json` (shared with the Swift and Kotlin
// parsers), plus the de-interleaver properties `IcyFramingTests.swift` checks.

import fs from 'node:fs';
import path from 'node:path';
import { Backoff } from '../engine/RecoveryPolicy';
import {
  IcyDeinterleaver,
  IcyParser,
  type IcyBlock,
  type StreamTitleFormat,
} from '../engine/StreamMetadata';

interface Case {
  name: string;
  text?: string;
  bytes?: string;
  fields?: Record<string, string>;
  format?: StreamTitleFormat;
  expect: Record<string, unknown>;
}

const cases = JSON.parse(
  fs.readFileSync(
    path.resolve(__dirname, '../../../conformance/metadata/icy.json'),
    'utf8'
  )
) as Case[];

const hex = (s: string) =>
  Uint8Array.from(s.match(/../g)!.map((b) => parseInt(b, 16)));

describe('ICY metadata conformance (web twin)', () => {
  it.each(cases.map((c): [string, Case] => [c.name, c]))('%s', (_name, c) => {
    const format = c.format ?? 'artist-title';
    const meta =
      c.text != null
        ? IcyParser.metadataFromBlock(new TextEncoder().encode(c.text), format)
        : c.bytes != null
          ? IcyParser.metadataFromBlock(hex(c.bytes), format)
          : IcyParser.metadataFromFields(c.fields!, format);
    for (const [key, value] of Object.entries(c.expect)) {
      if (key === 'title') expect(meta.title).toEqual(value);
      else if (key === 'artist') expect(meta.artist).toEqual(value);
      else if (key === 'artworkUri') expect(meta.artworkUri).toEqual(value);
      else if (key === 'raw') expect(meta.raw).toEqual(value);
      else throw new Error(`unknown key ${key}`);
    }
  });

  it('decode never fails', () => {
    for (let b = 0; b < 256; b++)
      IcyParser.decode(Uint8Array.of(b, 0x41, 255 - b));
    expect(IcyParser.decode(new Uint8Array(0))).toBe('');
    expect(IcyParser.decode(new Uint8Array(3))).toBe('');
  });

  it('random input never crashes', () => {
    const alphabet = [
      ...new TextEncoder().encode("StreamTitle='; -"),
      0,
      0x92,
      0xc3,
      0xe9,
    ];
    let seed = 42;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    expect(() => {
      for (let k = 0; k < 2000; k++) {
        const bytes = Uint8Array.from(
          { length: rand(64) },
          () => alphabet[rand(alphabet.length)]!
        );
        IcyParser.metadataFromBlock(bytes, 'artist-title');
      }
    }).not.toThrow();
  });

  it('backoff sequence matches the twins', () => {
    const backoff = new Backoff(() => 0.5);
    expect(Array.from({ length: 7 }, () => backoff.next())).toEqual([
      1000, 2000, 4000, 8000, 16000, 30000, 30000,
    ]);
    backoff.reset();
    expect(backoff.next()).toBe(1000);
    expect(new Backoff(() => 0).next()).toBe(800);
    expect(new Backoff(() => 0.999999).next()).toBe(1200);
  });
});

/** Builds an ICY body: `metaint` audio bytes, then a metadata block, repeated. */
function body(metaint: number, chunks: number, titles: Array<string | null>) {
  const out: number[] = [];
  const audio: number[] = [];
  const blocks: Array<[number, string]> = [];
  for (let c = 0; c < chunks; c++) {
    const slice = Array.from({ length: metaint }, (_, k) => (k + c * 7) % 256);
    out.push(...slice);
    audio.push(...slice);
    const title = titles[c % titles.length];
    if (title != null) {
      const payload = [...new TextEncoder().encode(`StreamTitle='${title}';`)];
      const length = Math.ceil(payload.length / 16);
      while (payload.length < length * 16) payload.push(0);
      out.push(length, ...payload);
      blocks.push([audio.length, title]);
    } else {
      out.push(0);
    }
  }
  return { input: Uint8Array.from(out), audio, blocks };
}

describe('IcyDeinterleaver', () => {
  it('splits a whole body into audio and timed blocks', () => {
    const { input, audio, blocks } = body(100, 6, ['A - B', null, 'Ç - 日本']);
    const d = new IcyDeinterleaver(100);
    const out = d.consume(input);
    expect([...out.audio]).toEqual(audio);
    expect(out.blocks.map((b) => b.audioOffset)).toEqual(
      blocks.map((b) => b[0])
    );
    expect(
      out.blocks.map((b) => IcyParser.metadataFromBlock(b.bytes, 'title').title)
    ).toEqual(blocks.map((b) => b[1]));
    expect(d.audioBytes).toBe(audio.length);
  });

  it('gives the same result for any chunking', () => {
    const { input, audio, blocks } = body(37, 40, [
      'x',
      null,
      'longer title - with words',
      null,
      null,
    ]);
    for (let seed = 1; seed <= 300; seed++) {
      let s = seed;
      const d = new IcyDeinterleaver(37);
      const gotAudio: number[] = [];
      const gotBlocks: IcyBlock[] = [];
      let i = 0;
      while (i < input.length) {
        s = (s * 48271) % 2147483647;
        const n = Math.min(input.length - i, (s % 64) + 1);
        const out = d.consume(input.subarray(i, i + n));
        gotAudio.push(...out.audio);
        gotBlocks.push(...out.blocks);
        i += n;
      }
      expect(gotAudio).toEqual(audio);
      expect(gotBlocks.map((b) => b.audioOffset)).toEqual(
        blocks.map((b) => b[0])
      );
    }
  });

  it('passes everything through without a metaint', () => {
    const d = new IcyDeinterleaver(0);
    const data = Uint8Array.of(1, 2, 3);
    expect(d.consume(data)).toEqual({ audio: data, blocks: [] });
    expect(d.audioBytes).toBe(3);
  });
});
