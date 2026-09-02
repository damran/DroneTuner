export interface FieldDef {
  name: string[];
  count: number;
  nameToIndex: Record<string, number>;
  signed: number[];
  predictor: number[];
  encoding: number[];
}

/** Byte range of one flight session inside a (possibly multi-session) blackbox file. */
export interface BlackboxSessionRange {
  /** 0-based session index in file order */
  index: number;
  /** byte offset of the session's "H Product:" marker */
  start: number;
  /** byte offset where the next session starts (or the file ends) */
  end: number;
}

export interface ParsedLog {
  /** raw header name → value (all "H name:value" lines) */
  headers: Record<string, string>;
  /** which session of the file this is (0-based) */
  sessionIndex: number;
  /** how many sessions the file contains (a flash download holds one per arm) */
  sessionCount: number;
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
  /**
   * Which flight session to parse when the file holds several (a blackbox
   * flash download contains one session per arm, each starting with its own
   * "H Product:" header). Defaults to the first session.
   */
  sessionIndex?: number;
}
