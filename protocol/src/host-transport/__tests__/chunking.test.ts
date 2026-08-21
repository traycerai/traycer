import { deflateSync, Inflate, inflateSync } from "fflate";
import { describe, expect, it, vi } from "vitest";

vi.mock("fflate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fflate")>();
  return {
    ...actual,
    inflateSync: vi.fn(actual.inflateSync),
  };
});
import {
  decodeMuxFrame,
  encodeMuxFrame,
  type MuxFrame,
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
  COMPRESSION_MIN_PAYLOAD_BYTES,
  decodeMuxMessageBody,
  encodeMuxMessageBody,
  type ReassembledMessage,
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
      false,
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
      false,
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
        compressed: false,
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

describe("body compression round-trip (T5)", () => {
  function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) {
      return false;
    }
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] !== b[i]) {
        return false;
      }
    }
    return true;
  }

  function concatBytes(...parts: Uint8Array[]): Uint8Array {
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }

  function randomBytes(length: number): Uint8Array {
    const out = new Uint8Array(length);
    for (let i = 0; i < out.length; i += 1) {
      out[i] = Math.floor(Math.random() * 256);
    }
    return out;
  }

  /** Drains a source through the wire (encode/decode) into a fresh reassembler; returns every decoded frame plus the completed message. */
  function drainThroughWire(source: OutboundChunkSource): {
    readonly frames: MuxFrame[];
    readonly message: ReassembledMessage | null;
  } {
    const reassembler = new ChunkReassembler(undefined);
    const frames: MuxFrame[] = [];
    let message: ReassembledMessage | null = null;
    while (!source.done) {
      const decoded = decodeMuxFrame(encodeMuxFrame(source.nextFrame()));
      frames.push(decoded);
      const out = reassembler.accept(decoded);
      if (out !== null) {
        message = out;
      }
    }
    return { frames, message };
  }

  it("OutboundChunkSource with compress: false never sets compressed, whatever the body (B2)", () => {
    const bodies = [
      new Uint8Array(COMPRESSION_MIN_PAYLOAD_BYTES - 100), // under threshold
      new Uint8Array(BULK_CHUNK_SIZE_BYTES * 3).fill(0x41), // large, highly compressible
      randomBytes(BULK_CHUNK_SIZE_BYTES * 2), // large, incompressible
    ];
    for (const binary of bodies) {
      let seq = 0;
      const source = new OutboundChunkSource(
        { type: MuxFrameType.STREAM_FRAME, streamId: 1, qos: QosClass.BULK, json: null, binary },
        () => seq++,
        false,
      );
      const { frames } = drainThroughWire(source);
      expect(frames.length).toBeGreaterThan(0);
      expect(frames.every((f) => !f.compressed)).toBe(true);
    }
  });

  it("a body over one 64 KiB chunk, compressed, reassembles byte-identical to the uncompressed path", () => {
    // Highly compressible, multi-chunk binary content.
    const binary = new Uint8Array(BULK_CHUNK_SIZE_BYTES * 3 + 777).fill(0x41);
    const json = { kind: "snapshot", note: "compression round-trip" };
    let seqA = 0;
    let seqB = 0;
    const compressed = new OutboundChunkSource(
      { type: MuxFrameType.STREAM_FRAME, streamId: 1, qos: QosClass.BULK, json, binary },
      () => seqA++,
      true,
    );
    const plain = new OutboundChunkSource(
      { type: MuxFrameType.STREAM_FRAME, streamId: 1, qos: QosClass.BULK, json, binary },
      () => seqB++,
      false,
    );
    expect(compressed.chunked).toBe(true);

    const compressedResult = drainThroughWire(compressed);
    const plainResult = drainThroughWire(plain);

    expect(compressedResult.message).not.toBeNull();
    expect(plainResult.message).not.toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const c = compressedResult.message!;
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const p = plainResult.message!;
    expect(c.json).toEqual(p.json);
    expect(c.json).toEqual(json);
    expect(c.binary).not.toBeNull();
    expect(p.binary).not.toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(bytesEqual(c.binary!, p.binary!)).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(bytesEqual(c.binary!, binary)).toBe(true);
  });

  it("emits at least one frame with compressed === true and a payload smaller than the plaintext slice, for compressible content", () => {
    const binary = new Uint8Array(BULK_CHUNK_SIZE_BYTES * 2).fill(0x42);
    let seq = 0;
    const source = new OutboundChunkSource(
      { type: MuxFrameType.STREAM_FRAME, streamId: 2, qos: QosClass.BULK, json: null, binary },
      () => seq++,
      true,
    );
    const { frames } = drainThroughWire(source);
    const compressedFrames = frames.filter((f) => f.compressed);
    expect(compressedFrames.length).toBeGreaterThan(0);
    for (const frame of compressedFrames) {
      expect(frame.binary).not.toBeNull();
      // A full 64 KiB chunk of a single repeated byte compresses to far less
      // than the plaintext slice it carries.
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(frame.binary!.length).toBeLessThan(BULK_CHUNK_SIZE_BYTES);
    }
  });

  it("incompressible (random) content emits compressed === false and still reassembles byte-identical", () => {
    const binary = randomBytes(BULK_CHUNK_SIZE_BYTES * 2 + 100);
    let seq = 0;
    const source = new OutboundChunkSource(
      { type: MuxFrameType.STREAM_FRAME, streamId: 3, qos: QosClass.BULK, json: null, binary },
      () => seq++,
      true,
    );
    const { frames, message } = drainThroughWire(source);
    expect(frames.some((f) => f.compressed)).toBe(false);
    expect(message).not.toBeNull();
    expect(message?.binary).not.toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(bytesEqual(message!.binary!, binary)).toBe(true);
  });

  it("a payload under COMPRESSION_MIN_PAYLOAD_BYTES is never compressed, even with compression negotiated", () => {
    // -10 (not -1): the body carries a 5-byte header alongside the binary, so
    // the actual FRAME payload is binary.length + 5 - stay comfortably under
    // the threshold rather than at its edge.
    const binary = new Uint8Array(COMPRESSION_MIN_PAYLOAD_BYTES - 10).fill(
      0x41,
    );
    let seq = 0;
    const source = new OutboundChunkSource(
      { type: MuxFrameType.STREAM_FRAME, streamId: 4, qos: QosClass.INTERACTIVE, json: null, binary },
      () => seq++,
      true,
    );
    expect(source.chunked).toBe(false);
    const { frames } = drainThroughWire(source);
    expect(frames).toHaveLength(1);
    expect(frames[0].compressed).toBe(false);
  });

  it("a sequence that mixes compressed and uncompressed frames reassembles correctly - a real wire state, since the sender decides per frame", () => {
    const compressiblePart = new Uint8Array(
      Math.floor(BULK_CHUNK_SIZE_BYTES * 1.5),
    ).fill(0x43);
    const incompressiblePart = randomBytes(
      Math.floor(BULK_CHUNK_SIZE_BYTES * 1.5),
    );
    const binary = concatBytes(compressiblePart, incompressiblePart);
    let seq = 0;
    const source = new OutboundChunkSource(
      { type: MuxFrameType.STREAM_FRAME, streamId: 5, qos: QosClass.BULK, json: null, binary },
      () => seq++,
      true,
    );
    const { frames, message } = drainThroughWire(source);
    expect(frames.some((f) => f.compressed)).toBe(true);
    expect(frames.some((f) => !f.compressed)).toBe(true);
    expect(message).not.toBeNull();
    expect(message?.binary).not.toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(bytesEqual(message!.binary!, binary)).toBe(true);
  });

  describe("decompression bomb guard", () => {
    it("rejects an under-declared compressed bomb before entering fflate's full synchronous inflater", () => {
      // The header is peer-controlled, so it must not be the only output
      // bound. `inflateSync(..., { out })` truncates writes but still walks the
      // entire DEFLATE stream first; a small fixture proves we reject before
      // paying that unbounded work without putting a gigabyte-scale bomb in CI.
      const actualPlainLength = 4 * 1024 * 1024;
      const declaredPlainLength = 1;
      const deflated = deflateSync(new Uint8Array(actualPlainLength), {
        level: 6,
      });
      const header = new Uint8Array(4);
      new DataView(header.buffer).setUint32(0, declaredPlainLength);
      const frame = decodeMuxFrame(
        encodeMuxFrame({
          type: MuxFrameType.STREAM_FRAME,
          streamId: 6,
          seq: 0,
          qos: QosClass.BULK,
          chunked: false,
          chunkFirst: false,
          chunkLast: false,
          compressed: true,
          json: null,
          binary: concatBytes(header, deflated),
        }),
      );
      const reassembler = new ChunkReassembler(undefined);

      vi.mocked(inflateSync).mockClear();
      const push = vi.spyOn(Inflate.prototype, "push");
      try {
        const acceptBomb = (): void => {
          reassembler.accept(frame);
        };
        expect(acceptBomb).toThrow(MuxFrameDecodeError);
        expect(acceptBomb).toThrow(
          "compressed frame inflated to more than 1 bytes, declared 1",
        );
        expect(inflateSync).not.toHaveBeenCalled();
        // An unbounded `Inflate.push(deflated, true)` calls its callback only
        // after all 4 MiB of output; the forged one-byte declaration permits
        // only one compressed byte per push before that callback is checked.
        expect(Math.max(...push.mock.calls.map((args) => args[0].length))).toBe(
          1,
        );
      } finally {
        push.mockRestore();
      }
    });

    it("throws MuxFrameDecodeError for a GENUINELY oversized declared plaintext length - a real, validly-deflated payload that would successfully inflate past BULK_CHUNK_SIZE_BYTES if the bound were not checked first", () => {
      // A real decompression bomb: highly compressible content that deflates
      // small but declares (and would genuinely inflate to) well over the
      // per-chunk bound. Using GARBAGE bytes here instead would let this test
      // pass for the wrong reason (inflate itself throwing on invalid deflate
      // data), masking a missing length check - it must be real deflate data
      // that WOULD succeed were the bound not enforced first.
      const oversizedPlainLength = BULK_CHUNK_SIZE_BYTES * 4;
      const deflated = deflateSync(new Uint8Array(oversizedPlainLength).fill(0), {
        level: 6,
      });
      const header = new Uint8Array(4);
      new DataView(header.buffer).setUint32(0, oversizedPlainLength);
      const badPayload = concatBytes(header, deflated);
      const frame = decodeMuxFrame(
        encodeMuxFrame({
          type: MuxFrameType.STREAM_FRAME,
          streamId: 6,
          seq: 0,
          qos: QosClass.BULK,
          chunked: false,
          chunkFirst: false,
          chunkLast: false,
          compressed: true,
          json: null,
          binary: badPayload,
        }),
      );
      const reassembler = new ChunkReassembler(undefined);
      expect(() => reassembler.accept(frame)).toThrow(MuxFrameDecodeError);
    });

    it("throws MuxFrameDecodeError on a truncated/garbage deflate payload with a valid declared length", () => {
      const header = new Uint8Array(4);
      new DataView(header.buffer).setUint32(0, 10); // plausible, under the bound
      const garbage = new Uint8Array([0xff, 0xff, 0xff, 0xff]); // not valid deflate
      const badPayload = concatBytes(header, garbage);
      const frame = decodeMuxFrame(
        encodeMuxFrame({
          type: MuxFrameType.STREAM_FRAME,
          streamId: 7,
          seq: 0,
          qos: QosClass.BULK,
          chunked: false,
          chunkFirst: false,
          chunkLast: false,
          compressed: true,
          json: null,
          binary: badPayload,
        }),
      );
      const reassembler = new ChunkReassembler(undefined);
      expect(() => reassembler.accept(frame)).toThrow(MuxFrameDecodeError);
    });
  });

  /**
   * The declared `plainLen` prefix is only a real check if it is compared
   * against the bytes the inflater ACTUALLY produced. Both directions are
   * pinned here because they fail differently and only one of them was ever
   * caught: an over-declaring payload ends short and is rejected on length,
   * while an under-declaring one silently loses its tail — the inflater drops
   * the writes that fall past the output buffer and reports a count clamped to
   * that buffer, so a corrupt body sails through and is DELIVERED.
   *
   * A valid encoded body is used as the plaintext rather than loose bytes so
   * the failure is the one that matters: a truncated body still decodes, so
   * without this check the receiver hands its dispatcher a message whose binary
   * section is quietly one byte short of what the sender wrote.
   */
  describe("declared plaintext length vs the ACTUAL inflated size", () => {
    const plainBody = encodeMuxMessageBody(
      null,
      new Uint8Array(8192).fill(0x2a),
    );

    function compressedFrame(
      streamId: number,
      declaredPlainLength: number,
    ): MuxFrame {
      const header = new Uint8Array(4);
      new DataView(header.buffer).setUint32(0, declaredPlainLength);
      return decodeMuxFrame(
        encodeMuxFrame({
          type: MuxFrameType.STREAM_FRAME,
          streamId,
          seq: 0,
          qos: QosClass.BULK,
          chunked: false,
          chunkFirst: false,
          chunkLast: false,
          compressed: true,
          json: null,
          binary: concatBytes(
            header,
            deflateSync(plainBody, { level: 1 }),
          ),
        }),
      );
    }

    it("rejects a payload that inflates to MORE bytes than it declared, rather than delivering the truncated prefix", () => {
      const reassembler = new ChunkReassembler(undefined);
      expect(() =>
        reassembler.accept(compressedFrame(11, plainBody.length - 1)),
      ).toThrow(MuxFrameDecodeError);
    });

    it("rejects a payload that inflates to FEWER bytes than it declared", () => {
      const reassembler = new ChunkReassembler(undefined);
      expect(() =>
        reassembler.accept(compressedFrame(12, plainBody.length + 1)),
      ).toThrow(MuxFrameDecodeError);
    });
  });
});
