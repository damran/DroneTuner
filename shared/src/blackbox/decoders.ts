/**
 * Blackbox field decoders, ported from the Betaflight blackbox-log-viewer
 * `decoders.js` (GPL-3.0). All read from a ByteStream.
 */

import {
  ByteStream,
  signExtend2Bit,
  signExtend4Bit,
  signExtend5Bit,
  signExtend6Bit,
  signExtend7Bit,
  signExtend8Bit,
  signExtend16Bit,
  signExtend24Bit,
} from "./stream";

/** 2-bit tag + 3 signed 32-bit fields (2/4/6/32-bit packing). */
export function readTag2_3S32(stream: ByteStream): number[] {
  const values = [0, 0, 0];
  let leadByte = stream.readByte();

  switch (leadByte >> 6) {
    case 0: {
      values[0] = signExtend2Bit((leadByte >> 4) & 0x03);
      values[1] = signExtend2Bit((leadByte >> 2) & 0x03);
      values[2] = signExtend2Bit(leadByte & 0x03);
      break;
    }
    case 1: {
      values[0] = signExtend4Bit(leadByte & 0x0f);
      leadByte = stream.readByte();
      values[1] = signExtend4Bit(leadByte >> 4);
      values[2] = signExtend4Bit(leadByte & 0x0f);
      break;
    }
    case 2: {
      values[0] = signExtend6Bit(leadByte & 0x3f);
      leadByte = stream.readByte();
      values[1] = signExtend6Bit(leadByte & 0x3f);
      leadByte = stream.readByte();
      values[2] = signExtend6Bit(leadByte & 0x3f);
      break;
    }
    case 3: {
      for (let i = 0; i < 3; i++) {
        switch (leadByte & 0x03) {
          case 0:
            values[i] = signExtend8Bit(stream.readByte());
            break;
          case 1:
            values[i] = signExtend16Bit(stream.readU16());
            break;
          case 2: {
            const b1 = stream.readByte();
            const b2 = stream.readByte();
            const b3 = stream.readByte();
            values[i] = signExtend24Bit(b1 | (b2 << 8) | (b3 << 16));
            break;
          }
          case 3:
            values[i] = stream.readU32() | 0;
            break;
        }
        leadByte >>= 2;
      }
      break;
    }
  }
  return values;
}

/** 2-bit tag + 3 signed fields (2/554/877/32-bit packing), newer firmware. */
export function readTag2_3SVariable(stream: ByteStream): number[] {
  const values = [0, 0, 0];
  const leadByte = stream.readByte();

  switch (leadByte >> 6) {
    case 0: {
      values[0] = signExtend2Bit((leadByte >> 4) & 0x03);
      values[1] = signExtend2Bit((leadByte >> 2) & 0x03);
      values[2] = signExtend2Bit(leadByte & 0x03);
      break;
    }
    case 1: {
      values[0] = signExtend5Bit((leadByte & 0x3e) >> 1);
      const b2 = stream.readByte();
      values[1] = signExtend5Bit(((leadByte & 0x01) << 5) | ((b2 & 0x0f) >> 4));
      values[2] = signExtend4Bit(b2 & 0x0f);
      break;
    }
    case 2: {
      const b2 = stream.readByte();
      values[0] = signExtend8Bit(((leadByte & 0x3f) << 2) | ((b2 & 0xc0) >> 6));
      const b3 = stream.readByte();
      values[1] = signExtend7Bit(((b2 & 0x3f) << 1) | ((b2 & 0x80) >> 7));
      values[2] = signExtend7Bit(b3 & 0x7f);
      break;
    }
    case 3: {
      let lb = leadByte;
      for (let i = 0; i < 3; i++) {
        switch (lb & 0x03) {
          case 0:
            values[i] = signExtend8Bit(stream.readByte());
            break;
          case 1:
            values[i] = signExtend16Bit(stream.readU16());
            break;
          case 2: {
            const b1 = stream.readByte();
            const b2 = stream.readByte();
            const b3 = stream.readByte();
            values[i] = signExtend24Bit(b1 | (b2 << 8) | (b3 << 16));
            break;
          }
          case 3:
            values[i] = stream.readU32() | 0;
            break;
        }
        lb >>= 2;
      }
      break;
    }
  }
  return values;
}

/** Legacy tag8_4s16 (v1, "Data version" < 2): 4-bit fields are packed two per byte. */
export function readTag8_4S16_v1(stream: ByteStream): number[] {
  const values = [0, 0, 0, 0];
  let selector = stream.readByte();

  for (let i = 0; i < 4; i++) {
    switch (selector & 0x03) {
      case 0:
        values[i] = 0;
        break;
      case 1: {
        const combined = stream.readByte();
        values[i] = signExtend4Bit(combined & 0x0f);
        i++;
        selector >>= 2;
        values[i] = signExtend4Bit(combined >> 4);
        break;
      }
      case 2:
        values[i] = signExtend8Bit(stream.readByte());
        break;
      case 3:
        values[i] = signExtend16Bit(stream.readU16());
        break;
    }
    selector >>= 2;
  }
  return values;
}

/** Modern tag8_4s16 (v2, "Data version" >= 2): nibble-packed. */
export function readTag8_4S16_v2(stream: ByteStream): number[] {
  const values = [0, 0, 0, 0];
  let selector = stream.readByte();
  let buffer = 0;
  let nibbleIndex = 0;

  for (let i = 0; i < 4; i++) {
    switch (selector & 0x03) {
      case 0:
        values[i] = 0;
        break;
      case 1:
        if (nibbleIndex === 0) {
          buffer = stream.readByte();
          values[i] = signExtend4Bit(buffer >> 4);
          nibbleIndex = 1;
        } else {
          values[i] = signExtend4Bit(buffer & 0x0f);
          nibbleIndex = 0;
        }
        break;
      case 2:
        if (nibbleIndex === 0) {
          values[i] = signExtend8Bit(stream.readByte());
        } else {
          let char1 = (buffer & 0x0f) << 4;
          buffer = stream.readByte();
          char1 |= buffer >> 4;
          values[i] = signExtend8Bit(char1);
        }
        break;
      case 3:
        if (nibbleIndex === 0) {
          const char1 = stream.readByte();
          const char2 = stream.readByte();
          values[i] = signExtend16Bit((char1 << 8) | char2);
        } else {
          const char1 = stream.readByte();
          const char2 = stream.readByte();
          values[i] = signExtend16Bit(((buffer & 0x0f) << 12) | (char1 << 4) | (char2 >> 4));
          buffer = char2;
        }
        break;
    }
    selector >>= 2;
  }
  return values;
}

/** 1-byte bitmap + signed VB for the non-zero fields. */
export function readTag8_8SVB(stream: ByteStream, valueCount: number): number[] {
  const values = new Array<number>(Math.max(8, valueCount)).fill(0);
  if (valueCount === 1) {
    values[0] = stream.readSignedVB();
  } else {
    let header = stream.readByte();
    for (let i = 0; i < 8; i++, header >>= 1) {
      values[i] = header & 0x01 ? stream.readSignedVB() : 0;
    }
  }
  return values;
}
