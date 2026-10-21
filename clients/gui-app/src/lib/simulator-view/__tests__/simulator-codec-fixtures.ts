import type {
  DecodedVideoFrame,
  SimulatorDecoderRuntime,
  SimulatorFrameSink,
  SimulatorVideoDecoder,
  SimulatorVideoDecoderInit,
} from "@/lib/simulator-view/simulator-decoder";

/**
 * Byte fixtures and WebCodecs stand-ins shared by the decoder and controller
 * suites. The bytes are the shapes the relay forwards: an `avcC` record for
 * `description`, bare access units for `keyframe` / `delta`, and a whole SEMU
 * packet (header included) for Android.
 */

/** An `avcC` record for High profile, level 5.1: `avc1.640033`. */
export const AVCC_DESCRIPTION = new Uint8Array([
  0x01, 0x64, 0x00, 0x33, 0xff, 0xe1, 0x00, 0x04, 0x67, 0x64, 0x00, 0x33, 0x01,
  0x00, 0x02, 0x68, 0xee,
]);
export const AVCC_CODEC = "avc1.640033";

/** An Annex B IDR access unit (start code, SPS, PPS, IDR slice). */
export const ANNEX_B_KEYFRAME = new Uint8Array([
  0x00, 0x00, 0x00, 0x01, 0x67, 0x64, 0x00, 0x33, 0xac, 0x00, 0x00, 0x00, 0x01,
  0x68, 0xee, 0x3c, 0x80, 0x00, 0x00, 0x00, 0x01, 0x65, 0x88, 0x84, 0x00,
]);
/** An Annex B non-IDR slice. */
export const ANNEX_B_DELTA = new Uint8Array([
  0x00, 0x00, 0x00, 0x01, 0x41, 0x9a, 0x02, 0x04,
]);

export const SEMU_PTS_US = 123_456_789;

/** One SEMU packet: `SEMU`, version 1, flags, two reserved bytes, a 64-bit pts, then the access unit. */
export function semuPacket(
  accessUnit: Uint8Array,
  isKey: boolean,
  pts: number,
): Uint8Array {
  const packet = new Uint8Array(16 + accessUnit.length);
  const view = new DataView(packet.buffer);
  view.setUint32(0, 0x53454d55, false);
  view.setUint8(4, 1);
  view.setUint8(5, isKey ? 1 : 0);
  view.setBigUint64(8, BigInt(pts), false);
  packet.set(accessUnit, 16);
  return packet;
}

/** A drawable frame for the fake decoder to emit: an `<img>` is a `CanvasImageSource`. */
function decodedFrame(width: number, height: number): DecodedVideoFrame {
  return Object.assign(document.createElement("img"), {
    displayWidth: width,
    displayHeight: height,
    close: () => undefined,
  });
}

class FakeVideoDecoder implements SimulatorVideoDecoder {
  state: CodecState = "unconfigured";
  decodeQueueSize = 0;
  readonly configs: VideoDecoderConfig[] = [];
  readonly chunks: EncodedVideoChunkInit[] = [];
  readonly init: SimulatorVideoDecoderInit;

  constructor(init: SimulatorVideoDecoderInit) {
    this.init = init;
  }

  configure(config: VideoDecoderConfig): void {
    this.configs.push(config);
    this.state = "configured";
  }

  decode(chunk: EncodedVideoChunkInit): void {
    if (this.state !== "configured") throw new Error("decoder not configured");
    this.chunks.push(chunk);
  }

  close(): void {
    this.state = "closed";
  }

  emitFrame(width: number, height: number): void {
    this.init.output(decodedFrame(width, height));
  }

  emitError(message: string): void {
    this.init.error(new DOMException(message, "EncodingError"));
  }
}

export interface FakeCodecRuntime {
  readonly runtime: SimulatorDecoderRuntime;
  readonly decoders: FakeVideoDecoder[];
  readonly probes: VideoDecoderConfig[];
  readonly bitmaps: Blob[];
}

export function fakeCodecRuntime(supported: boolean): FakeCodecRuntime {
  const decoders: FakeVideoDecoder[] = [];
  const probes: VideoDecoderConfig[] = [];
  const bitmaps: Blob[] = [];
  return {
    decoders,
    probes,
    bitmaps,
    runtime: {
      isConfigSupported: (config) => {
        probes.push(config);
        return Promise.resolve(supported);
      },
      createDecoder: (init) => {
        const decoder = new FakeVideoDecoder(init);
        decoders.push(decoder);
        return decoder;
      },
      createImageBitmap: (blob) => {
        bitmaps.push(blob);
        const bitmap: ImageBitmap = {
          width: 320,
          height: 640,
          close: () => undefined,
        };
        return Promise.resolve(bitmap);
      },
    },
  };
}

export interface RecordingSink extends SimulatorFrameSink {
  readonly painted: Array<{ readonly width: number; readonly height: number }>;
  readonly jpegs: Uint8Array[];
}

export function recordingSink(): RecordingSink {
  const sink: RecordingSink = {
    painted: [],
    jpegs: [],
    present(_source, width, height) {
      sink.painted.push({ width, height });
      return true;
    },
    presentJpeg(bytes) {
      sink.jpegs.push(bytes);
      return true;
    },
  };
  return sink;
}

/**
 * Lets the support probe's promise and whatever follows it settle. Microtasks
 * only, so it also works under fake timers, where a `setTimeout(0)` never
 * fires on its own.
 */
export async function flushAsync(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await Promise.resolve();
  }
}
