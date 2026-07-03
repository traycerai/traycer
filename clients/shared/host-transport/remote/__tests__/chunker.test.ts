import { describe, expect, it } from "vitest";
import {
  ChunkReassemblyError,
  ChunkReassembler,
  chunkOutboundMessage,
  type OutboundMessage,
  type ReassembledMessage,
} from "../chunker";
import {
  decodeMuxFrame,
  type EncodeMuxFrameInput,
  encodeMuxFrame,
  MAX_MUX_FRAME_BYTES,
  MuxFrameSizeError,
  MuxFrameType,
  QosClass,
} from "@traycer/protocol/host-transport/mux";
import { BULK_CHUNK_SIZE_BYTES } from "../config";

function seqCounter(): () => number {
  let n = 0;
  return () => n++;
}

function throughCodec(input: EncodeMuxFrameInput) {
  return decodeMuxFrame(encodeMuxFrame(input));
}

describe("chunker", () => {
  it("emits a single unchunked frame for a small binary", () => {
    const message: OutboundMessage = {
      type: MuxFrameType.STREAM_FRAME,
      streamId: 1,
      qos: QosClass.INTERACTIVE,
      json: { kind: "data", hasBinaryPayload: true },
      binary: new Uint8Array([1, 2, 3]),
    };
    const frames = chunkOutboundMessage(message, seqCounter());
    expect(frames).toHaveLength(1);
    expect(frames[0].chunked).toBe(false);
  });

  it("splits a >64 KiB binary at the chunk boundary, json on the first only", () => {
    const total = BULK_CHUNK_SIZE_BYTES * 2 + 500;
    const binary = new Uint8Array(total).map((_, i) => i % 251);
    const message: OutboundMessage = {
      type: MuxFrameType.STREAM_FRAME,
      streamId: 4,
      qos: QosClass.BULK,
      json: { kind: "data", hasBinaryPayload: true },
      binary,
    };
    const frames = chunkOutboundMessage(message, seqCounter());
    expect(frames).toHaveLength(3);
    expect(frames[0].chunked).toBe(true);
    expect(frames[0].json).not.toBeNull();
    expect(frames[1].json).toBeNull();
    expect(frames[2].chunkLast).toBe(true);
    for (const frame of frames.slice(0, 2)) {
      expect(frame.binary?.length).toBe(BULK_CHUNK_SIZE_BYTES);
    }
    expect(frames[2].binary?.length).toBe(500);
  });

  it("reassembles chunked frames back to the original binary + json", () => {
    const total = BULK_CHUNK_SIZE_BYTES * 3 + 17;
    const binary = new Uint8Array(total).map((_, i) => (i * 7) % 253);
    const message: OutboundMessage = {
      type: MuxFrameType.STREAM_FRAME,
      streamId: 5,
      qos: QosClass.BULK,
      json: { kind: "snapshot", hasBinaryPayload: true },
      binary,
    };
    const frames = chunkOutboundMessage(message, seqCounter());
    const reassembler = new ChunkReassembler();
    let completed: ReassembledMessage | null = null;
    for (const input of frames) {
      // Serialize through the codec so the test exercises the real wire bytes.
      const out = reassembler.accept(throughCodec(input));
      if (out !== null) {
        completed = out;
      }
    }
    expect(completed).not.toBeNull();
    expect(completed?.json).toEqual({
      kind: "snapshot",
      hasBinaryPayload: true,
    });
    expect(completed?.binary).toEqual(binary);
  });

  it("passes an unchunked frame straight through the reassembler", () => {
    const reassembler = new ChunkReassembler();
    const decoded = decodeMuxFrame(
      encodeMuxFrame({
        type: MuxFrameType.RESPONSE,
        streamId: 9,
        seq: 0,
        qos: QosClass.INTERACTIVE,
        chunked: false,
        chunkLast: false,
        json: { requestId: "r", method: "m", result: 1, error: null },
        binary: null,
      }),
    );
    const out = reassembler.accept(decoded);
    expect(out?.json).toEqual({
      requestId: "r",
      method: "m",
      result: 1,
      error: null,
    });
  });

  it("rejects a continuation chunk that arrives without its first envelope", () => {
    const binary = new Uint8Array(BULK_CHUNK_SIZE_BYTES + 1);
    const frames = chunkOutboundMessage(
      {
        type: MuxFrameType.STREAM_FRAME,
        streamId: 6,
        qos: QosClass.BULK,
        json: { kind: "snapshot", hasBinaryPayload: true },
        binary,
      },
      seqCounter(),
    );
    const reassembler = new ChunkReassembler();

    expect(() => reassembler.accept(throughCodec(frames[1]))).toThrow(
      ChunkReassemblyError,
    );
  });

  it("rejects interleaved chunked messages on the same stream fail-closed", () => {
    const nextSeq = seqCounter();
    const first = chunkOutboundMessage(
      {
        type: MuxFrameType.STREAM_FRAME,
        streamId: 7,
        qos: QosClass.BULK,
        json: { kind: "first", hasBinaryPayload: true },
        binary: new Uint8Array(BULK_CHUNK_SIZE_BYTES + 1),
      },
      nextSeq,
    );
    const second = chunkOutboundMessage(
      {
        type: MuxFrameType.STREAM_FRAME,
        streamId: 7,
        qos: QosClass.BULK,
        json: { kind: "second", hasBinaryPayload: true },
        binary: new Uint8Array(BULK_CHUNK_SIZE_BYTES + 1),
      },
      nextSeq,
    );
    const reassembler = new ChunkReassembler();

    expect(reassembler.accept(throughCodec(first[0]))).toBeNull();
    expect(() => reassembler.accept(throughCodec(second[0]))).toThrow(
      ChunkReassemblyError,
    );
    expect(() => reassembler.accept(throughCodec(first[1]))).toThrow(
      ChunkReassemblyError,
    );
  });

  it("rejects out-of-order chunks on a stream instead of splicing payloads", () => {
    const binary = new Uint8Array(BULK_CHUNK_SIZE_BYTES * 2 + 1);
    const frames = chunkOutboundMessage(
      {
        type: MuxFrameType.STREAM_FRAME,
        streamId: 8,
        qos: QosClass.BULK,
        json: { kind: "snapshot", hasBinaryPayload: true },
        binary,
      },
      seqCounter(),
    );
    const reassembler = new ChunkReassembler();

    expect(reassembler.accept(throughCodec(frames[0]))).toBeNull();
    expect(() => reassembler.accept(throughCodec(frames[2]))).toThrow(
      ChunkReassemblyError,
    );
  });

  it("fails fast when an unchunked json-only message exceeds the frame cap", () => {
    expect(() =>
      chunkOutboundMessage(
        {
          type: MuxFrameType.REQUEST,
          streamId: 11,
          qos: QosClass.INTERACTIVE,
          json: { payload: "x".repeat(MAX_MUX_FRAME_BYTES) },
          binary: null,
        },
        seqCounter(),
      ),
    ).toThrow(MuxFrameSizeError);
  });

  it("fails fast when the first chunk would exceed the frame cap", () => {
    expect(() =>
      chunkOutboundMessage(
        {
          type: MuxFrameType.STREAM_FRAME,
          streamId: 12,
          qos: QosClass.BULK,
          json: { payload: "x".repeat(MAX_MUX_FRAME_BYTES) },
          binary: new Uint8Array(BULK_CHUNK_SIZE_BYTES + 1),
        },
        seqCounter(),
      ),
    ).toThrow(MuxFrameSizeError);
  });
});
