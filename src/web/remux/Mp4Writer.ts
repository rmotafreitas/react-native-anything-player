/* eslint-disable no-bitwise -- MP4 boxes are bit fields and big-endian integers. */
// Fragmented MP4 for remuxed tracks: one init segment (ftyp + moov) for the
// tracks chosen, then a moof + mdat per fragment. The Swift twin
// (ios/Core/Remux/Mp4Writer.swift) writes the same bytes: both are compared
// with conformance/remux/*.out/.

import { BoxWriter } from './bytes';
import type { RemuxSample, RemuxTrack } from './types';

const IDENTITY_MATRIX = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];
/** tfhd: the base data offset is the start of the moof. */
const DEFAULT_BASE_IS_MOOF = 0x020000;
/** trun: data offset, then a duration and a size per sample. */
const TRUN_AUDIO = 0x000301;
/** trun: data offset, then a duration, size, flags and composition offset per sample. */
const TRUN_VIDEO = 0x000f01;
/** A sync sample: depends on no other. */
const SYNC_FLAGS = 0x02000000;
/** Depends on others, not a sync sample. */
const NON_SYNC_FLAGS = 0x01010000;
/** `und`, packed as mdhd's three 5-bit letters. */
const LANGUAGE_UND = 0x55c4;

/** mdhd's packed ISO 639-2 code (`und` for anything else). */
export function packedLanguage(language: string | null): number {
  if (!language || !/^[a-z]{3}$/.test(language)) return LANGUAGE_UND;
  let packed = 0;
  for (let i = 0; i < 3; i++)
    packed = (packed << 5) | (language.charCodeAt(i) - 0x60);
  return packed;
}

function matrix(w: BoxWriter): void {
  for (const value of IDENTITY_MATRIX) w.u32(value);
}

/** The displayed width: the coded one stretched by the sample aspect ratio. */
export function displayWidth(track: RemuxTrack): number {
  return Math.floor((track.width * track.sarWidth) / track.sarHeight);
}

function visualEntry(w: BoxWriter, track: RemuxTrack): void {
  const entry = track.entry!;
  w.begin(entry);
  w.zeros(6).u16(1); // reserved, data reference index
  w.u16(0).u16(0).zeros(12); // pre-defined, reserved
  w.u16(track.width).u16(track.height);
  w.u32(0x00480000).u32(0x00480000); // 72 dpi
  w.u32(0).u16(1); // reserved, frame count
  w.zeros(32); // compressor name
  w.u16(0x0018).u16(0xffff); // depth, pre-defined
  const config = track.config ?? new Uint8Array(0);
  if (entry === 'avc1') w.begin('avcC').raw(config).end();
  else if (entry === 'hvc1') w.begin('hvcC').raw(config).end();
  else if (entry === 'av01') w.begin('av1C').raw(config).end();
  else w.begin('vpcC', 1).raw(config).end();
  if (track.sarWidth !== track.sarHeight)
    w.begin('pasp').u32(track.sarWidth).u32(track.sarHeight).end();
  w.end();
}

function esds(w: BoxWriter, track: RemuxTrack): void {
  const specific =
    track.config && track.config.length > 0 ? track.config : null;
  const decoderConfig = 13 + (specific ? 2 + specific.length : 0);
  w.begin('esds', 0);
  // Every length here is below 128: one byte each.
  w.u8(0x03).u8(3 + 2 + decoderConfig + 3);
  w.u16(0).u8(0); // ES_ID, no flags
  w.u8(0x04).u8(decoderConfig);
  w.u8(track.objectType).u8(0x15); // audio stream
  w.zeros(3).u32(0).u32(0); // buffer size, max and average bitrate: unknown
  if (specific) w.u8(0x05).u8(specific.length).raw(specific);
  w.u8(0x06).u8(1).u8(0x02); // SLConfigDescriptor: MP4 file
  w.end();
}

function audioEntry(w: BoxWriter, track: RemuxTrack): void {
  const entry = track.entry!;
  w.begin(entry);
  w.zeros(6).u16(1); // reserved, data reference index
  w.zeros(8); // version, revision, vendor
  w.u16(track.channels).u16(16).u16(0).u16(0);
  // 16.16 fixed point: rates above 65535 Hz are only in the configuration.
  w.u32(track.sampleRate > 0xffff ? 0 : track.sampleRate * 65536);
  const config = track.config ?? new Uint8Array(0);
  if (entry === 'mp4a') esds(w, track);
  else if (entry === 'Opus') w.begin('dOps').raw(config).end();
  else if (entry === 'fLaC') w.begin('dfLa', 0).raw(config).end();
  else if (entry === 'ac-3') w.begin('dac3').raw(config).end();
  else w.begin('dec3').raw(config).end();
  w.end();
}

function emptyTable(w: BoxWriter, type: string, extra = 0): void {
  w.begin(type, 0).zeros(extra).u32(0).end();
}

function trak(w: BoxWriter, track: RemuxTrack, id: number): void {
  const video = track.kind === 'video';
  w.begin('trak');
  w.begin('tkhd', 0, 3).u32(0).u32(0).u32(id).u32(0).u32(0); // enabled, in movie
  w.zeros(8)
    .u16(0)
    .u16(0)
    .u16(video ? 0 : 0x0100)
    .u16(0);
  matrix(w);
  w.u32(video ? displayWidth(track) * 65536 : 0);
  w.u32(video ? track.height * 65536 : 0);
  w.end();
  w.begin('mdia');
  w.begin('mdhd', 0).u32(0).u32(0).u32(track.timescale).u32(0);
  w.u16(packedLanguage(track.language)).u16(0).end();
  w.begin('hdlr', 0)
    .u32(0)
    .ascii(video ? 'vide' : 'soun')
    .zeros(12);
  w.ascii(video ? 'VideoHandler' : 'SoundHandler')
    .u8(0)
    .end();
  w.begin('minf');
  if (video) w.begin('vmhd', 0, 1).zeros(8).end();
  else w.begin('smhd', 0).u32(0).end();
  w.begin('dinf').begin('dref', 0).u32(1);
  w.begin('url ', 0, 1).end();
  w.end().end();
  w.begin('stbl');
  w.begin('stsd', 0).u32(1);
  if (video) visualEntry(w, track);
  else audioEntry(w, track);
  w.end();
  emptyTable(w, 'stts');
  emptyTable(w, 'stsc');
  emptyTable(w, 'stsz', 4);
  emptyTable(w, 'stco');
  w.end(); // stbl
  w.end(); // minf
  w.end(); // mdia
  w.end(); // trak
}

/** `ftyp` + `moov` for these tracks (MP4 track ids 1, 2, … in this order). */
export function initSegment(tracks: readonly RemuxTrack[]): Uint8Array {
  const w = new BoxWriter(1024);
  w.begin('ftyp')
    .ascii('iso5')
    .u32(1)
    .ascii('iso5')
    .ascii('iso6')
    .ascii('mp41')
    .end();
  w.begin('moov');
  w.begin('mvhd', 0).u32(0).u32(0).u32(1000).u32(0);
  w.u32(0x00010000).u16(0x0100).zeros(10); // rate, volume, reserved
  matrix(w);
  w.zeros(24).u32(tracks.length + 1); // pre-defined, next track id
  w.end();
  tracks.forEach((track, i) => trak(w, track, i + 1));
  w.begin('mvex');
  tracks.forEach((_, i) => {
    w.begin('trex', 0)
      .u32(i + 1)
      .u32(1)
      .u32(0)
      .u32(0)
      .u32(0)
      .end();
  });
  w.end(); // mvex
  w.end(); // moov
  return w.finish();
}

/** A track's `traf`, its data at `offset` in the fragment; the offset after its data. */
function traf(
  w: BoxWriter,
  track: RemuxTrack,
  id: number,
  samples: readonly RemuxSample[],
  offset: number
): number {
  const video = track.kind === 'video';
  w.begin('traf');
  w.begin('tfhd', 0, DEFAULT_BASE_IS_MOOF).u32(id).end();
  w.begin('tfdt', 1).u64(samples[0]!.dts).end();
  const signed = video && samples.some((s) => s.pts < s.dts);
  w.begin('trun', signed ? 1 : 0, video ? TRUN_VIDEO : TRUN_AUDIO);
  w.u32(samples.length).u32(offset);
  let end = offset;
  for (const s of samples) {
    w.u32(s.duration).u32(s.data.length);
    if (video) {
      w.u32(s.key ? SYNC_FLAGS : NON_SYNC_FLAGS);
      // Version 1: signed offsets (a B-frame shown before its decode time).
      w.i32(s.pts - s.dts);
    }
    end += s.data.length;
  }
  w.end(); // trun
  w.end(); // traf
  return end;
}

/**
 * `moof` + `mdat` with each track's samples (in the init segment's order;
 * an empty list leaves the track out of this fragment).
 */
export function fragment(
  sequence: number,
  tracks: readonly RemuxTrack[],
  samples: ReadonlyArray<readonly RemuxSample[]>
): Uint8Array {
  const parts = tracks
    .map((track, i) => ({ track, id: i + 1, samples: samples[i] ?? [] }))
    .filter((p) => p.samples.length > 0);
  let moofSize = 8 + 16;
  let payload = 0;
  for (const p of parts) {
    const perSample = p.track.kind === 'video' ? 16 : 8;
    moofSize += 64 + p.samples.length * perSample;
    for (const s of p.samples) payload += s.data.length;
  }
  const w = new BoxWriter(moofSize + 8 + payload);
  w.begin('moof');
  w.begin('mfhd', 0).u32(sequence).end();
  let offset = moofSize + 8;
  for (const p of parts) offset = traf(w, p.track, p.id, p.samples, offset);
  w.end(); // moof
  w.begin('mdat');
  for (const p of parts) for (const s of p.samples) w.raw(s.data);
  w.end();
  return w.finish();
}
