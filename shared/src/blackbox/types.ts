export interface FieldDef {
  name: string[];
  count: number;
  nameToIndex: Record<string, number>;
  signed: number[];
  predictor: number[];
  encoding: number[];
}

export interface ParsedLog {
  /** raw header name → value (all "H name:value" lines) */
  headers: Record<string, string>;
  frameCount: number;
  /** frame timestamps in µs */
  timeUs: Float32Array;
  /** field name (e.g. "gyroADC[0]") → samples */
  channels: Record<string, Float32Array>;
  looptimeUs: number | null;
  /** deg/s per raw gyro unit */
  gyroScale: number | null;
  firmware: string | null;
  /** true when parsing stopped at the maxFrames cap with data remaining */
  truncated: boolean;
  warnings: string[];
}

export class BlackboxParseError extends Error {
  offset: number;
  constructor(message: string, offset: number) {
    super(message);
    this.name = "BlackboxParseError";
    this.offset = offset;
  }
}

export interface ParseOptions {
  /** stop after this many main frames (default 1_000_000) */
  maxFrames?: number;
}
