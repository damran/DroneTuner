/**
 * MSP v2 framing + CRC (DVB-S2), used by the client WebSerial layer only.
 */

export function crc8DvbS2(data: Uint8Array, start = 0, length = data.length - start): number {
  let crc = 0;
  for (let i = start; i < start + length; i++) {
    crc ^= data[i]!;
    for (let j = 0; j < 8; j++) {
      crc = crc & 0x80 ? ((crc << 1) ^ 0xd5) & 0xff : (crc << 1) & 0xff;
    }
  }
  return crc;
}

/** Build an MSP v2 request frame: $X < flag cmd(2) len(2) payload crc */
export function buildMspV2Request(command: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  const buf = new Uint8Array(9 + payload.length);
  buf[0] = 0x24; // '$'
  buf[1] = 0x58; // 'X'
  buf[2] = 0x3c; // '<'
  buf[3] = 0; // flag
  buf[4] = command & 0xff;
  buf[5] = (command >> 8) & 0xff;
  buf[6] = payload.length & 0xff;
  buf[7] = (payload.length >> 8) & 0xff;
  buf.set(payload, 8);
  buf[8 + payload.length] = crc8DvbS2(buf, 3, 5 + payload.length);
  return buf;
}

export interface MspResponse {
  command: number;
  payload: Uint8Array;
  /** true when the FC answered with an MSP error frame ($X ! ...) */
  error: boolean;
}

/**
 * Incremental parser for MSP v2 responses arriving as a byte stream.
 * Push bytes in, call tryParse() to extract complete frames.
 */
export class ResponseParser {
  private buf: number[] = [];

  push(bytes: Uint8Array): void {
    for (const b of bytes) this.buf.push(b);
  }

  tryParse(): MspResponse | null {
    const arr = new Uint8Array(this.buf);
    for (let i = 0; i + 9 <= arr.length; i++) {
      if (arr[i] === 0x24 && arr[i + 1] === 0x58 && (arr[i + 2] === 0x3e || arr[i + 2] === 0x21)) {
        const command = arr[i + 4]! | (arr[i + 5]! << 8);
        const len = arr[i + 6]! | (arr[i + 7]! << 8);
        if (i + 9 + len > arr.length) {
          // incomplete frame — drop any garbage before the header
          if (i > 0) this.buf.splice(0, i);
          return null;
        }
        const crc = arr[i + 8 + len]!;
        const expected = crc8DvbS2(arr, i + 3, 5 + len);
        if (crc !== expected) {
          this.buf.splice(0, i + 1); // drop the corrupt leading byte
          return null;
        }
        const payload = arr.slice(i + 8, i + 8 + len);
        this.buf.splice(0, i + 9 + len);
        return { command, payload, error: arr[i + 2] === 0x21 };
      }
    }
    // No complete frame found — drop bytes that can't start a frame,
    // keeping everything from the last '$' (could be a split header).
    const lastDollar = this.buf.lastIndexOf(0x24);
    if (lastDollar > 0) this.buf.splice(0, lastDollar);
    else if (lastDollar === -1) this.buf = [];
    return null;
  }

  clear(): void {
    this.buf = [];
  }
}

export function toHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

export function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
