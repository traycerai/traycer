import type { SimulatorPlatform } from "@traycer/protocol/host/simulator/schemas";
import type { SimulatorVideoUnit } from "@traycer/protocol/host/simulator/stream-contracts";
import type { FrameSize } from "@/lib/simulator-view/simulator-input-encoding";

/**
 * The video half of the simulator tile: bytes from `simulator.stream` in,
 * painted frames out. A port of t3code's `device/stream.ts` decode path with
 * the socket layer removed. The relay has already demuxed serve-sim's AVCC
 * envelope (each `video` frame is ONE unit with its length prefix and tag
 * byte stripped), so this feeds WebCodecs by unit and never re-demuxes; an
 * Android SEMU packet still arrives whole, header included, and is parsed
 * here because its header carries the keyframe flag and the timestamp.
 *
 *   iOS     description ──▶ configure ──▶ keyframe/delta ──▶ decode ──▶ paint
 *           seed (JPEG)  ──▶ paint once, before the first decoded frame
 *   Android packet ──▶ parse ──▶ (SPS? configure) ──▶ decode ──▶ paint
 *   either  jpeg ──▶ the surface's <img>
 *
 * Decisions about what to do when something fails are the controller's: this
 * reports them (`onConfigRejected`, `onKeyframeNeeded`, `onDecodeError`) and
 * resets when told to, because the remedy differs by platform and needs the
 * wire (`preferMjpeg`, `requestKeyframe`), which this module never sees.
 */

/** A synchronous, borrowed frame. The producer releases its source after `present` returns. */
export interface SimulatorFrameSink {
  readonly present: (
    source: CanvasImageSource,
    width: number,
    height: number,
  ) => boolean;
  /** One MJPEG frame for the `<img>` plane; false when no image is mounted. */
  readonly presentJpeg: (bytes: Uint8Array) => boolean;
}

export type KeyframeNeededReason =
  | "backpressure"
  | "configured"
  | "delta-before-keyframe"
  | "decode-error";

export interface SimulatorDecoderEvents {
  /** A frame reached the sink. `size` is null for a JPEG, whose size the image reports on load. */
  readonly onFrame: (size: FrameSize | null) => void;
  /** The platform's codec profile cannot be decoded here. */
  readonly onConfigRejected: (codec: string) => void;
  /** The decoder must be re-primed with a fresh keyframe from the hub. */
  readonly onKeyframeNeeded: (reason: KeyframeNeededReason) => void;
  readonly onDecodeError: (detail: string) => void;
}

export interface SimulatorDecoder {
  readonly feed: (unit: SimulatorVideoUnit, bytes: Uint8Array) => void;
  /**
   * Drops the decode queue and waits for the next keyframe, keeping the last
   * configuration so a keyframe that arrives without a new description still
   * decodes. Called after the controller asked the hub for one.
   */
  readonly reset: () => void;
  readonly close: () => void;
}

/**
 * A decoded frame as the sink paints it: whatever the runtime's decoder
 * produces, with the display size and the release the decoder owes it. A
 * real `VideoFrame` is one; a test's stand-in need only be drawable.
 */
export type DecodedVideoFrame = CanvasImageSource & {
  readonly displayWidth: number;
  readonly displayHeight: number;
  readonly close: () => void;
};

export interface SimulatorVideoDecoderInit {
  readonly output: (frame: DecodedVideoFrame) => void;
  readonly error: (error: DOMException) => void;
}

/** The slice of a `VideoDecoder` this module drives. */
export interface SimulatorVideoDecoder {
  readonly state: CodecState;
  readonly decodeQueueSize: number;
  readonly configure: (config: VideoDecoderConfig) => void;
  readonly decode: (chunk: EncodedVideoChunkInit) => void;
  readonly close: () => void;
}

/** The WebCodecs surface the decoder touches, injectable so a suite can stand in for it. */
export interface SimulatorDecoderRuntime {
  readonly isConfigSupported: (config: VideoDecoderConfig) => Promise<boolean>;
  readonly createDecoder: (
    init: SimulatorVideoDecoderInit,
  ) => SimulatorVideoDecoder;
  readonly createImageBitmap: (blob: Blob) => Promise<ImageBitmap>;
}

const FRAME_DURATION_US = 16_667;
const SEMU_MAGIC = 0x53454d55;
export const SEMU_HEADER_BYTES = 16;
const SEMU_FLAG_KEY = 1;
/** Frames the decoder may hold before the stream is asked for a fresh keyframe. */
export const SOFT_DECODE_QUEUE = 8;
const FALLBACK_AVC_CODEC = "avc1.42E01E";

export function isWebCodecsSupported(): boolean {
  return "VideoDecoder" in globalThis && "EncodedVideoChunk" in globalThis;
}

export function defaultSimulatorDecoderRuntime(): SimulatorDecoderRuntime {
  return {
    isConfigSupported: async (config) =>
      (await VideoDecoder.isConfigSupported(config)).supported === true,
    createDecoder: (init) => {
      const decoder = new VideoDecoder({
        output: init.output,
        error: init.error,
      });
      return {
        get state() {
          return decoder.state;
        },
        get decodeQueueSize() {
          return decoder.decodeQueueSize;
        },
        configure: (config) => decoder.configure(config),
        decode: (chunk) => decoder.decode(new EncodedVideoChunk(chunk)),
        close: () => decoder.close(),
      };
    },
    createImageBitmap: (blob) => createImageBitmap(blob),
  };
}

export function createCanvasFrameSink(
  canvas: HTMLCanvasElement,
  image: HTMLImageElement | null,
): SimulatorFrameSink {
  let objectUrl: string | null = null;
  return {
    present(source, width, height) {
      const context = canvas.getContext("2d");
      if (context === null) return false;
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      context.drawImage(source, 0, 0, width, height);
      return true;
    },
    presentJpeg(bytes) {
      if (image === null) return false;
      const next = URL.createObjectURL(
        new Blob([bytes.slice().buffer], { type: "image/jpeg" }),
      );
      const previous = objectUrl;
      objectUrl = next;
      image.src = next;
      if (previous !== null) URL.revokeObjectURL(previous);
      return true;
    },
  };
}

/**
 * `avc1.PPCCLL` from an `avcC` record (or an SPS NAL): profile, constraint
 * flags and level are bytes 1..3 of either.
 */
export function avcCodecString(bytes: Uint8Array): string {
  if (bytes.length < 4) return FALLBACK_AVC_CODEC;
  const hex = (byte: number) => byte.toString(16).padStart(2, "0");
  return `avc1.${hex(bytes[1])}${hex(bytes[2])}${hex(bytes[3])}`;
}

export interface SemuPacket {
  readonly data: Uint8Array;
  /** null when the packet carried no SEMU header, so the access unit must be scanned. */
  readonly isKey: boolean | null;
  readonly timestamp: number | null;
}

/**
 * serve-emu's framing: a 16-byte header (`SEMU`, version 1, flags, 64-bit
 * presentation time) before the Annex B access unit. A packet without the
 * magic is a bare access unit.
 */
export function parseSemuPacket(bytes: Uint8Array): SemuPacket {
  if (bytes.byteLength > SEMU_HEADER_BYTES) {
    const view = new DataView(
      bytes.buffer,
      bytes.byteOffset,
      SEMU_HEADER_BYTES,
    );
    if (view.getUint32(0, false) === SEMU_MAGIC && view.getUint8(4) === 1) {
      const pts = view.getBigUint64(8, false);
      return {
        data: bytes.subarray(SEMU_HEADER_BYTES),
        isKey: (view.getUint8(5) & SEMU_FLAG_KEY) !== 0,
        timestamp: pts <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(pts) : null,
      };
    }
  }
  return { data: bytes, isKey: null, timestamp: null };
}

/** Walks an Annex B access unit for its IDR flag and first SPS. */
export function scanAccessUnit(buf: Uint8Array): {
  readonly isKey: boolean;
  readonly sps: Uint8Array | null;
} {
  let isKey = false;
  let sps: Uint8Array | null = null;
  const len = buf.length;
  let i = 0;
  while (i + 2 < len) {
    if (buf[i] === 0 && buf[i + 1] === 0) {
      let codeLen = 0;
      if (buf[i + 2] === 1) codeLen = 3;
      else if (i + 3 < len && buf[i + 2] === 0 && buf[i + 3] === 1) codeLen = 4;
      if (codeLen !== 0) {
        const nalType = buf[i + codeLen] & 0x1f;
        if (nalType === 7 && sps === null) sps = buf.subarray(i + codeLen);
        if (nalType === 5) isKey = true;
        i += codeLen + 1;
        continue;
      }
    }
    i++;
  }
  return { isKey, sps };
}

export function createSimulatorDecoder(args: {
  readonly platform: SimulatorPlatform;
  readonly sink: SimulatorFrameSink;
  readonly events: SimulatorDecoderEvents;
  readonly runtime: SimulatorDecoderRuntime;
}): SimulatorDecoder {
  const { platform, sink, events, runtime } = args;
  let closed = false;
  let decoder: SimulatorVideoDecoder | null = null;
  let lastConfig: VideoDecoderConfig | null = null;
  let awaitingKeyframe = true;
  let configuring = false;
  let decodedFrames = 0;
  let timestamp = 0;
  // Bumped by every reset/close so an in-flight support probe or seed decode
  // from before it cannot act on the decoder that replaced it.
  let epoch = 0;

  const closeDecoder = (): void => {
    epoch++;
    try {
      decoder?.close();
    } catch {
      // Already closed by an error callback.
    }
    decoder = null;
    awaitingKeyframe = true;
    configuring = false;
  };

  const makeDecoder = (): SimulatorVideoDecoder => {
    const created: SimulatorVideoDecoder = runtime.createDecoder({
      output: (frame) => {
        try {
          if (decoder === created && !closed) {
            decodedFrames++;
            const size = {
              width: frame.displayWidth,
              height: frame.displayHeight,
            };
            if (sink.present(frame, size.width, size.height)) {
              events.onFrame(size);
            }
          }
        } finally {
          frame.close();
        }
      },
      error: (cause) => {
        if (closed || decoder !== created) return;
        events.onDecodeError(cause.message);
      },
    });
    return created;
  };

  /** Configures synchronously from an already-probed config. */
  const applyConfig = (config: VideoDecoderConfig): boolean => {
    try {
      if (decoder === null || decoder.state === "closed") {
        decoder = makeDecoder();
      }
      decoder.configure(config);
      lastConfig = config;
      awaitingKeyframe = true;
      return true;
    } catch (cause) {
      events.onDecodeError(
        cause instanceof Error ? cause.message : String(cause),
      );
      return false;
    }
  };

  const configure = async (config: VideoDecoderConfig): Promise<void> => {
    if (configuring) return;
    configuring = true;
    const startEpoch = epoch;
    const full: VideoDecoderConfig = { ...config, optimizeForLatency: true };
    const supported = await runtime.isConfigSupported(full).catch(() => false);
    if (closed || startEpoch !== epoch) return;
    configuring = false;
    if (!supported) {
      events.onConfigRejected(full.codec);
      return;
    }
    if (applyConfig(full) && platform === "android") {
      // The SPS that configured us rode a frame the decoder was not yet ready
      // for; the hub has to start again from an IDR.
      events.onKeyframeNeeded("configured");
    }
  };

  const decode = (
    isKey: boolean,
    data: Uint8Array,
    pts: number | null,
  ): void => {
    if (decoder === null || decoder.state !== "configured") {
      if (!isKey) events.onKeyframeNeeded("delta-before-keyframe");
      return;
    }
    if (awaitingKeyframe) {
      if (!isKey) return;
      awaitingKeyframe = false;
    }
    if (decoder.decodeQueueSize > SOFT_DECODE_QUEUE) {
      reset();
      events.onKeyframeNeeded("backpressure");
      return;
    }
    try {
      decoder.decode({
        type: isKey ? "key" : "delta",
        timestamp: pts ?? timestamp,
        data,
      });
      timestamp += FRAME_DURATION_US;
    } catch (cause) {
      events.onDecodeError(
        cause instanceof Error ? cause.message : String(cause),
      );
    }
  };

  const paintSeed = (bytes: Uint8Array): void => {
    const startEpoch = epoch;
    void runtime
      .createImageBitmap(
        new Blob([bytes.slice().buffer], { type: "image/jpeg" }),
      )
      .then((bitmap) => {
        try {
          if (
            !closed &&
            startEpoch === epoch &&
            decodedFrames === 0 &&
            sink.present(bitmap, bitmap.width, bitmap.height)
          ) {
            events.onFrame({ width: bitmap.width, height: bitmap.height });
          }
        } finally {
          bitmap.close();
        }
      })
      .catch(() => {
        // A seed that will not decode is cosmetic; the keyframe follows.
      });
  };

  const feedPacket = (bytes: Uint8Array): void => {
    const packet = parseSemuPacket(bytes);
    const unconfigured = decoder === null || decoder.state !== "configured";
    const needsScan = packet.isKey === null || (packet.isKey && unconfigured);
    const scanned = needsScan ? scanAccessUnit(packet.data) : null;
    const isKey = packet.isKey ?? scanned?.isKey ?? false;
    if (unconfigured && scanned?.sps !== null && scanned?.sps !== undefined) {
      void configure({ codec: avcCodecString(scanned.sps) });
      return;
    }
    decode(isKey, packet.data, packet.timestamp);
  };

  function reset(): void {
    if (closed) return;
    const config = lastConfig;
    closeDecoder();
    if (config !== null) applyConfig(config);
  }

  return {
    feed(unit, bytes) {
      if (closed) return;
      switch (unit) {
        case "description":
          closeDecoder();
          void configure({
            codec: avcCodecString(bytes),
            description: bytes,
          });
          return;
        case "keyframe":
          decode(true, bytes, null);
          return;
        case "delta":
          decode(false, bytes, null);
          return;
        case "seed":
          paintSeed(bytes);
          return;
        case "packet":
          feedPacket(bytes);
          return;
        case "jpeg":
          if (sink.presentJpeg(bytes)) events.onFrame(null);
          return;
      }
    },
    reset,
    close() {
      if (closed) return;
      closed = true;
      closeDecoder();
    },
  };
}
