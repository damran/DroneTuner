import { describe, expect, it } from "vitest";
import { decodeBoardInfo, decodeCraftName, decodeUid } from "../src/lib/msp/config";

function ascii(s: string): number[] {
  return [...s].map((c) => c.charCodeAt(0));
}

/** Build a BF 4.5 (API 1.46) MSP_BOARD_INFO payload. */
function boardInfoPayload(opts: { withExtended?: boolean } = {}): Uint8Array {
  const { withExtended = true } = opts;
  const bytes: number[] = [
    ...ascii("S411"), // board identifier
    0, 0, // hardware revision
    3, // fc type
    7, // comm capabilities
  ];
  const target = ascii("BETAFPVF411");
  bytes.push(target.length, ...target);
  if (withExtended) {
    const board = ascii("BETAFPVF411");
    const mfg = ascii("BEFH");
    bytes.push(board.length, ...board, mfg.length, ...mfg);
    bytes.push(...new Array(32).fill(0)); // signature
  }
  return new Uint8Array(bytes);
}

describe("msp identity decoders", () => {
  it("decodes board info with extended fields", () => {
    const info = decodeBoardInfo(boardInfoPayload());
    expect(info.boardId).toBe("S411");
    expect(info.targetName).toBe("BETAFPVF411");
    expect(info.boardName).toBe("BETAFPVF411");
    expect(info.manufacturerId).toBe("BEFH");
  });

  it("decodes short board info (target name only)", () => {
    const info = decodeBoardInfo(boardInfoPayload({ withExtended: false }));
    expect(info.boardId).toBe("S411");
    expect(info.targetName).toBe("BETAFPVF411");
    expect(info.boardName).toBeNull();
    expect(info.manufacturerId).toBeNull();
  });

  it("tolerates a minimal 4-byte board info", () => {
    const info = decodeBoardInfo(new Uint8Array(ascii("S411")));
    expect(info.boardId).toBe("S411");
    expect(info.targetName).toBeNull();
  });

  it("decodes craft name and stops at NUL", () => {
    expect(decodeCraftName(new Uint8Array([...ascii("Meteor65"), 0, 0]))).toBe("Meteor65");
    expect(decodeCraftName(new Uint8Array([]))).toBe("");
  });

  it("decodes the 96-bit uid as hex", () => {
    const uid = decodeUid(new Uint8Array([0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb]));
    expect(uid).toBe("00112233445566778899aabb");
  });
});
