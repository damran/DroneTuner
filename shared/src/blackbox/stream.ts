/**
 * Byte stream reader over a Uint8Array, ported from the Betaflight
 * blackbox-log-viewer `datastream.js` (GPL-3.0).
 */

export const EOF = -1;

export class ByteStream {
  data: Uint8Array;
  start: number;
  end: number;
  pos: number;
  eof: boolean;

  constructor(data: Uint8Array, start = 0, end = data.length) {
    this.data = data;
    this.start = start;
    this.end = end;
    this.pos = start;
    this.eof = false;
  }

  readByte(): number {
    if (this.pos < this.end) return this.data[this.pos++]!;
    this.eof = true;
    return EOF;
  }

  readChar(): string {
    if (this.pos < this.end) return String.fromCharCode(this.data[this.pos++]!);
    this.eof = true;
    return String.fromCharCode(EOF);
  }

  peekChar(): string {
    if (this.pos < this.end) return String.fromCharCode(this.data[this.pos]!);
    this.eof = true;
    return String.fromCharCode(EOF);
  }

  unreadChar(): void {
    this.pos--;
  }

  readUnsignedVB(): number {
    let result = 0;
    let shift = 0;
    for (let i = 0; i < 5; i++) {
      const b = this.readByte();
      if (b === EOF) return 0;
      result = result | ((b & 0x7f) << shift);
      if (b < 128) return result >>> 0;
      shift += 7;
    }
    return 0;
  }

  readSignedVB(): number {
    const unsigned = this.readUnsignedVB();
    return (unsigned >>> 1) ^ -(unsigned & 1);
  }

  readU16(): number {
    const b1 = this.readByte();
    const b2 = this.readByte();
    return b1 | (b2 << 8);
  }

  readS16(): number {
    return signExtend16Bit(this.readU16());
  }

  readU32(): number {
    const b1 = this.readByte();
    const b2 = this.readByte();
    const b3 = this.readByte();
    const b4 = this.readByte();
    return (b1 | (b2 << 8) | (b3 << 16) | (b4 << 24)) >>> 0;
  }

  readString(length: number): string {
    let out = "";
    for (let i = 0; i < length; i++) out += this.readChar();
    return out;
  }

  /** Offset of the first occurrence of `needle` at/after the current position, or -1. */
  nextOffsetOf(needle: string): number {
    const n = needle.length;
    for (let i = this.pos; i <= this.end - n; i++) {
      if (this.data[i] === needle.charCodeAt(0)) {
        let j = 1;
        for (; j < n && this.data[i + j] === needle.charCodeAt(j); j++);
        if (j === n) return i;
      }
    }
    return -1;
  }
}

export function signExtend2Bit(v: number): number {
  return v & 0x02 ? v - 4 : v;
}
export function signExtend4Bit(v: number): number {
  return v & 0x08 ? v - 16 : v;
}
export function signExtend5Bit(v: number): number {
  return v & 0x10 ? v - 32 : v;
}
export function signExtend6Bit(v: number): number {
  return v & 0x20 ? v - 64 : v;
}
export function signExtend7Bit(v: number): number {
  return v & 0x40 ? v - 128 : v;
}
export function signExtend8Bit(v: number): number {
  return v & 0x80 ? v - 256 : v;
}
export function signExtend14Bit(v: number): number {
  return v & 0x2000 ? v - 0x4000 : v;
}
export function signExtend16Bit(v: number): number {
  return v & 0x8000 ? v - 0x10000 : v;
}
export function signExtend24Bit(v: number): number {
  return v & 0x800000 ? v - 0x1000000 : v;
}

/** Parse a C99 hex float like "0x1.8p-4" or fall back to Number(). */
export function hexToFloat(s: string): number {
  const m = /^0x([0-9a-fA-F]+)(?:\.([0-9a-fA-F]*))?p([+-]?\d+)$/.exec(s.trim());
  if (!m) return Number(s);
  const intPart = parseInt(m[1] || "0", 16);
  const fracPart = m[2] ? parseInt(m[2] || "0", 16) : 0;
  const exp = parseInt(m[3]!, 10);
  const fracBits = m[2] ? m[2].length * 4 : 0;
  const value = intPart + fracPart / Math.pow(2, fracBits);
  return value * Math.pow(2, exp);
}

/**
 * Parse the blackbox `gyro_scale` header. BF logs it in one of three formats:
 * C99 hex float ("0x1.000000p+0"), plain decimal float, or the raw IEEE-754
 * bits as a hex/decimal integer ("0x3f800000" / "1065353216" for 1.0).
 */
export function parseGyroScale(s: string): number {
  const v = hexToFloat(s);
  // Sane gyro scales are small (deg/s per raw unit, typically 0.001–2).
  if (v > 0.0001 && v < 100) return v;
  const bits = s.trim().toLowerCase().startsWith("0x")
    ? Number.parseInt(s.trim(), 16)
    : Number.parseInt(s.trim(), 10);
  if (Number.isFinite(bits)) {
    const buf = new DataView(new ArrayBuffer(4));
    buf.setUint32(0, bits >>> 0, false);
    const f = buf.getFloat32(0, false);
    if (f > 0.0001 && f < 100) return f;
  }
  return v;
}

export function parseCommaSeparatedString(str: string): number[] {
  return str.split(",").map((part) => Number.parseInt(part.trim(), 10));
}
