import { describe, expect, it } from "vitest";
import {
  ChunkReassemblyError,
  ChunkReassembler,
  chunkOutboundMessage,
  type OutboundMessage,
} from "../chunker";
import {
  MAX_MUX_FRAME_BYTES,
  MuxFrameSizeError,
  MuxFrameType,
  QosClass,
} from "@traycer/protocol/host-transport/mux";
import { runChunkReassemblerConformanceSpec } from "@traycer/protocol/host-transport/__tests__/chunk-reassembler-conformance";
import { BULK_CHUNK_SIZE_BYTES } from "../config";

// Architecture §4 fix #1 (S3): the same conformance cases run against the
// host's `ChunkReassembler` (`traycer-host/src/transport/remote/__tests__/chunker.test.ts`)
// - proving the two truly mirror instead of silently diverging again.
runChunkReassemblerConformanceSpec(
  () => new ChunkReassembler(),
  ChunkReassemblyError,
);

function seqCounter(): () => number {
  let n = 0;
  return () => n++;
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
