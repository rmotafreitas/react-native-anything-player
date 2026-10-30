/* eslint-disable no-bitwise -- bit fields and big-endian integers. */
// Byte and bit helpers of the remuxer (the Swift twin: ios/Core/Remux/Bytes.swift).

/** Reads big-endian bit fields, and Exp-Golomb codes (H.264, HEVC). */
export class BitReader {
  private pos = 0;

  constructor(private readonly data: Uint8Array) {}

  /** Bits left. */
  get left(): number {
    return this.data.length * 8 - this.pos;
  }

  /** The next `count` bits (at most 32) as an unsigned number; zeros past the end. */
  bits(count: number): number {
    let value = 0;
    for (let i = 0; i < count; i++) {
      const byte = this.data[this.pos >> 3] ?? 0;
      value = value * 2 + ((byte >> (7 - (this.pos & 7))) & 1);
      this.pos += 1;
    }
    return value;
  }

  bit(): boolean {
    return this.bits(1) === 1;
  }

  skip(count: number): void {
    this.pos += count;
  }

  /** ue(v). */
  ue(): number {
    let zeros = 0;
    while (this.left > 0 && !this.bit()) zeros += 1;
    if (zeros > 31) return 0;
    return 2 ** zeros - 1 + this.bits(zeros);
  }

  /** se(v). */
  se(): number {
    const value = this.ue();
    return value % 2 === 1 ? (value + 1) / 2 : -value / 2;
  }
}

/** A NAL unit's payload without its emulation prevention bytes (`00 00 03`). */
export function unescapeRbsp(nal: Uint8Array): Uint8Array {
  const out = new Uint8Array(nal.length);
  let n = 0;
  let zeros = 0;
  for (const byte of nal) {
    if (zeros >= 2 && byte === 3) {
      zeros = 0;
      continue;
    }
    out[n] = byte;
    n += 1;
    zeros = byte === 0 ? zeros + 1 : 0;
  }
  return out.subarray(0, n);
}

/** The parts, joined. */
export function concat(parts: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

export function equalBytes(a: Uint8Array | null, b: Uint8Array | null) {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function hex2(value: number): string {
  return value.toString(16).toUpperCase().padStart(2, '0');
}

export function pad2(value: number): string {
  return `${value}`.padStart(2, '0');
}

/** Big-endian unsigned integer of `length` bytes at `at`. */
export function readUint(data: Uint8Array, at: number, length: number) {
  let value = 0;
  for (let i = 0; i < length; i++) value = value * 256 + (data[at + i] ?? 0);
  return value;
}

/** `value × num / den`, rounded half up, in integers (`value` ≥ 0). */
export function rescale(value: number, num: number, den: number): number {
  if (num === den) return value;
  return Math.floor((2 * value * num + den) / (2 * den));
}

const TWO_POW_32 = 4_294_967_296;

/** Writes MP4 boxes into one growing buffer; `end` patches the size of the box `begin` opened. */
export class BoxWriter {
  private bytes: Uint8Array;
  private view: DataView;
  private pos = 0;
  private readonly open: number[] = [];

  constructor(capacity = 512) {
    this.bytes = new Uint8Array(capacity);
    this.view = new DataView(this.bytes.buffer);
  }

  /** Opens a box (a full box when `version` is given). */
  begin(type: string, version?: number, flags = 0): this {
    this.open.push(this.pos);
    this.u32(0).ascii(type);
    if (version !== undefined) this.u32(((version << 24) | flags) >>> 0);
    return this;
  }

  end(): this {
    const start = this.open.pop()!;
    this.view.setUint32(start, this.pos - start);
    return this;
  }

  u8(value: number): this {
    this.reserve(1);
    this.view.setUint8(this.pos, value & 0xff);
    this.pos += 1;
    return this;
  }

  u16(value: number): this {
    this.reserve(2);
    this.view.setUint16(this.pos, value & 0xffff);
    this.pos += 2;
    return this;
  }

  u24(value: number): this {
    return this.u8(value >>> 16).u16(value & 0xffff);
  }

  u32(value: number): this {
    this.reserve(4);
    this.view.setUint32(this.pos, value >>> 0);
    this.pos += 4;
    return this;
  }

  /** A signed 32-bit integer. */
  i32(value: number): this {
    this.reserve(4);
    this.view.setInt32(this.pos, value);
    this.pos += 4;
    return this;
  }

  u64(value: number): this {
    return this.u32(Math.floor(value / TWO_POW_32)).u32(value % TWO_POW_32);
  }

  zeros(count: number): this {
    this.reserve(count);
    this.pos += count;
    return this;
  }

  ascii(text: string): this {
    for (let i = 0; i < text.length; i++) this.u8(text.codePointAt(i)!);
    return this;
  }

  raw(data: Uint8Array): this {
    this.reserve(data.length);
    this.bytes.set(data, this.pos);
    this.pos += data.length;
    return this;
  }

  finish(): Uint8Array {
    return this.bytes.slice(0, this.pos);
  }

  private reserve(count: number): void {
    const needed = this.pos + count;
    if (needed <= this.bytes.length) return;
    const grown = new Uint8Array(Math.max(needed, this.bytes.length * 2));
    grown.set(this.bytes);
    this.bytes = grown;
    this.view = new DataView(grown.buffer);
  }
}
