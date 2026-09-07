// SYNCHRONOUS BY REQUIREMENT, not by preference - do not swap in an async codec (`CompressionStream`, `node:zlib`'s callback/stream forms, a worker).
import { deflateSync, Inflate } from "fflate";
import {
  MAX_MUX_MESSAGE_BYTES,
  MUX_FRAME_HEADER_LEN,
  MuxFrameDecodeError,
  MuxFrameType,
  MuxMessageSizeError,
  QosClass,
  type EncodeMuxFrameInput,
  type MuxFrame,
  type MuxFrameTypeValue,
  type QosClassValue,
} from "./mux";


/** Max bytes of body per chunk frame (well under the frame plaintext cap). */
export const BULK_CHUNK_SIZE_BYTES = 64 * 1024;

export const BULK_QOS_BODY_THRESHOLD_BYTES = 1024 * 1024;

export const CHUNK_PACE_BYTES_PER_SEC = 6 * 1024 * 1024;
export const CHUNK_PACE_FRAMES_PER_SEC = 375;
export const CHUNK_PACE_BURST_BYTES = 1024 * 1024;
export const CHUNK_PACE_BURST_FRAMES = 64;

/** A frame payload smaller than this is never compressed. */
export const COMPRESSION_MIN_PAYLOAD_BYTES = 4096;

/** DEFLATE level for outbound frame payloads. */
const COMPRESSION_LEVEL = 1;

// A DEFLATE stream can expand by roughly this factor.
const DEFLATE_MAX_EXPANSION_RATIO = 1032;

/** A compressed payload is `[plainLen:u32 BE][deflate bytes]`. */
const COMPRESSED_PAYLOAD_HEADER_LEN = 4;

const BODY_HEADER_LEN = 5;
const BODY_FLAG_HAS_BINARY = 0b0000_0001;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export interface OutboundMessage {
  readonly type: MuxFrameTypeValue;
  readonly streamId: number;
  readonly qos: QosClassValue;
  readonly json: Record<string, unknown> | null;
  readonly binary: Uint8Array | null;
}

/** Encodes one logical message into its wire body. */
export function encodeMuxMessageBody(
  json: Record<string, unknown> | null,
  binary: Uint8Array | null,
): Uint8Array {
  const jsonBytes =
    json === null ? null : textEncoder.encode(JSON.stringify(json));
  const jsonLen = jsonBytes === null ? 0 : jsonBytes.length;
  const binaryLen = binary === null ? 0 : binary.length;
  const totalLen = BODY_HEADER_LEN + jsonLen + binaryLen;
  if (totalLen > MAX_MUX_MESSAGE_BYTES) {
    throw new MuxMessageSizeError(totalLen);
  }
  const body = new Uint8Array(totalLen);
  body[0] = binary === null ? 0 : BODY_FLAG_HAS_BINARY;
  new DataView(body.buffer).setUint32(1, jsonLen);
  if (jsonBytes !== null) {
    body.set(jsonBytes, BODY_HEADER_LEN);
  }
  if (binary !== null) {
    body.set(binary, BODY_HEADER_LEN + jsonLen);
  }
  return body;
}

export interface DecodedMessageBody {
  readonly json: Record<string, unknown> | null;
  readonly binary: Uint8Array | null;
}

/**
 * Decodes one reassembled body back into its logical json/binary halves.
 * Bodies are authored by the peer inside the AEAD, so a malformed one is a peer bug, not line noise: it throws `MuxFrameDecodeError` and gets the same connection-level fail-closed handling a malformed frame does.
 */
export function decodeMuxMessageBody(body: Uint8Array): DecodedMessageBody {
  if (body.length < BODY_HEADER_LEN) {
    throw new MuxFrameDecodeError(
      `mux message body too short: ${body.length} < ${BODY_HEADER_LEN}`,
    );
  }
  const bodyFlags = body[0];
  if ((bodyFlags & ~BODY_FLAG_HAS_BINARY) !== 0) {
    throw new MuxFrameDecodeError(
      `mux message body has unknown flags: ${bodyFlags}`,
    );
  }
  const jsonLen = new DataView(
    body.buffer,
    body.byteOffset,
    body.byteLength,
  ).getUint32(1);
  const jsonEnd = BODY_HEADER_LEN + jsonLen;
  if (jsonEnd > body.length) {
    throw new MuxFrameDecodeError(
      `mux message body json length ${jsonLen} exceeds body (${body.length - BODY_HEADER_LEN} available)`,
    );
  }
  const hasBinary = (bodyFlags & BODY_FLAG_HAS_BINARY) !== 0;
  const json =
    jsonLen === 0
      ? null
      : parseBodyJson(body.subarray(BODY_HEADER_LEN, jsonEnd));
  const binary = hasBinary ? body.subarray(jsonEnd) : null;
  return { json, binary };
}

function parseBodyJson(bytes: Uint8Array): Record<string, unknown> {
  let decoded: string;
  try {
    decoded = textDecoder.decode(bytes);
  } catch {
    throw new MuxFrameDecodeError("mux message body json is not valid utf-8");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    throw new MuxFrameDecodeError("mux message body json is not valid json");
  }
  if (!isRecord(parsed)) {
    throw new MuxFrameDecodeError("mux message body json is not an object");
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Compresses one frame payload, or returns `null` when the frame should ride uncompressed. */
function compressFramePayload(plain: Uint8Array): Uint8Array | null {
  if (plain.length < COMPRESSION_MIN_PAYLOAD_BYTES) {
    return null;
  }
  const deflated = deflateSync(plain, { level: COMPRESSION_LEVEL });
  const encodedLength = COMPRESSED_PAYLOAD_HEADER_LEN + deflated.length;
  if (encodedLength >= plain.length) {
    return null;
  }
  const out = new Uint8Array(encodedLength);
  new DataView(out.buffer).setUint32(0, plain.length);
  out.set(deflated, COMPRESSED_PAYLOAD_HEADER_LEN);
  return out;
}

/**
 * Inflates one `MuxFlags.COMPRESSED` frame payload.
 * "Fail closed" here means the STREAM, not the session.
 */
function inflateFramePayload(payload: Uint8Array): Uint8Array {
  if (payload.length < COMPRESSED_PAYLOAD_HEADER_LEN) {
    throw new MuxFrameDecodeError(
      `compressed frame payload too short: ${payload.length} < ${COMPRESSED_PAYLOAD_HEADER_LEN}`,
    );
  }
  const plainLength = new DataView(
    payload.buffer,
    payload.byteOffset,
    payload.byteLength,
  ).getUint32(0);
  if (plainLength > BULK_CHUNK_SIZE_BYTES) {
    throw new MuxFrameDecodeError(
      `compressed frame declares ${plainLength} plaintext bytes, over the ${BULK_CHUNK_SIZE_BYTES}-byte chunk bound`,
    );
  }
  const out = new Uint8Array(plainLength + 1);
  let written = 0;
  const outputLimitExceeded = new Error(
    "compressed frame output limit exceeded",
  );
  const inflater = new Inflate((chunk) => {
    if (chunk.length > plainLength - written) {
      throw outputLimitExceeded;
    }
    out.set(chunk, written);
    written += chunk.length;
  });
  const compressed = payload.subarray(COMPRESSED_PAYLOAD_HEADER_LEN);
  try {
    for (let offset = 0; offset < compressed.length;) {
      // `Inflate` calls ondata after each push, not each decoded symbol.
      // Keep one push's possible expansion inside the remaining output budget so a forged small prefix cannot turn into a renderer-thread-sized inflate.
      const inputLength = Math.max(
        1,
        Math.floor((plainLength - written) / DEFLATE_MAX_EXPANSION_RATIO),
      );
      const end = Math.min(offset + inputLength, compressed.length);
      inflater.push(
        compressed.subarray(offset, end),
        end === compressed.length,
      );
      offset = end;
    }
  } catch (error) {
    if (error === outputLimitExceeded) {
      // The spare byte is the old, deliberate representation for an output that exceeded the declared length.
      written = plainLength + 1;
    } else {
      throw new MuxFrameDecodeError(
        `compressed frame payload failed to inflate: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (written !== plainLength) {
    // "more than" rather than a count: the spare byte proves the payload over-expanded without measuring by how much, and inventing a figure the buffer never held would be worse than naming the direction.
    const actual =
      written > plainLength ? `more than ${plainLength}` : `${written}`;
    throw new MuxFrameDecodeError(
      `compressed frame inflated to ${actual} bytes, declared ${plainLength}`,
    );
  }
  return out.subarray(0, written);
}

/**
 * One queued logical message + a cursor: the scheduler's pull-based unit of outbound work.
 * Chunk frames reference subarray VIEWS of the encoded body, never copies.
 */
export class OutboundChunkSource {
  readonly type: MuxFrameTypeValue;
  readonly streamId: number;
  /**
   * The message's EFFECTIVE class: the stream's own class, overridden to
   * BULK for bodies over {@link BULK_QOS_BODY_THRESHOLD_BYTES}.
   */
  readonly qos: QosClassValue;
  /** True when the body spans more than one frame (the paced case). */
  readonly chunked: boolean;
  readonly totalBodyBytes: number;
  /**
   * Invoked exactly once, when the final frame is pulled - the transfer-time telemetry hook for oversized bodies.
   */
  onDrained: (() => void) | null = null;

  private readonly body: Uint8Array;
  private readonly nextSeq: () => number;
  private readonly compress: boolean;
  private offset = 0;

  /**
   * `compress` is the SESSION's negotiated answer, not a per-message opinion: pass `true` only when the peer advertised `SESSION_CAPABILITY_BODY_COMPRESSION`.
   */
  constructor(
    message: OutboundMessage,
    nextSeq: () => number,
    compress: boolean,
  ) {
    this.type = message.type;
    this.streamId = message.streamId;
    this.nextSeq = nextSeq;
    this.compress = compress;
    this.body = encodeMuxMessageBody(message.json, message.binary);
    this.totalBodyBytes = this.body.length;
    this.chunked = this.body.length > BULK_CHUNK_SIZE_BYTES;
    this.qos =
      this.body.length > BULK_QOS_BODY_THRESHOLD_BYTES
        ? QosClass.BULK
        : message.qos;
  }

  get remainingBytes(): number {
    return this.body.length - this.offset;
  }

  get done(): boolean {
    return this.offset >= this.body.length;
  }

  /**
   * PLAINTEXT wire size (header + payload) of the next frame this source would emit - deliberately NOT the post-compression size, which is unknowable until the frame is materialized.
   * Reporting a compressed size here would break the second property silently - the guard bytes would never fully drain.
   */
  get nextFrameByteSize(): number {
    return (
      MUX_FRAME_HEADER_LEN +
      Math.min(this.remainingBytes, BULK_CHUNK_SIZE_BYTES)
    );
  }

  /** Materializes the next frame, drawing its `seq` now. Throws when done. */
  nextFrame(): EncodeMuxFrameInput {
    if (this.done) {
      throw new Error("OutboundChunkSource.nextFrame called after completion");
    }
    const first = this.offset === 0;
    const end = Math.min(this.offset + BULK_CHUNK_SIZE_BYTES, this.body.length);
    const slice = this.body.subarray(this.offset, end);
    const last = end >= this.body.length;
    this.offset = end;
    const compressed = this.compress ? compressFramePayload(slice) : null;
    const frame: EncodeMuxFrameInput = {
      type: this.type,
      streamId: this.streamId,
      seq: this.nextSeq(),
      qos: this.qos,
      chunked: this.chunked,
      chunkFirst: this.chunked && first,
      chunkLast: this.chunked && last,
      compressed: compressed !== null,
      json: null,
      binary: compressed ?? slice,
    };
    if (last && this.onDrained !== null) {
      const onDrained = this.onDrained;
      this.onDrained = null;
      onDrained();
    }
    return frame;
  }
}

/** A fully reassembled logical message handed up to the session dispatcher. */
export interface ReassembledMessage {
  readonly type: MuxFrameTypeValue;
  readonly streamId: number;
  readonly json: Record<string, unknown> | null;
  readonly binary: Uint8Array | null;
}

/** Thrown when a chunk sequence is malformed (fail-closed, per stream). */
export class ChunkReassemblyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChunkReassemblyError";
  }
}

/**
 * Thrown specifically when the per-stream `seq` progression breaks (a relay reordered or spliced mux frames).
 */
export class ChunkSequenceMismatchError extends ChunkReassemblyError {
  constructor(message: string) {
    super(message);
    this.name = "ChunkSequenceMismatchError";
  }
}

interface StreamAccumulator {
  readonly type: MuxFrameTypeValue;
  readonly startSeq: number;
  readonly slices: Uint8Array[];
  totalLength: number;
  nextSeq: number;
}

export class ChunkReassembler {
  private readonly accumulators = new Map<number, StreamAccumulator>();
  private readonly maxMessageBytes: number;

  /** `maxMessageBytes` shrinks the accumulation cap for tests; `undefined` = {@link MAX_MUX_MESSAGE_BYTES}. */
  constructor(maxMessageBytes: number | undefined) {
    this.maxMessageBytes = maxMessageBytes ?? MAX_MUX_MESSAGE_BYTES;
  }

  accept(frame: MuxFrame): ReassembledMessage | null {
    if (frame.json !== null) {
      // Data rides in the body; a frame-level json section on this path can
      // only come from a peer speaking a different framing. Fail closed.
      throw new ChunkReassemblyError(
        `frame on stream ${frame.streamId} carries a frame-level json section`,
      );
    }
    if (frame.binary === null) {
      throw new ChunkReassemblyError(
        `frame on stream ${frame.streamId} has no body payload`,
      );
    }

    // Inflate ONCE, here, before any accumulation decision reads a length.
    const payload = frame.compressed
      ? inflateFramePayload(frame.binary)
      : frame.binary;

    if (!frame.chunked) {
      const existing = this.accumulators.get(frame.streamId);
      if (existing !== undefined) {
        if (
          frame.type === MuxFrameType.FATAL ||
          frame.type === MuxFrameType.CLOSE
        ) {
          this.accumulators.delete(frame.streamId);
          return this.complete(frame.type, frame.streamId, payload);
        }
        throw new ChunkReassemblyError(
          `unchunked frame on stream ${frame.streamId} during in-flight chunk sequence`,
        );
      }
      return this.complete(frame.type, frame.streamId, payload);
    }

    const existing = this.accumulators.get(frame.streamId);
    if (frame.chunkFirst) {
      if (existing !== undefined) {
        this.accumulators.delete(frame.streamId);
        throw new ChunkReassemblyError(
          `new chunk sequence on stream ${frame.streamId} before sequence ${existing.startSeq} completed`,
        );
      }
      const accumulator: StreamAccumulator = {
        type: frame.type,
        startSeq: frame.seq,
        slices: [payload],
        totalLength: payload.length,
        nextSeq: nextSeqValue(frame.seq),
      };
      if (accumulator.totalLength > this.maxMessageBytes) {
        throw new MuxMessageSizeError(accumulator.totalLength);
      }
      if (frame.chunkLast) {
        return this.complete(
          accumulator.type,
          frame.streamId,
          concat(accumulator.slices, accumulator.totalLength),
        );
      }
      this.accumulators.set(frame.streamId, accumulator);
      return null;
    }

    if (existing === undefined) {
      throw new ChunkReassemblyError(
        `chunk continuation on stream ${frame.streamId} without a starting chunk`,
      );
    }
    if (frame.type !== existing.type) {
      this.accumulators.delete(frame.streamId);
      throw new ChunkReassemblyError(
        `chunk type changed on stream ${frame.streamId}`,
      );
    }
    if (frame.seq !== existing.nextSeq) {
      this.accumulators.delete(frame.streamId);
      throw new ChunkSequenceMismatchError(
        `chunk sequence mismatch on stream ${frame.streamId}: expected ${existing.nextSeq}, received ${frame.seq}`,
      );
    }
    existing.slices.push(payload);
    existing.totalLength += payload.length;
    existing.nextSeq = nextSeqValue(frame.seq);
    if (existing.totalLength > this.maxMessageBytes) {
      this.accumulators.delete(frame.streamId);
      throw new MuxMessageSizeError(existing.totalLength);
    }
    if (!frame.chunkLast) {
      return null;
    }
    this.accumulators.delete(frame.streamId);
    return this.complete(
      existing.type,
      frame.streamId,
      concat(existing.slices, existing.totalLength),
    );
  }

  /** Drops any in-flight reassembly for one stream (its logical stream ended). */
  forget(streamId: number): void {
    this.accumulators.delete(streamId);
  }

  /** Number of streams with an in-flight (incomplete) chunk reassembly - observability hook (R-2, `r2-host-stream-tombstone`) used to assert no orphan accumulator survives a tombstoned stream. */
  get pendingStreamCount(): number {
    return this.accumulators.size;
  }

  /** Plaintext bytes held across every in-flight reassembly on this peer. */
  get retainedBytes(): number {
    let total = 0;
    for (const accumulator of this.accumulators.values()) {
      total += accumulator.totalLength;
    }
    return total;
  }

  /** Drops every partial reassembly (called when the session resets). */
  reset(): void {
    this.accumulators.clear();
  }

  private complete(
    type: MuxFrameTypeValue,
    streamId: number,
    body: Uint8Array,
  ): ReassembledMessage {
    const decoded = decodeMuxMessageBody(body);
    return { type, streamId, json: decoded.json, binary: decoded.binary };
  }
}

function concat(slices: Uint8Array[], totalLength: number): Uint8Array {
  if (slices.length === 1) {
    return slices[0];
  }
  const out = new Uint8Array(totalLength);
  let offset = 0;
  for (const slice of slices) {
    out.set(slice, offset);
    offset += slice.length;
  }
  return out;
}

/** The `seq` that must follow `seq` on the same stream, wrapping at 2^32. */
export function nextSeqValue(seq: number): number {
  return (seq + 1) % 2 ** 32;
}

/**
 * Token bucket pacing a session's outbound frames to {@link CHUNK_PACE_BYTES_PER_SEC} / {@link CHUNK_PACE_FRAMES_PER_SEC}.
 */
export class ChunkPacer {
  private readonly now: () => number;
  private byteTokens = CHUNK_PACE_BURST_BYTES;
  private frameTokens = CHUNK_PACE_BURST_FRAMES;
  private lastRefillMs: number;

  constructor(now: () => number) {
    this.now = now;
    this.lastRefillMs = now();
  }

  /** Consumes budget for one frame if available; false = paced out. */
  tryConsume(frameBytes: number): boolean {
    this.refill();
    if (this.byteTokens < frameBytes || this.frameTokens < 1) {
      return false;
    }
    this.byteTokens -= frameBytes;
    this.frameTokens -= 1;
    return true;
  }

  /** How long until a frame of `frameBytes` could pass `tryConsume`. */
  msUntilAvailable(frameBytes: number): number {
    this.refill();
    const byteWaitMs =
      this.byteTokens >= frameBytes
        ? 0
        : ((frameBytes - this.byteTokens) * 1000) / CHUNK_PACE_BYTES_PER_SEC;
    const frameWaitMs =
      this.frameTokens >= 1
        ? 0
        : ((1 - this.frameTokens) * 1000) / CHUNK_PACE_FRAMES_PER_SEC;
    return Math.max(1, Math.ceil(Math.max(byteWaitMs, frameWaitMs)));
  }

  private refill(): void {
    const now = this.now();
    const elapsedMs = now - this.lastRefillMs;
    if (elapsedMs <= 0) {
      return;
    }
    this.lastRefillMs = now;
    this.byteTokens = Math.min(
      CHUNK_PACE_BURST_BYTES,
      this.byteTokens + (elapsedMs * CHUNK_PACE_BYTES_PER_SEC) / 1000,
    );
    this.frameTokens = Math.min(
      CHUNK_PACE_BURST_FRAMES,
      this.frameTokens + (elapsedMs * CHUNK_PACE_FRAMES_PER_SEC) / 1000,
    );
  }
}
