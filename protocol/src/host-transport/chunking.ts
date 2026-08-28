// SYNCHRONOUS BY REQUIREMENT, not by preference - do not swap in an async
// codec (`CompressionStream`, `node:zlib`'s callback/stream forms, a worker).
// `ChunkReassembler.accept` inflates inline, and an `await` on that path would
// release the turn mid-ingest, letting frames for other streams interleave
// between a chunk and its successor. The per-stream `seq`-adjacency guard
// would then fire on our own scheduling rather than on relay reordering,
// turning a healthy channel into `ChunkSequenceMismatchError`s. fflate is here
// specifically because it is sync and isomorphic; native zlib is faster but
// Node-only, and this module runs in the browser too.
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

/**
 * Whole-body chunking + reassembly for the client⇄host mux — the ONE shared
 * implementation both peers run (it replaced the two hand-mirrored
 * `chunker.ts` copies, whose "binary-section-only" chunking left any JSON
 * over ~1 MiB unsendable).
 *
 * Every logical message — all frame types, control frames included — encodes
 * to one opaque body:
 *
 *   [bodyFlags:u8][jsonLen:u32 BE][jsonBytes][binaryBytes]
 *
 * and rides the wire as 1..N frames whose binary sections concatenate back to
 * that body. A message whose body fits {@link BULK_CHUNK_SIZE_BYTES} is a
 * single unchunked frame; a larger one is split into ≤64 KiB chunk frames
 * (`CHUNKED`, `CHUNK_FIRST` on the first, `CHUNK_LAST` on the last). Frames
 * carry NO json section of their own — `MuxFrame.json` is always null on this
 * path, and the logical json/binary split lives in `bodyFlags` bit 0
 * (HAS_BINARY) + `jsonLen`. The single-frame case exercises exactly the same
 * encode/decode path as a 1,600-frame transfer, so small-message coverage
 * covers the large-transfer logic.
 *
 * Sending is pull-based: a message enters its session's scheduler as ONE
 * {@link OutboundChunkSource} occupying one queue slot, and frames
 * materialize (drawing their per-stream `seq`) only when the scheduler pulls
 * — eager per-frame queueing at 100 MB would trip the scheduler's own
 * queue-depth/queued-bytes health guards and evict the session for the crime
 * of carrying a large message.
 *
 * The per-stream `seq`-adjacency guard survives unchanged: `seq` is
 * AEAD-authenticated inside the Noise ciphertext, so a broken progression is
 * trustworthy evidence of relay reordering even though the channel itself is
 * healthy. `ChunkSequenceMismatchError` stays a distinguishable subclass so
 * session dispatchers can route ordering corruption to per-stream recovery
 * instead of tearing down the session.
 *
 * COMPRESSION is applied PER FRAME rather than per body, and the choice was
 * measured rather than assumed. On three real epic Y.Doc snapshots
 * (33.96 / 32.96 / 64.30 MB), compressing the whole body before chunking
 * reached 3.96× and per-64 KiB-frame compression reached 3.64× — 92% of the
 * ratio — but whole-body cost ~350 ms of SYNCHRONOUS work at enqueue, on a
 * pump shared by every session, while the per-frame variant spreads the same
 * work at ~0.3 ms per pull. Per-frame also keeps each frame independently
 * decodable, so the flag is a genuine per-frame property, a sequence may mix
 * compressed and uncompressed frames, and reassembly needs no new state.
 *
 * Compression is INVISIBLE above this module: `nextFrame` compresses on the
 * way out and `accept` inflates on the way in, so every size, bound and
 * accounting figure either side of it remains stated in plaintext bytes.
 */

/** Max bytes of body per chunk frame (well under the frame plaintext cap). */
export const BULK_CHUNK_SIZE_BYTES = 64 * 1024;

/**
 * Bodies STRICTLY larger than this ride BULK-class frames regardless of their
 * stream's method class, putting large transfers under credit flow control
 * and letting interactive traffic preempt mid-transfer. Bodies between one
 * chunk and this bound chunk at their stream's own class, uncredited.
 */
export const BULK_QOS_BODY_THRESHOLD_BYTES = 1024 * 1024;

/**
 * Sender-side pacing budget for chunked transfers, per session — deliberately
 * under the relay's per-session sliding-window caps (`workers/relay-do`:
 * 8 MiB/s, 500 frames/s), which it enforces on opaque ciphertext with a
 * session kill. Credits alone permit a 512-frame (32 MiB) burst, far over
 * that budget, so the schedulers meter chunk-frame dequeues with a token
 * bucket built from these constants. The burst capacities bound how much can
 * land inside any relay-side 1 s window to burst + rate — 7 MiB / 439
 * frames, under both caps — so no phase alignment of the two windows can
 * overshoot. Unchunked (single-frame) messages stay unpaced; their bytes
 * still drain the bucket so combined traffic respects the budget.
 */
export const CHUNK_PACE_BYTES_PER_SEC = 6 * 1024 * 1024;
export const CHUNK_PACE_FRAMES_PER_SEC = 375;
export const CHUNK_PACE_BURST_BYTES = 1024 * 1024;
export const CHUNK_PACE_BURST_FRAMES = 64;

/**
 * A frame payload smaller than this is never compressed. Below roughly this
 * size DEFLATE's own block overhead eats the gain, and everything under it on
 * this transport is latency-shaped rather than bandwidth-shaped — keystrokes,
 * credit grants, subscribe frames — where spending even a fraction of a
 * millisecond per frame buys nothing a user can perceive.
 */
export const COMPRESSION_MIN_PAYLOAD_BYTES = 4096;

/**
 * DEFLATE level for outbound frame payloads. Measured on three real epic Y.Doc
 * snapshots (33.96 / 32.96 / 64.30 MB): level 1 reaches 3.64× at ~0.3 ms per
 * 64 KiB frame, level 6 reaches 3.89× at roughly twice the CPU. The transfer
 * is the bottleneck this exists to relieve and the sender is a shared fan-out
 * pump serving every session, so the cheaper level is the right trade — the
 * remaining 7% of ratio is not worth doubling a cost that every OTHER session
 * waits behind.
 */
const COMPRESSION_LEVEL = 1;

// A DEFLATE stream can expand by roughly this factor. It sizes each input push
// so `Inflate`'s synchronous callback can reject a lie about the plaintext
// length before one push performs material work beyond the receive bound.
const DEFLATE_MAX_EXPANSION_RATIO = 1032;

/**
 * A compressed payload is `[plainLen:u32 BE][deflate bytes]`. The length
 * prefix is not redundant with the reassembler's own accounting: it is what
 * lets the receiver allocate the exact output buffer AND reject a
 * decompression bomb BEFORE inflating, rather than discovering the expansion
 * by performing it. Four bytes on a ~16 KiB compressed frame is ~0.02%.
 */
const COMPRESSED_PAYLOAD_HEADER_LEN = 4;

const BODY_HEADER_LEN = 5;
const BODY_FLAG_HAS_BINARY = 0b0000_0001;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

/** One logical outbound message, before body encoding. */
export interface OutboundMessage {
  readonly type: MuxFrameTypeValue;
  readonly streamId: number;
  readonly qos: QosClassValue;
  readonly json: Record<string, unknown> | null;
  readonly binary: Uint8Array | null;
}

/**
 * Encodes one logical message into its wire body.
 *
 * Sender-side size enforcement is honest about the platform: V8's max string
 * length sits 24 bytes UNDER {@link MAX_MUX_MESSAGE_BYTES}, so an oversized
 * JSON payload surfaces as `JSON.stringify` throwing `RangeError` here — it
 * cannot be pre-checked "before encoding". The byte check that follows covers
 * the binary-heavy path. Callers route both errors to the same per-stream
 * fatal handling.
 */
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
 * Decodes one reassembled body back into its logical json/binary halves. The
 * binary half is a VIEW into `body`, not a copy — at transfer scale a copy
 * doubles peak receive memory. Bodies are authored by the peer inside the
 * AEAD, so a malformed one is a peer bug, not line noise: it throws
 * `MuxFrameDecodeError` and gets the same connection-level fail-closed
 * handling a malformed frame does.
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

/**
 * Compresses one frame payload, or returns `null` when the frame should ride
 * uncompressed. Deliberately returns `null` rather than the input whenever
 * DEFLATE fails to shrink the payload: already-compressed content (assets,
 * images, a body that happens to be incompressible) then costs one wasted
 * pass and zero wire bytes, instead of paying a permanent tax to carry a
 * length prefix and a flag around data that got no smaller.
 */
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
 *
 * The declared plaintext length is checked against
 * {@link BULK_CHUNK_SIZE_BYTES} before a single byte is inflated, which is the
 * decompression-bomb guard: DEFLATE's maximum expansion is ~1032:1, so an
 * unbounded inflate of one legal 64 KiB frame could allocate ~66 MB, and a
 * sender that meant well never produces a payload over one chunk anyway
 * (`nextFrame` slices at exactly that bound). A peer claiming otherwise is
 * malformed, and it is rejected the same fail-closed way every other
 * structural violation on this path is.
 *
 * "Fail closed" here means the STREAM, not the session. The
 * `MuxFrameDecodeError` this throws is routed per-stream by
 * `RemoteSession.failStreamOnInboundError`, alongside `ChunkReassemblyError`:
 * by the time it can be thrown the frame header has already decoded and the
 * fault is attributable to one stream, and this function holds no state
 * between frames for a bad payload to poison. Dropping the session instead
 * would turn any deterministic mis-encode of one frame in a large transfer
 * into a reconnect loop — reconnect, re-request the same body, fail again —
 * which is the outcome the per-stream routing exists to prevent.
 *
 * The output buffer is deliberately allocated ONE BYTE LARGER than the
 * declared length. The synchronous `Inflate` callback is fed bounded slices
 * of the compressed source and stops the decoder as soon as its actual output
 * would pass the declared length. That preserves the old three-way sentinel
 * post-condition without letting `inflateSync(..., { out })` walk an attacker
 * supplied gigabyte of output merely to discover the extra byte: exact output
 * is accepted, a short expansion reports its count, and an over-expansion is
 * represented by the spare byte as `more than plainLength`.
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
      // `Inflate` calls ondata after each push, not each decoded symbol. Keep
      // one push's possible expansion inside the remaining output budget so a
      // forged small prefix cannot turn into a renderer-thread-sized inflate.
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
      // The spare byte is the old, deliberate representation for an output
      // that exceeded the declared length. The post-condition below keeps its
      // wording and accepted exact-length case unchanged.
      written = plainLength + 1;
    } else {
      throw new MuxFrameDecodeError(
        `compressed frame payload failed to inflate: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (written !== plainLength) {
    // "more than" rather than a count: the spare byte proves the payload
    // over-expanded without measuring by how much, and inventing a figure the
    // buffer never held would be worse than naming the direction.
    const actual =
      written > plainLength ? `more than ${plainLength}` : `${written}`;
    throw new MuxFrameDecodeError(
      `compressed frame inflated to ${actual} bytes, declared ${plainLength}`,
    );
  }
  return out.subarray(0, written);
}

/**
 * One queued logical message + a cursor: the scheduler's pull-based unit of
 * outbound work. Frames materialize one at a time via {@link nextFrame},
 * drawing their per-stream `seq` at pull time so interleaving with other
 * same-session messages can never allocate seqs out of send order. Chunk
 * frames reference subarray VIEWS of the encoded body, never copies.
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
   * Invoked exactly once, when the final frame is pulled — the transfer-time
   * telemetry hook for oversized bodies. Assigned after construction by the
   * owning session; `null` when nobody is watching.
   */
  onDrained: (() => void) | null = null;

  private readonly body: Uint8Array;
  private readonly nextSeq: () => number;
  private readonly compress: boolean;
  private offset = 0;

  /**
   * `compress` is the SESSION's negotiated answer, not a per-message opinion:
   * pass `true` only when the peer advertised
   * `SESSION_CAPABILITY_BODY_COMPRESSION`. A peer that did not cannot tell a
   * compressed frame from a corrupt one — `decodeMuxFrame` ignores flag bits
   * it does not know — so it would append DEFLATE bytes to its accumulator and
   * fail much later, at body decode, on a channel that is perfectly healthy.
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
   * PLAINTEXT wire size (header + payload) of the next frame this source would
   * emit — deliberately NOT the post-compression size, which is unknowable
   * until the frame is materialized.
   *
   * Every consumer of this number is a bound that compression can only make
   * safer, and keeping it plaintext keeps them all honest by the same
   * argument: the pacer over-charges (so the relay's per-session byte cap is
   * respected with more margin than before, never less), and the scheduler's
   * queued-byte accounting adds and subtracts the SAME plaintext figure, so it
   * still balances to zero. Reporting a compressed size here would break the
   * second property silently — the guard bytes would never fully drain.
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
 * Thrown specifically when the per-stream `seq` progression breaks (a relay
 * reordered or spliced mux frames). Distinguished from other
 * `ChunkReassemblyError`s so a dispatcher can tell ordering corruption from
 * structural malformation; both recover per-stream.
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

/**
 * Per-stream chunk reassembler. `accept` returns a `ReassembledMessage` once
 * a message is complete (an unchunked frame, or the final chunk of a
 * sequence), or `null` while a chunked message is still in flight.
 *
 * The total-size bound is enforced AS THE SEQUENCE ACCUMULATES — the point of
 * {@link MAX_MUX_MESSAGE_BYTES} is to stop allocating, not to describe the
 * allocation afterwards.
 */
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
    // Everything downstream — the per-message size bound, the accumulator's
    // running total, the reassembled body handed to `decodeMuxMessageBody` —
    // is then stated in plaintext bytes exactly as it was before compression
    // existed, so compression stays invisible above this line and the memory
    // bound keeps bounding the memory that is actually allocated.
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
          // Stream teardown preempts the stream's own in-flight transfer:
          // the sender cancels a queued/partially-sent message when it fails
          // or closes the stream, so its FATAL/CLOSE legitimately arrives
          // mid-sequence. Abandon the partial body and deliver the verdict.
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

  /** Number of streams with an in-flight (incomplete) chunk reassembly — observability hook (R-2, `r2-host-stream-tombstone`) used to assert no orphan accumulator survives a tombstoned stream. */
  get pendingStreamCount(): number {
    return this.accumulators.size;
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

function nextSeqValue(seq: number): number {
  return (seq + 1) % 2 ** 32;
}

/**
 * Token bucket pacing a session's outbound frames to
 * {@link CHUNK_PACE_BYTES_PER_SEC} / {@link CHUNK_PACE_FRAMES_PER_SEC}.
 * `tryConsume` gates EVERY frame — chunked and single-frame alike — because
 * the relay's per-session budget is enforced on raw frames with no class
 * distinction: an unpaced single-frame burst (live terminal output, chat
 * deltas) over the relay window gets the whole session killed, so "never
 * delay interactive" must mean "delay only by bucket refill (clock-bound,
 * ms-scale), never by the peer". Burst capacity covers any single frame, so
 * a `tryConsume(false)` is always transient. Injectable clock for tests.
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
