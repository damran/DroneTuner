/**
 * Blackbox (.bbl/.bfl) parser, ported from the Betaflight blackbox-log-viewer
 * `flightlog_parser.js` (GPL-3.0). Supports Betaflight 4.x logs: header
 * parsing, I/P/S/E/G/H frames, all standard field encodings and predictors.
 */

import { ByteStream, EOF, parseCommaSeparatedString, parseGyroScale } from "./stream";
import {
  readTag2_3S32,
  readTag2_3SVariable,
  readTag8_4S16_v1,
  readTag8_4S16_v2,
  readTag8_8SVB,
} from "./decoders";
import { signExtend14Bit } from "./stream";
import { BlackboxParseError, BlackboxSessionRange, FieldDef, ParsedLog, ParseOptions } from "./types";

// Predictors
const P_0 = 0;
const P_PREVIOUS = 1;
const P_STRAIGHT_LINE = 2;
const P_AVERAGE_2 = 3;
const P_MINTHROTTLE = 4;
const P_MOTOR_0 = 5;
const P_INC = 6;
const P_HOME_COORD = 7;
const P_1500 = 8;
const P_VBATREF = 9;
const P_LAST_MAIN_FRAME_TIME = 10;
const P_MINMOTOR = 11;
const P_HOME_COORD_1 = 256;

// Encodings
const E_SIGNED_VB = 0;
const E_UNSIGNED_VB = 1;
const E_NEG_14BIT = 3;
const E_TAG8_8SVB = 6;
const E_TAG2_3S32 = 7;
const E_TAG8_4S16 = 8;
const E_NULL = 9;
const E_TAG2_3SVARIABLE = 10;

// Events
const EV_SYNC_BEEP = 0;
const EV_AUTOTUNE_CYCLE_START = 10;
const EV_AUTOTUNE_CYCLE_RESULT = 11;
const EV_AUTOTUNE_TARGETS = 12;
const EV_INFLIGHT_ADJUSTMENT = 13;
const EV_LOGGING_RESUME = 14;
const EV_DISARM = 15;
const EV_GTUNE_CYCLE_RESULT = 20;
const EV_FLIGHT_MODE = 30;
const EV_TWITCH_TEST = 40;
const EV_LOG_END = 255;

const END_OF_LOG_MESSAGE = "End of log\0";
const SESSION_MARKER = "H Product:";

/**
 * Locate every flight session in a blackbox file. Betaflight writes a fresh
 * header block (starting with "H Product:") on every arm, so a file
 * downloaded from flash holds one session per flight, back to back. Each
 * range runs from its marker to the next marker (or the end of the file).
 */
export function listBlackboxSessions(data: Uint8Array): BlackboxSessionRange[] {
  const stream = new ByteStream(data);
  const starts: number[] = [];
  let pos = 0;
  for (;;) {
    stream.pos = pos;
    const off = stream.nextOffsetOf(SESSION_MARKER);
    if (off === -1) break;
    starts.push(off);
    pos = off + SESSION_MARKER.length;
  }
  return starts.map((start, i) => ({
    index: i,
    start,
    end: i + 1 < starts.length ? starts[i + 1]! : data.length,
  }));
}

class GrowableF32 {
  private arr = new Float32Array(4096);
  private len = 0;

  push(v: number): void {
    if (this.len === this.arr.length) {
      const next = new Float32Array(this.arr.length * 2);
      next.set(this.arr);
      this.arr = next;
    }
    this.arr[this.len++] = v;
  }

  toArray(): Float32Array {
    return this.arr.slice(0, this.len);
  }
}

export class BlackboxParser {
  private stream: ByteStream;
  private opts: ParseOptions;
  private headers: Record<string, string> = {};
  private frameDefs: Record<string, FieldDef> = {};
  private dataVersion = 2;

  private minthrottle = 1150;
  private motorOutputMin = 1150;
  private vbatref = 4095;
  private gyroScale: number | null = null;
  private looptimeUs: number | null = null;
  private firmware: string | null = null;

  private mainHistory: (number[] | null)[] = [null, null, null];
  private gpsHomeHistory: (number[] | null)[] = [null, null];
  private lastSlow: number[] | null = null;
  private lastGPS: number[] | null = null;

  private lastMainFrameIteration = -1;
  private lastMainFrameTime = -1;
  private lastSkippedFrames = 0;

  private channels: Record<string, GrowableF32> = {};
  private timeUs = new GrowableF32();
  private frameCount = 0;
  private warnings: string[] = [];
  private warnedMessages = new Set<string>();
  private truncated = false;

  private sessionIndex = 0;
  private sessionCount = 0;

  constructor(data: Uint8Array, opts: ParseOptions = {}) {
    this.stream = new ByteStream(data);
    this.opts = opts;
  }

  /**
   * Confine the stream to the requested session (default: the first). A
   * session's data ends where the next session's header begins, so frames
   * from a later flight can never bleed into this one.
   */
  private selectSession(): void {
    const sessions = listBlackboxSessions(this.stream.data);
    if (sessions.length === 0) {
      throw new BlackboxParseError("Not a blackbox log (missing 'H Product:' header)", 0);
    }
    const index = this.opts.sessionIndex ?? 0;
    const session = sessions[index];
    if (!session) {
      throw new BlackboxParseError(
        `Session ${index + 1} requested but the file only holds ${sessions.length}`,
        0,
      );
    }
    this.sessionIndex = index;
    this.sessionCount = sessions.length;
    this.stream = new ByteStream(this.stream.data, session.start, session.end);
  }

  parse(): ParsedLog {
    this.selectSession();

    this.parseHeader();
    this.extractSysConfig();

    const idef = this.frameDefs.I;
    if (!idef || idef.count === 0) {
      throw new BlackboxParseError("Log is missing required I-frame field definitions", this.stream.pos);
    }
    const pdef = this.frameDefs.P;
    if (!pdef) {
      throw new BlackboxParseError("Log is missing required P-frame field definitions", this.stream.pos);
    }
    // P frames share the I frame's field names (loopIteration is NULL-encoded in P)
    pdef.count = idef.count;
    pdef.name = idef.name;
    pdef.nameToIndex = idef.nameToIndex;
    pdef.signed = idef.signed;

    this.parseLogData();

    const channels: Record<string, Float32Array> = {};
    for (const [name, arr] of Object.entries(this.channels)) {
      channels[name] = arr.toArray();
    }

    // A multi-session file parsed without an explicit session choice is
    // almost always a mistake (the first session is often a 2 s arm/disarm
    // blip), so say so loudly.
    if (this.sessionCount > 1 && this.opts.sessionIndex === undefined) {
      this.warnings.push(
        `Log contains ${this.sessionCount} flight sessions; only the first was parsed. Pass sessionIndex to pick another.`,
      );
    }

    return {
      headers: this.headers,
      sessionIndex: this.sessionIndex,
      sessionCount: this.sessionCount,
      frameCount: this.frameCount,
      timeUs: this.timeUs.toArray(),
      channels,
      looptimeUs: this.looptimeUs,
      gyroScale: this.gyroScale,
      firmware: this.firmware,
      truncated: this.truncated,
      warnings: this.warnings,
    };
  }

  /**
   * Non-fatal parse caveats. Deduped by `key` (a systematically unsupported
   * encoding throws on every frame) and capped so a corrupt log can't grow
   * the array without bound.
   */
  private warn(key: string, message: string): void {
    if (this.warnedMessages.has(key)) return;
    this.warnedMessages.add(key);
    if (this.warnings.length < 20) {
      this.warnings.push(message);
    } else if (this.warnings.length === 20) {
      this.warnings.push("Further parser warnings suppressed.");
    }
  }

  private parseHeader(): void {
    while (true) {
      const c = this.stream.readChar();
      if (c === String.fromCharCode(EOF)) break;
      if (c === "H") {
        if (this.stream.peekChar() === " ") {
          this.stream.readChar(); // skip space
          this.parseHeaderLine();
        } else {
          this.stream.unreadChar();
          break;
        }
      } else {
        this.stream.unreadChar();
        break;
      }
    }
  }

  private parseHeaderLine(): void {
    const lineStart = this.stream.pos;
    let separatorPos = -1;
    let lineEnd = -1;
    for (let p = lineStart; p < lineStart + 2048 && p < this.stream.end; p++) {
      const b = this.stream.data[p]!;
      if (separatorPos === -1 && b === 0x3a /* ':' */) separatorPos = p;
      if (b === 0x0a /* '\n' */ || b === 0) {
        lineEnd = p;
        break;
      }
    }
    if (lineEnd === -1 || separatorPos === -1) {
      this.stream.pos = this.stream.end;
      return;
    }
    this.stream.pos = lineEnd + 1;

    const name = this.ascii(lineStart, separatorPos);
    const value = this.ascii(separatorPos + 1, lineEnd);

    if (name === "Data version") {
      this.dataVersion = Number.parseInt(value, 10) || 2;
    }

    if (!this.parseFieldDefinition(name, value)) {
      this.headers[name] = value;
    }
  }

  private ascii(start: number, end: number): string {
    let out = "";
    for (let i = start; i < end; i++) out += String.fromCharCode(this.stream.data[i]!);
    return out;
  }

  private parseFieldDefinition(name: string, value: string): boolean {
    const m = /^Field (.) (.+)$/.exec(name);
    if (!m) return false;

    const frameName = m[1]!;
    const frameInfo = m[2]!;
    if (!this.frameDefs[frameName]) {
      this.frameDefs[frameName] = {
        name: [],
        count: 0,
        nameToIndex: {},
        signed: [],
        predictor: [],
        encoding: [],
      };
    }
    const def = this.frameDefs[frameName]!;

    if (frameInfo === "name") {
      def.name = this.translateLegacyFieldNames(value.split(","));
      def.count = def.name.length;
      def.nameToIndex = {};
      def.name.forEach((n, i) => {
        def.nameToIndex[n] = i;
      });
      if (def.signed.length === 0) def.signed.length = def.count;
    } else if (frameInfo === "predictor") {
      def.predictor = parseCommaSeparatedString(value);
    } else if (frameInfo === "encoding") {
      def.encoding = parseCommaSeparatedString(value);
    } else if (frameInfo === "signed") {
      def.signed = parseCommaSeparatedString(value);
    }
    return true;
  }

  private translateLegacyFieldNames(names: string[]): string[] {
    return names.map((n) => {
      const m = /^gyroData(.+)$/.exec(n);
      return m ? `gyroADC${m[1]}` : n;
    });
  }

  private extractSysConfig(): void {
    const h = this.headers;
    const motorOutput = h["motorOutput"] ? parseCommaSeparatedString(h["motorOutput"]) : null;
    if (motorOutput && motorOutput.length >= 2) {
      this.motorOutputMin = motorOutput[0]!;
    }
    const minthrottle = h["minthrottle"] ? Number.parseInt(h["minthrottle"], 10) : NaN;
    if (!Number.isNaN(minthrottle)) {
      this.minthrottle = minthrottle;
      if (!motorOutput) this.motorOutputMin = minthrottle;
    }
    const vbatref = h["vbatref"] ? Number.parseInt(h["vbatref"], 10) : NaN;
    if (!Number.isNaN(vbatref)) this.vbatref = vbatref;

    const gyroScaleStr = h["gyro.scale"] ?? h["gyro_scale"];
    if (gyroScaleStr) this.gyroScale = parseGyroScale(gyroScaleStr);

    const looptime = h["looptime"] ? Number.parseInt(h["looptime"], 10) : NaN;
    if (!Number.isNaN(looptime)) this.looptimeUs = looptime;

    this.firmware = h["Firmware revision"] ?? null;
  }

  private parseLogData(): void {
    const idef = this.frameDefs.I!;
    const pdef = this.frameDefs.P!;
    const maxFrames = this.opts.maxFrames ?? 1_000_000;

    let cur = new Array<number>(idef.count);
    let prev: number[] | null = null;
    let prev2: number[] | null = null;

    while (this.frameCount < maxFrames) {
      const frameStart = this.stream.pos;
      const c = this.stream.readChar();
      if (c === String.fromCharCode(EOF)) break;

      try {
        if (c === "I") {
          this.parseFrame(idef, cur, prev, null, 0);
          this.emitMainFrame(cur);
          // Both history slots become the I-frame: we can't look further
          // into the past than an intraframe (matches the reference viewer).
          prev2 = cur;
          prev = cur;
          cur = new Array<number>(idef.count);
        } else if (c === "P") {
          this.parseFrame(pdef, cur, prev, prev2, this.lastSkippedFrames);
          this.emitMainFrame(cur);
          prev2 = prev;
          prev = cur;
          cur = new Array<number>(idef.count);
        } else if (c === "S" && this.frameDefs.S) {
          this.lastSlow = new Array<number>(this.frameDefs.S.count);
          this.parseFrame(this.frameDefs.S, this.lastSlow, null, null, 0);
        } else if (c === "E") {
          this.parseEvent();
        } else if (c === "G" && this.frameDefs.G) {
          this.lastGPS = new Array<number>(this.frameDefs.G.count);
          this.parseFrame(this.frameDefs.G, this.lastGPS, null, null, 0);
        } else if (c === "H" && this.frameDefs.H) {
          const home = new Array<number>(this.frameDefs.H.count);
          this.parseFrame(this.frameDefs.H, home, null, null, 0);
          this.gpsHomeHistory[1] = home;
        }
        // else: unknown byte — skip it (resync)
      } catch (err) {
        // Corrupt/truncated frame: rescan from the byte after the frame
        // marker. Surface the cause — a BlackboxParseError here means an
        // unsupported encoding/predictor/event, exactly what the user needs
        // to know about (an empty channel set with no explanation otherwise).
        this.stream.pos = frameStart + 1;
        this.stream.eof = false;
        const reason = err instanceof Error ? err.message : String(err);
        this.warn(reason, `Skipped frame at offset ${frameStart}: ${reason}`);
      }
    }

    if (this.frameCount >= maxFrames) {
      this.truncated = true;
      this.warn("truncated", `Log truncated at the ${maxFrames}-frame parse cap — analysis covers the first portion only.`);
    }
  }

  private emitMainFrame(frame: number[]): void {
    const idef = this.frameDefs.I!;
    const timeIndex = idef.nameToIndex["time"] ?? 1;
    const iterIndex = idef.nameToIndex["loopIteration"] ?? 0;
    const time = frame[timeIndex] ?? 0;
    const iteration = frame[iterIndex] ?? 0;

    // Light desync guard: time must not run backwards
    if (this.lastMainFrameTime !== -1 && time < this.lastMainFrameTime) {
      return;
    }

    this.timeUs.push(time);
    for (let i = 0; i < idef.count; i++) {
      const name = idef.name[i]!;
      if (!this.channels[name]) this.channels[name] = new GrowableF32();
      this.channels[name]!.push(frame[i] ?? 0);
    }
    this.frameCount++;

    if (this.lastMainFrameIteration === -1) {
      this.lastSkippedFrames = 0;
    } else {
      this.lastSkippedFrames = Math.max(0, iteration - this.lastMainFrameIteration - 1);
    }
    this.lastMainFrameIteration = iteration;
    this.lastMainFrameTime = time;
  }

  private parseFrame(
    frameDef: FieldDef,
    current: number[],
    previous: number[] | null,
    previous2: number[] | null,
    skippedFrames: number,
  ): void {
    const predictor = frameDef.predictor;
    const encoding = frameDef.encoding;
    let i = 0;

    while (i < frameDef.count) {
      if (predictor[i] === P_INC) {
        current[i] = skippedFrames + 1;
        if (previous) current[i] += previous[i] ?? 0;
        i++;
      } else {
        switch (encoding[i]) {
          case E_SIGNED_VB:
            current[i] = this.applyPrediction(
              i,
              predictor[i]!,
              this.stream.readSignedVB(),
              current,
              previous,
              previous2,
            );
            i++;
            break;
          case E_UNSIGNED_VB:
            current[i] = this.applyPrediction(
              i,
              predictor[i]!,
              this.stream.readUnsignedVB(),
              current,
              previous,
              previous2,
            );
            i++;
            break;
          case E_NEG_14BIT:
            current[i] = this.applyPrediction(
              i,
              predictor[i]!,
              -signExtend14Bit(this.stream.readUnsignedVB()),
              current,
              previous,
              previous2,
            );
            i++;
            break;
          case E_TAG8_4S16: {
            const v = this.dataVersion < 2 ? readTag8_4S16_v1(this.stream) : readTag8_4S16_v2(this.stream);
            for (let j = 0; j < 4; j++, i++) {
              current[i] = this.applyPrediction(i, predictor[i]!, v[j]!, current, previous, previous2);
            }
            break;
          }
          case E_TAG2_3S32: {
            const v = readTag2_3S32(this.stream);
            for (let j = 0; j < 3; j++, i++) {
              current[i] = this.applyPrediction(i, predictor[i]!, v[j]!, current, previous, previous2);
            }
            break;
          }
          case E_TAG2_3SVARIABLE: {
            const v = readTag2_3SVariable(this.stream);
            for (let j = 0; j < 3; j++, i++) {
              current[i] = this.applyPrediction(i, predictor[i]!, v[j]!, current, previous, previous2);
            }
            break;
          }
          case E_TAG8_8SVB: {
            let j = i + 1;
            for (; j < i + 8 && j < frameDef.count; j++) {
              if (encoding[j] !== E_TAG8_8SVB) break;
            }
            const groupCount = j - i;
            const v = readTag8_8SVB(this.stream, groupCount);
            for (let k = 0; k < groupCount; k++, i++) {
              current[i] = this.applyPrediction(i, predictor[i]!, v[k]!, current, previous, previous2);
            }
            break;
          }
          case E_NULL:
            current[i] = this.applyPrediction(i, predictor[i]!, 0, current, previous, previous2);
            i++;
            break;
          default:
            throw new BlackboxParseError(
              `Unsupported field encoding ${encoding[i]} for field '${frameDef.name[i]}'`,
              this.stream.pos,
            );
        }
      }
    }
  }

  private applyPrediction(
    fieldIndex: number,
    predictor: number,
    value: number,
    current: number[],
    previous: number[] | null,
    previous2: number[] | null,
  ): number {
    const idef = this.frameDefs.I!;
    switch (predictor) {
      case P_0:
        break;
      case P_MINTHROTTLE:
        value = Math.trunc(value) + this.minthrottle;
        break;
      case P_MINMOTOR:
        value = Math.trunc(value) + Math.trunc(this.motorOutputMin);
        break;
      case P_1500:
        value += 1500;
        break;
      case P_MOTOR_0: {
        const idx = idef.nameToIndex["motor[0]"];
        if (idx === undefined) {
          throw new BlackboxParseError("MOTOR_0 predictor used before motor[0] was read", this.stream.pos);
        }
        value += current[idx] ?? 0;
        break;
      }
      case P_VBATREF:
        value += this.vbatref;
        break;
      case P_PREVIOUS:
        if (previous) value += previous[fieldIndex] ?? 0;
        break;
      case P_STRAIGHT_LINE:
        if (previous) value += 2 * (previous[fieldIndex] ?? 0) - (previous2?.[fieldIndex] ?? 0);
        break;
      case P_AVERAGE_2:
        if (previous) value += ~~(((previous[fieldIndex] ?? 0) + (previous2?.[fieldIndex] ?? 0)) / 2);
        break;
      case P_HOME_COORD: {
        const hdef = this.frameDefs.H;
        const idx = hdef?.nameToIndex["GPS_home[0]"];
        if (idx === undefined) {
          throw new BlackboxParseError("HOME_COORD predictor without GPS home frame", this.stream.pos);
        }
        value += this.gpsHomeHistory[1]?.[idx] ?? 0;
        break;
      }
      case P_HOME_COORD_1: {
        const hdef = this.frameDefs.H;
        const idx = hdef?.nameToIndex["GPS_home[1]"];
        if (idx === undefined) {
          throw new BlackboxParseError("HOME_COORD_1 predictor without GPS home frame", this.stream.pos);
        }
        value += this.gpsHomeHistory[1]?.[idx] ?? 0;
        break;
      }
      case P_LAST_MAIN_FRAME_TIME:
        if (previous) value += previous[idef.nameToIndex["time"] ?? 1] ?? 0;
        break;
      default:
        throw new BlackboxParseError(`Unsupported field predictor ${predictor}`, this.stream.pos);
    }
    return value;
  }

  private parseEvent(): void {
    const eventType = this.stream.readByte();

    switch (eventType) {
      case EV_SYNC_BEEP:
        this.stream.readUnsignedVB();
        break;
      case EV_FLIGHT_MODE:
        this.stream.readUnsignedVB();
        this.stream.readUnsignedVB();
        break;
      case EV_DISARM:
        this.stream.readUnsignedVB();
        break;
      case EV_AUTOTUNE_CYCLE_START:
        this.stream.readByte();
        this.stream.readByte();
        this.stream.readByte();
        this.stream.readByte();
        this.stream.readByte();
        break;
      case EV_AUTOTUNE_CYCLE_RESULT:
        this.stream.readByte();
        this.stream.readByte();
        this.stream.readByte();
        this.stream.readByte();
        break;
      case EV_AUTOTUNE_TARGETS:
        this.stream.readS16();
        this.stream.readByte();
        this.stream.readByte();
        this.stream.readS16();
        this.stream.readS16();
        break;
      case EV_GTUNE_CYCLE_RESULT:
        this.stream.readByte();
        this.stream.readSignedVB();
        this.stream.readS16();
        break;
      case EV_INFLIGHT_ADJUSTMENT: {
        const tmp = this.stream.readByte();
        if (tmp < 128) this.stream.readSignedVB();
        else this.stream.readU32();
        break;
      }
      case EV_TWITCH_TEST:
        this.stream.readByte();
        this.stream.readU32();
        break;
      case EV_LOGGING_RESUME:
        this.stream.readUnsignedVB();
        this.stream.readUnsignedVB();
        break;
      case EV_LOG_END: {
        const endMessage = this.stream.readString(END_OF_LOG_MESSAGE.length);
        if (endMessage === END_OF_LOG_MESSAGE) {
          this.stream.end = this.stream.pos;
        }
        break;
      }
      default:
        throw new BlackboxParseError(`Unsupported event type ${eventType}`, this.stream.pos);
    }
  }
}

export function parseBlackboxLog(data: Uint8Array, opts: ParseOptions = {}): ParsedLog {
  return new BlackboxParser(data, opts).parse();
}
