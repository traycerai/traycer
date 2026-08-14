import { describe, expect, it } from "vitest";
import {
  decodeMuxFrame,
  encodeMuxFrame,
  MuxFrameDecodeError,
  MuxFrameType,
  MuxMessageSizeError,
  QosClass,
} from "../mux";
import {
  BULK_CHUNK_SIZE_BYTES,
  BULK_QOS_BODY_THRESHOLD_BYTES,
  CHUNK_PACE_BURST_BYTES,
  CHUNK_PACE_BURST_FRAMES,
  CHUNK_PACE_BYTES_PER_SEC,
  CHUNK_PACE_FRAMES_PER_SEC,
  ChunkPacer,
  ChunkReassembler,
  ChunkReassemblyError,
  decodeMuxMessageBody,
  encodeMuxMessageBody,
  OutboundChunkSource,
} from "../chunking";
import { runChunkReassemblerConformanceSpec } from "./chunk-reassembler-conformance";

// The conformance spec's home run: the concrete protocol implementation must
// satisfy its own shared spec (each consumer repo re-runs the same spec
// against whatever it resolves).
runChunkReassemblerConformanceSpec(
  () => new ChunkReassembler(undefined),
  ChunkReassemblyError,
);

/** `[bodyFlags:u8][jsonLen:u32 BE][jsonBytes][binaryBytes]` — see `chunking.ts`. */
const BODY_HEADER_LEN = 5;
const BODY_FLAG_HAS_BINARY = 0b0000_0001;

function bodyJsonLen(body: Uint8Array): number {
  return new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(
    1,
  );
}

describe("encodeMuxMessageBody / decodeMuxMessageBody body codec edge cases", () => {
  it("round-trips a json-only body (binary: null)", () => {
    const json = { kind: "json-only", n: 1 };
    const body = encodeMuxMessageBody(json, null);
    expect(body[0] & BODY_FLAG_HAS_BINARY).toBe(0);
    expect(bodyJsonLen(body)).toBeGreaterThan(0);

    const decoded = decodeMuxMessageBody(body);
    expect(decoded.json).toEqual(json);
    expect(decoded.binary).toBeNull();
  });

  it("round-trips a binary-only body (json: null)", () => {
    const binary = new Uint8Array([9, 8, 7, 6, 5]);
    const body = encodeMuxMessageBody(null, binary);
    expect(body[0] & BODY_FLAG_HAS_BINARY).toBe(BODY_FLAG_HAS_BINARY);
    expect(bodyJsonLen(body)).toBe(0);

    const decoded = decodeMuxMessageBody(body);
    expect(decoded.json).toBeNull();
    expect(decoded.binary).toEqual(binary);
  });

  it("round-trips a fully empty body (json: null, binary: null)", () => {
    const body = encodeMuxMessageBody(null, null);
    expect(body.length).toBe(BODY_HEADER_LEN);
    expect(body[0]).toBe(0);
    expect(bodyJsonLen(body)).toBe(0);

    const decoded = decodeMuxMessageBody(body);
    expect(decoded.json).toBeNull();
    expect(decoded.binary).toBeNull();
  });

  it("rejects a body with an unknown bodyFlags bit set", () => {
    const body = new Uint8Array(BODY_HEADER_LEN);
    body[0] = 0b0000_0010; // unknown bit; only bit 0 (HAS_BINARY) is defined
    expect(() => decodeMuxMessageBody(body)).toThrow(MuxFrameDecodeError);
  });

  it("rejects a body whose declared jsonLen exceeds the bytes actually present", () => {
    const body = new Uint8Array(BODY_HEADER_LEN);
    body[0] = 0;
    new DataView(body.buffer).setUint32(1, 10); // claims 10 json bytes, body has 0
    expect(() => decodeMuxMessageBody(body)).toThrow(MuxFrameDecodeError);
  });
});

describe("OutboundChunkSource BULK QoS override at the exact body-size threshold", () => {
  function sourceWithBinaryBytes(binaryLen: number): OutboundChunkSource {
    let seq = 0;
    return new OutboundChunkSource(
      {
        type: MuxFrameType.STREAM_FRAME,
        streamId: 1,
        qos: QosClass.INTERACTIVE,
        json: null,
        binary: new Uint8Array(binaryLen),
      },
      () => seq++,
    );
  }

  it("keeps the requested class when the body is exactly at the threshold", () => {
    const binaryLen = BULK_QOS_BODY_THRESHOLD_BYTES - BODY_HEADER_LEN;
    const source = sourceWithBinaryBytes(binaryLen);
    expect(source.totalBodyBytes).toBe(BULK_QOS_BODY_THRESHOLD_BYTES);
    expect(source.qos).toBe(QosClass.INTERACTIVE);
  });

  it("overrides to BULK when the body is one byte over the threshold", () => {
    const binaryLen = BULK_QOS_BODY_THRESHOLD_BYTES - BODY_HEADER_LEN + 1;
    const source = sourceWithBinaryBytes(binaryLen);
    expect(source.totalBodyBytes).toBe(BULK_QOS_BODY_THRESHOLD_BYTES + 1);
    expect(source.qos).toBe(QosClass.BULK);
  });
});

describe("ChunkReassembler accumulation cap failing mid-sequence", () => {
  it("accepts the first chunk, throws MuxMessageSizeError on a later chunk, and clears the failed accumulator", () => {
    // Cap sits above one chunk (BULK_CHUNK_SIZE_BYTES) but below two, so the
    // first CHUNK_FIRST frame is accepted and only the second chunk trips it.
    const smallCapBytes = BULK_CHUNK_SIZE_BYTES + 1024;
    const reassembler = new ChunkReassembler(smallCapBytes);

    // A body spanning 3+ chunks so there is a "later chunk" to trip the cap.
    const binary = new Uint8Array(BULK_CHUNK_SIZE_BYTES * 3 + 500).fill(1);
    let seq = 0;
    const source = new OutboundChunkSource(
      {
        type: MuxFrameType.STREAM_FRAME,
        streamId: 42,
        qos: QosClass.BULK,
        json: null,
        binary,
      },
      () => seq++,
    );
    expect(source.chunked).toBe(true);

    const firstFrame = decodeMuxFrame(encodeMuxFrame(source.nextFrame()));
    expect(firstFrame.chunkFirst).toBe(true);
    expect(reassembler.accept(firstFrame)).toBeNull();

    const secondFrame = decodeMuxFrame(encodeMuxFrame(source.nextFrame()));
    expect(() => reassembler.accept(secondFrame)).toThrow(MuxMessageSizeError);

    // The failed sequence's accumulator state was actually removed: a fresh
    // chunkFirst frame on the SAME streamId is accepted (returns null)
    // rather than throwing "sequence already in flight".
    const freshFirstFrame = decodeMuxFrame(
      encodeMuxFrame({
        type: MuxFrameType.STREAM_FRAME,
        streamId: 42,
        seq: 999,
        qos: QosClass.BULK,
        chunked: true,
        chunkFirst: true,
        chunkLast: false,
        json: null,
        binary: new Uint8Array([1, 2, 3]),
      }),
    );
    expect(reassembler.accept(freshFirstFrame)).toBeNull();
  });
});

describe("ChunkPacer stays within its per-second budget under a fake clock", () => {
  it("never lets any rolling 1s window exceed rate + burst for bytes or frames", () => {
    let nowMs = 0;
    const pacer = new ChunkPacer(() => nowMs);

    const events: Array<{ t: number; bytes: number }> = [];
    const frameSizes = [100, 500, 1500, 4000, 9000];
    let frameSizeIndex = 0;

    const totalDurationMs = 3000;
    const stepMs = 1;
    for (; nowMs <= totalDurationMs; nowMs += stepMs) {
      // Drain as many frames as the bucket allows at this instant, the way a
      // real scheduler pulling from a saturated queue would.
      for (;;) {
        const frameBytes = frameSizes[frameSizeIndex % frameSizes.length];
        if (!pacer.tryConsume(frameBytes)) {
          break;
        }
        events.push({ t: nowMs, bytes: frameBytes });
        frameSizeIndex++;
      }
    }

    expect(events.length).toBeGreaterThan(0);

    // For every event's timestamp, sum bytes/frames of all events within the
    // following 1s window and assert the token-bucket's rate+burst bound.
    for (const anchor of events) {
      const windowEnd = anchor.t + 1000;
      const windowEvents = events.filter(
        (e) => e.t >= anchor.t && e.t < windowEnd,
      );
      const byteSum = windowEvents.reduce((sum, e) => sum + e.bytes, 0);
      const frameSum = windowEvents.length;
      expect(byteSum).toBeLessThanOrEqual(
        CHUNK_PACE_BYTES_PER_SEC + CHUNK_PACE_BURST_BYTES,
      );
      expect(frameSum).toBeLessThanOrEqual(
        CHUNK_PACE_FRAMES_PER_SEC + CHUNK_PACE_BURST_FRAMES,
      );
    }
  });

  it("frame-token exhaustion paces out the next frame regardless of its size", () => {
    const nowMs = 0;
    const pacer = new ChunkPacer(() => nowMs);

    // Tiny frames spend the whole frame-token burst without denting the byte
    // budget - the frame dimension alone must then pace the bucket out.
    for (let i = 0; i < CHUNK_PACE_BURST_FRAMES; i++) {
      expect(pacer.tryConsume(1)).toBe(true);
    }
    expect(pacer.tryConsume(1)).toBe(false);
  });

  it("byte-budget exhaustion paces out a frame while frame tokens remain", () => {
    const nowMs = 0;
    const pacer = new ChunkPacer(() => nowMs);

    // One consume drains the byte burst almost entirely, using a single frame
    // token - the byte dimension alone must then pace the next frame out.
    expect(pacer.tryConsume(CHUNK_PACE_BURST_BYTES - 1)).toBe(true);
    expect(pacer.tryConsume(2)).toBe(false);
  });
});
