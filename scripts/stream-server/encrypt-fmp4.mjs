// Encrypts fragmented MP4 (an init segment and its media segments) with
// CENC, the `cenc` scheme (AES-128-CTR), for the DRM fixtures: ffmpeg's own
// encryption writes no per-fragment sample information, and browsers only
// decrypt fragmented MP4 (through Media Source Extensions).
//
// The init's sample entries become `encv`/`enca` with a `sinf` (frma, schm,
// tenc), and a Clear Key `pssh` goes in the `moov`. In each fragment, every
// sample is encrypted in place (video by subsamples: each NAL unit's length
// and header stay clear, as decoders and browsers expect), and each `traf`
// gets its `senc`, `saiz` and `saio`; the `trun` data offsets move by what the
// `moof` grew.
//
//   node encrypt-fmp4.mjs <kid hex> <key hex> init.mp4 seg-0.m4s seg-1.m4s …
import { createCipheriv, createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const [kidHex, keyHex, initFile, ...segments] = process.argv.slice(2);
const KID = Buffer.from(kidHex, 'hex');
const KEY = Buffer.from(keyHex, 'hex');
const CLEAR_KEY_SYSTEM = Buffer.from('1077efecc0b24d02ace33c1e52e2fb4b', 'hex');

const u32 = (v) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(v >>> 0, 0);
  return b;
};
const u16 = (v) => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(v, 0);
  return b;
};
const box = (type, ...parts) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([u32(8 + body.length), Buffer.from(type, 'ascii'), body]);
};
const fullBox = (type, version, flags, ...parts) =>
  box(type, u32(((version << 24) | flags) >>> 0), ...parts);

/** The child boxes of `data[start, end)`. */
function children(data, start, end) {
  const out = [];
  let at = start;
  while (at + 8 <= end) {
    const size = data.readUInt32BE(at);
    if (size < 8 || at + size > end) break;
    out.push({ type: data.toString('ascii', at + 4, at + 8), start: at, size });
    at += size;
  }
  return out;
}

const HEADER = 8;

// ── The init segment ──

/** A sample entry → its encrypted form, with the protection scheme inside. */
function protectEntry(entry) {
  const type = entry.toString('ascii', 4, 8);
  const encrypted = type === 'avc1' || type === 'hvc1' ? 'encv' : 'enca';
  const sinf = box(
    'sinf',
    box('frma', Buffer.from(type, 'ascii')),
    fullBox('schm', 0, 0, Buffer.from('cenc', 'ascii'), u32(0x00010000)),
    box(
      'schi',
      // tenc v0: reserved ×2, protected, 8-byte IVs, the key id
      fullBox('tenc', 0, 0, Buffer.from([0, 0, 1, 8]), KID)
    )
  );
  const out = Buffer.concat([entry, sinf]);
  out.writeUInt32BE(out.length, 0);
  out.write(encrypted, 4, 'ascii');
  return out;
}

/** Rewrites `data[box]` with its children transformed (sizes fixed up). */
function rewrite(data, b, transform, skip = 0) {
  const parts = [data.subarray(b.start, b.start + HEADER + skip)];
  for (const c of children(data, b.start + HEADER + skip, b.start + b.size))
    parts.push(transform(c));
  const out = Buffer.concat(parts);
  out.writeUInt32BE(out.length, 0);
  return out;
}

function encryptInit(data) {
  const parts = [];
  for (const top of children(data, 0, data.length)) {
    if (top.type !== 'moov') {
      parts.push(data.subarray(top.start, top.start + top.size));
      continue;
    }
    const containers = new Set(['trak', 'mdia', 'minf', 'stbl']);
    const walk = (b) => {
      if (containers.has(b.type)) return rewrite(data, b, walk);
      // stsd: version/flags and an entry count before its entries.
      if (b.type === 'stsd')
        return rewrite(data, b, (e) => protectEntry(data.subarray(e.start, e.start + e.size)), 8);
      return data.subarray(b.start, b.start + b.size);
    };
    let moov = rewrite(data, top, walk);
    const pssh = fullBox('pssh', 1, 0, CLEAR_KEY_SYSTEM, u32(1), KID, u32(0));
    moov = Buffer.concat([moov, pssh]);
    moov.writeUInt32BE(moov.length, 0);
    parts.push(moov);
  }
  return Buffer.concat(parts);
}

// ── Media segments ──

/** The init's track kinds by track id (video NAL units are encrypted by subsamples). */
function trackKinds(init) {
  const kinds = new Map();
  for (const moov of children(init, 0, init.length).filter((b) => b.type === 'moov'))
    for (const trak of children(init, moov.start + HEADER, moov.start + moov.size)) {
      if (trak.type !== 'trak') continue;
      const tkhd = children(init, trak.start + HEADER, trak.start + trak.size).find((c) => c.type === 'tkhd');
      const version = init[tkhd.start + HEADER];
      const id = init.readUInt32BE(tkhd.start + HEADER + 4 + (version === 1 ? 16 : 8));
      const handler = init.indexOf('vide', trak.start) !== -1 && init.indexOf('vide', trak.start) < trak.start + trak.size;
      kinds.set(id, handler ? 'video' : 'audio');
    }
  return kinds;
}

let ivCounter = 0n;
function nextIv() {
  ivCounter += 1n;
  const iv = Buffer.alloc(8);
  iv.writeBigUInt64BE(ivCounter ^ BigInt('0x' + createHash('md5').update(KID).digest('hex').slice(0, 16)), 0);
  return iv;
}

/** Encrypts one sample in place; its aux info (IV, subsamples). */
function encryptSample(sample, video) {
  const iv = nextIv();
  const cipher = createCipheriv('aes-128-ctr', KEY, Buffer.concat([iv, Buffer.alloc(8)]));
  if (!video) {
    cipher.update(sample).copy(sample);
    return { iv, subsamples: null };
  }
  const subsamples = [];
  let at = 0;
  while (at + 4 <= sample.length) {
    const size = sample.readUInt32BE(at);
    const total = 4 + size;
    // Small units (parameter sets, SEI) stay clear; in larger ones a whole
    // number of 16-byte blocks is protected after the length and header.
    const protectedBytes = size < 112 ? 0 : Math.floor((size - 1) / 16) * 16;
    const clear = total - protectedBytes;
    if (protectedBytes > 0) {
      const from = at + clear;
      cipher.update(sample.subarray(from, from + protectedBytes)).copy(sample, from);
    }
    subsamples.push([clear, protectedBytes]);
    at += total;
  }
  return { iv, subsamples };
}

function encryptSegment(data, kinds) {
  const out = [];
  const tops = children(data, 0, data.length);
  for (let i = 0; i < tops.length; i++) {
    const top = tops[i];
    if (top.type !== 'moof') {
      out.push(data.subarray(top.start, top.start + top.size));
      continue;
    }
    const mdat = tops[i + 1];
    if (!mdat || mdat.type !== 'mdat') throw new Error('a moof without its mdat');
    const media = Buffer.from(data.subarray(mdat.start, mdat.start + mdat.size));
    // The trafs: their samples, encrypted in the copy of the mdat.
    const trafs = children(data, top.start + HEADER, top.start + top.size).filter((c) => c.type === 'traf');
    const added = [];
    for (const traf of trafs) {
      const parts = children(data, traf.start + HEADER, traf.start + traf.size);
      const tfhd = parts.find((c) => c.type === 'tfhd');
      const trun = parts.find((c) => c.type === 'trun');
      const id = data.readUInt32BE(tfhd.start + 12);
      const video = kinds.get(id) === 'video';
      const flags = data.readUInt32BE(trun.start + 8) & 0xffffff;
      const count = data.readUInt32BE(trun.start + 12);
      let at = trun.start + 16;
      const offset = flags & 0x1 ? data.readInt32BE(at) : 0;
      if (flags & 0x1) at += 4;
      if (flags & 0x4) at += 4;
      const defaultSize = (() => {
        const tf = data.readUInt32BE(tfhd.start + 8) & 0xffffff;
        let p = tfhd.start + 16;
        if (tf & 0x1) p += 8;
        if (tf & 0x2) p += 4;
        if (tf & 0x8) p += 4;
        return tf & 0x10 ? data.readUInt32BE(p) : 0;
      })();
      // Sample offsets in the mdat (relative to the moof: default-base-is-moof).
      let position = offset - (mdat.start - top.start);
      const infos = [];
      for (let s = 0; s < count; s++) {
        if (flags & 0x100) at += 4;
        const size = flags & 0x200 ? data.readUInt32BE(at) : defaultSize;
        if (flags & 0x200) at += 4;
        if (flags & 0x400) at += 4;
        if (flags & 0x800) at += 4;
        infos.push(encryptSample(media.subarray(position, position + size), video));
        position += size;
      }
      added.push({ traf, video, infos });
    }
    // The new moof: each traf with senc, saiz, saio; the trun offsets moved.
    const newTrafs = [];
    const sencOffsets = [];
    for (const { traf, video, infos } of added) {
      const entries = infos.map(({ iv, subsamples }) =>
        subsamples
          ? Buffer.concat([iv, u16(subsamples.length), ...subsamples.map(([c, p]) => Buffer.concat([u16(c), u32(p)]))])
          : iv
      );
      const senc = fullBox('senc', 0, video ? 2 : 0, u32(infos.length), ...entries);
      const saiz = video
        ? fullBox('saiz', 0, 0, Buffer.from([0]), u32(entries.length), Buffer.from(entries.map((e) => e.length)))
        : fullBox('saiz', 0, 0, Buffer.from([8]), u32(entries.length));
      const saio = fullBox('saio', 0, 0, u32(1), u32(0)); // patched below
      const body = Buffer.concat([data.subarray(traf.start + HEADER, traf.start + traf.size), saiz, saio, senc]);
      const t = Buffer.concat([u32(8 + body.length), Buffer.from('traf'), body]);
      sencOffsets.push({ t, saioAt: t.length - senc.length - saio.length, sencAt: t.length - senc.length });
      newTrafs.push(t);
    }
    const mfhd = children(data, top.start + HEADER, top.start + top.size).find((c) => c.type === 'mfhd');
    const others = children(data, top.start + HEADER, top.start + top.size).filter((c) => c.type !== 'traf' && c.type !== 'mfhd');
    const head = Buffer.concat([data.subarray(mfhd.start, mfhd.start + mfhd.size), ...others.map((o) => data.subarray(o.start, o.start + o.size))]);
    const moofSize = 8 + head.length + newTrafs.reduce((n, t) => n + t.length, 0);
    const growth = moofSize - top.size;
    let cursor = 8 + head.length;
    for (const { t, saioAt, sencAt } of sencOffsets) {
      // saio: the first entry's offset from the moof start (past senc's header and count).
      t.writeUInt32BE(cursor + sencAt + 16, saioAt + 16);
      // trun data offsets: the mdat moved by the growth.
      const kids = children(t, 8, t.length);
      for (const c of kids.filter((k) => k.type === 'trun')) {
        const f = t.readUInt32BE(c.start + 8) & 0xffffff;
        if (f & 0x1) t.writeInt32BE(t.readInt32BE(c.start + 16) + growth, c.start + 16);
      }
      cursor += t.length;
    }
    out.push(Buffer.concat([u32(moofSize), Buffer.from('moof'), head, ...newTrafs]));
    out.push(media);
    i += 1;
  }
  return Buffer.concat(out);
}

const init = readFileSync(initFile);
const kinds = trackKinds(init);
writeFileSync(initFile, encryptInit(init));
for (const file of segments) writeFileSync(file, encryptSegment(readFileSync(file), kinds));
console.log(`encrypted ${initFile} and ${segments.length} segment(s)`);
