import { BULK_CHUNK_SIZE_BYTES } from "./config";
import {
  assertMuxFrameFits,
  type EncodeMuxFrameInput,
  MuxFrameType,
  type MuxFrame,
  type MuxFrameTypeValue,
  type QosClassValue,
} from "@traycer/protocol/host-transport/mux";

/**
 * 64 KiB bulk chunking + reassembly (Architecture §3, audit C2).
 *
 * Only the binary section is split — json envelopes/params are bounded metadata
 * and ride whole on the first chunk. Splitting the binary is what lets the
 * priority scheduler slip an interactive keystroke between two bulk chunks so a
 * keystroke never queues behind a megabyte frame.
 *
 * Chunk-sequence flags:
 *   - unchunked (binary fits one frame): `chunked=false`.
 *   - chunked: every frame `chunked=true`; only the final frame `chunkLast=true`.
 *     The first frame carries the json envelope; continuation frames carry
 *     `json=null`. Raw WS FIFO is still the adjacency source; the reassembler
 *     additionally validates the per-stream `seq` progression so scheduler
 *     interleaving cannot splice two logical frames into one corrupt payload.
 */

export interface OutboundMessage {
  readonly type: MuxFrameTypeValue;
  readonly streamId: number;
  readonly qos: QosClassValue;
  readonly json: Record<string, unknown> | null;
  readonly binary: Uint8Array | null;
}

/**
 * Splits an outbound logical message into one or more `EncodeMuxFrameInput`s,
 * drawing a fresh per-stream `seq` for each frame. A message whose binary fits
 * in one chunk yields a single unchunked frame.
 */
export function chunkOutboundMessage(
  message: OutboundMessage,
  nextSeq: () => number,
): EncodeMuxFrameInput[] {
  const binary = message.binary;
  if (binary === null || binary.length <= BULK_CHUNK_SIZE_BYTES) {
    const frame = {
      type: message.type,
      streamId: message.streamId,
      seq: nextSeq(),
      qos: message.qos,
      chunked: false,
      chunkLast: false,
      json: message.json,
      binary,
    };
    assertMuxFrameFits(frame);
    return [frame];
  }

  const frames: EncodeMuxFrameInput[] = [];
  let offset = 0;
  let first = true;
  while (offset < binary.length) {
    const end = Math.min(offset + BULK_CHUNK_SIZE_BYTES, binary.length);
    const slice = binary.slice(offset, end);
    const isLast = end >= binary.length;
    const frame = {
      type: message.type,
      streamId: message.streamId,
      seq: nextSeq(),
      qos: message.qos,
      chunked: true,
      chunkLast: isLast,
      json: first ? message.json : null,
      binary: slice,
    };
    assertMuxFrameFits(frame);
    frames.push(frame);
    offset = end;
    first = false;
  }
  return frames;
}

/**
 * A fully reassembled logical message handed up to the session dispatcher.
 */
export interface ReassembledMessage {
  readonly type: MuxFrameTypeValue;
  readonly streamId: number;
  readonly json: Record<string, unknown> | null;
  readonly binary: Uint8Array | null;
}

/** Thrown when a chunk sequence is malformed (fail-closed). */
export class ChunkReassemblyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChunkReassemblyError";
  }
}

interface StreamAccumulator {
  readonly type: MuxFrameTypeValue;
  readonly json: Record<string, unknown> | null;
  readonly startSeq: number;
  readonly slices: Uint8Array[];
  totalLength: number;
  nextSeq: number;
}

/**
 * Per-stream chunk reassembler. `accept` returns a `ReassembledMessage` once a
 * message is complete (either an unchunked frame or the final chunk), or `null`
 * while a chunked message is still in flight.
 */
export class ChunkReassembler {
  private readonly accumulators = new Map<number, StreamAccumulator>();

  accept(frame: MuxFrame): ReassembledMessage | null {
    if (!frame.chunked) {
      if (this.accumulators.has(frame.streamId)) {
        throw new ChunkReassemblyError(
          `unchunked frame on stream ${frame.streamId} during in-flight chunk sequence`,
        );
      }
      return {
        type: frame.type,
        streamId: frame.streamId,
        json: frame.json,
        binary: frame.binary,
      };
    }

    const existing = this.accumulators.get(frame.streamId);
    if (existing === undefined) {
      if (frame.json === null) {
        throw new ChunkReassemblyError(
          `chunk continuation on stream ${frame.streamId} without a starting envelope`,
        );
      }
      const accumulator = {
        type: frame.type,
        json: frame.json,
        startSeq: frame.seq,
        slices: [],
        totalLength: 0,
        nextSeq: nextSeqValue(frame.seq),
      };
      this.acceptChunk(frame, accumulator);
      this.accumulators.set(frame.streamId, accumulator);
      if (!frame.chunkLast) {
        return null;
      }
      this.accumulators.delete(frame.streamId);
      return {
        type: accumulator.type,
        streamId: frame.streamId,
        json: accumulator.json,
        binary: concat(accumulator.slices, accumulator.totalLength),
      };
    }

    if (frame.json !== null) {
      this.accumulators.delete(frame.streamId);
      throw new ChunkReassemblyError(
        `new chunk sequence on stream ${frame.streamId} before sequence ${existing.startSeq} completed`,
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
      throw new ChunkReassemblyError(
        `chunk sequence mismatch on stream ${frame.streamId}: expected ${existing.nextSeq}, received ${frame.seq}`,
      );
    }

    this.acceptChunk(frame, existing);
    if (!frame.chunkLast) {
      return null;
    }
    this.accumulators.delete(frame.streamId);
    return {
      type: existing.type,
      streamId: frame.streamId,
      json: existing.json,
      binary: concat(existing.slices, existing.totalLength),
    };
  }

  /** Drops any partial reassembly (called when a stream/session resets). */
  reset(): void {
    this.accumulators.clear();
  }

  private acceptChunk(frame: MuxFrame, accumulator: StreamAccumulator): void {
    if (frame.binary === null) {
      this.accumulators.delete(frame.streamId);
      throw new ChunkReassemblyError(
        `chunked frame on stream ${frame.streamId} has no binary payload`,
      );
    }
    accumulator.slices.push(frame.binary);
    accumulator.totalLength += frame.binary.length;
    accumulator.nextSeq = nextSeqValue(frame.seq);
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
 * Frame types that carry a bulk-chunkable binary payload. Control/session
 * frames are never chunked (they are small); this is exported so the session
 * dispatcher and tests share one definition.
 */
export const CHUNKABLE_FRAME_TYPES: ReadonlySet<MuxFrameTypeValue> = new Set([
  MuxFrameType.STREAM_FRAME,
  MuxFrameType.RESPONSE,
]);
