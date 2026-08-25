/**
 * Minimal WebSerial typings (Chrome/Edge). Declared locally to avoid an
 * extra dependency; the API is only used from the browser.
 */
declare global {
  interface Navigator {
    serial?: {
      requestPort(options?: { filters?: { usbVendorId?: number; usbProductId?: number }[] }): Promise<SerialPort>;
      getPorts(): Promise<SerialPort[]>;
    };
  }

  interface SerialPort {
    open(options: { baudRate: number }): Promise<void>;
    close(): Promise<void>;
    readable: ReadableStream<Uint8Array> | null;
    writable: WritableStream<Uint8Array> | null;
    getInfo(): { usbVendorId?: number; usbProductId?: number };
  }
}

export {};
