import { buildMspV2Request, ResponseParser } from "./codec";

export class MspSerial {
  private port: SerialPort | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  readonly parser = new ResponseParser();

  static isSupported(): boolean {
    return typeof navigator !== "undefined" && !!navigator.serial;
  }

  get connected(): boolean {
    return this.port !== null;
  }

  async connect(): Promise<void> {
    if (!MspSerial.isSupported()) throw new Error("WebSerial is not supported in this browser");
    const port = await navigator.serial!.requestPort();
    await port.open({ baudRate: 115200 });
    this.port = port;
    this.reader = port.readable!.getReader();
    this.parser.clear();
  }

  async disconnect(): Promise<void> {
    if (this.reader) {
      try {
        await this.reader.cancel();
        this.reader.releaseLock();
      } catch {
        // ignore
      }
      this.reader = null;
    }
    if (this.port) {
      try {
        await this.port.close();
      } catch {
        // ignore
      }
      this.port = null;
    }
    this.parser.clear();
  }

  async write(data: Uint8Array): Promise<void> {
    if (!this.port?.writable) throw new Error("Not connected");
    const writer = this.port.writable.getWriter();
    try {
      await writer.write(data);
    } finally {
      writer.releaseLock();
    }
  }

  /** Send an MSP v2 request and await the matching response payload. */
  async query(command: number, payload?: Uint8Array, timeoutMs = 2000): Promise<Uint8Array> {
    await this.write(buildMspV2Request(command, payload));
    return this.readResponse(command, timeoutMs);
  }

  /** Read one chunk with a timeout. Returns null on stream end. */
  private async readChunk(timeoutMs: number): Promise<Uint8Array | null> {
    if (!this.reader) throw new Error("Not connected");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        this.reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("MSP read timeout")), timeoutMs);
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (result.done) return null;
      return result.value;
    } catch (err) {
      if (timer) clearTimeout(timer);
      // A timeout leaves a pending read; cancel and release the lock so the
      // port can be re-opened, and drop the connection state.
      try {
        await this.reader?.cancel();
        this.reader?.releaseLock();
      } catch {
        // ignore
      }
      this.reader = null;
      const port = this.port;
      this.port = null;
      if (port) {
        try {
          await port.close();
        } catch {
          // ignore
        }
      }
      throw err;
    }
  }

  /**
   * Read chunks until a complete response for `command` is parsed.
   * Unexpected frames (e.g. telemetry) are ignored. MSP error frames
   * ($X !) for the requested command reject.
   */
  async readResponse(command: number, timeoutMs = 2000): Promise<Uint8Array> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const parsed = this.parser.tryParse();
      if (parsed) {
        if (parsed.command === command) {
          if (parsed.error) throw new Error(`FC rejected MSP command ${command}`);
          return parsed.payload;
        }
        continue;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`MSP command ${command} timed out`);
      const chunk = await this.readChunk(remaining);
      if (chunk === null) throw new Error("Serial stream ended");
      this.parser.push(chunk);
    }
  }
}
