import { describe, expect, it } from "vitest";
import {
  decodeMuxFrame,
  encodeMuxFrame,
  type EncodeMuxFrameInput,
  type MuxFrame,
  MuxFrameType,
  QosClass,
} from "../mux";
import {
  BULK_CHUNK_SIZE_BYTES,
  encodeMuxMessageBody,
  OutboundChunkSource,
  type ReassembledMessage,
} from "../chunking";

/**
 * Structural shape of the reassembler under test. The implementation now
 * lives HERE in `@traycer/protocol` (the two hand-mirrored transport copies
 * were collapsed after they diverged once already), but the spec stays
 * factory-shaped so each consumer's own test file can keep running it against
 * whatever it actually imports — the "guard for the guard" (Architecture §4
 * fix #1 / S3).
 */
export interface ChunkReassemblerLike {
  accept(frame: MuxFrame): ReassembledMessage | null;
  reset(): void;
}

function frame(overrides: Partial<EncodeMuxFrameInput>): MuxFrame {
  const input: EncodeMuxFrameInput = {
    type: MuxFrameType.STREAM_FRAME,
    streamId: 1,
    seq: 0,
    qos: QosClass.BULK,
    chunked: true,
    chunkFirst: false,
    chunkLast: false,
    compressed: false,
    json: null,
    binary: new Uint8Array([1]),
    ...overrides,
  };
  return decodeMuxFrame(encodeMuxFrame(input));
}

/** Splits an encoded body the way a chunk source would, at `chunkSize`. */
function bodyChunks(body: Uint8Array, chunkSize: number): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < body.length; offset += chunkSize) {
    chunks.push(body.subarray(offset, Math.min(offset + chunkSize, body.length)));
  }
  return chunks;
}

/**
 * Runs the shared conformance cases against any `ChunkReassemblerLike`.
 * Whole-body semantics: every frame's payload is body bytes
 * (`[bodyFlags][jsonLen][json][binary]`), frames carry no json section, and
 * `CHUNK_FIRST` — not an in-band envelope — marks a sequence start.
 */
export function runChunkReassemblerConformanceSpec(
  createReassembler: () => ChunkReassemblerLike,
  ChunkReassemblyErrorCtor: new (message: string) => Error,
): void {
  describe("ChunkReassembler conformance (shared client/host spec)", () => {
    it("decodes an unchunked frame's body straight through", () => {
      const reassembler = createReassembler();
      const body = encodeMuxMessageBody(
        { requestId: "r", method: "m", result: 1, error: null },
        null,
      );
      const out = reassembler.accept(
        frame({
          streamId: 9,
          seq: 0,
          chunked: false,
          binary: body,
        }),
      );
      expect(out).toEqual({
        type: MuxFrameType.STREAM_FRAME,
        streamId: 9,
        json: { requestId: "r", method: "m", result: 1, error: null },
        binary: null,
      });
    });

    it("reassembles in-order chunks back to the original json + binary", () => {
      const reassembler = createReassembler();
      const binary = new Uint8Array(7).fill(42);
      const body = encodeMuxMessageBody({ kind: "snapshot" }, binary);
      const chunks = bodyChunks(body, 4);
      expect(chunks.length).toBeGreaterThan(2);
      for (const [index, chunk] of chunks.entries()) {
        const isLast = index === chunks.length - 1;
        const out = reassembler.accept(
          frame({
            streamId: 5,
            seq: index,
            chunkFirst: index === 0,
            chunkLast: isLast,
            binary: chunk,
          }),
        );
        if (!isLast) {
          expect(out).toBeNull();
        } else {
          expect(out?.json).toEqual({ kind: "snapshot" });
          expect(out?.binary).toEqual(binary);
        }
      }
    });

    it("round-trips a chunk source's own frames (json-only body over the chunk size)", () => {
      const reassembler = createReassembler();
      const json = { kind: "snapshot", blob: "x".repeat(BULK_CHUNK_SIZE_BYTES * 2) };
      let seq = 7;
      const source = new OutboundChunkSource(
        {
          type: MuxFrameType.STREAM_FRAME,
          streamId: 3,
          qos: QosClass.INTERACTIVE,
          json,
          binary: null,
        },
        () => seq++,
        false,
      );
      let out: ReassembledMessage | null = null;
      while (!source.done) {
        out = reassembler.accept(decodeMuxFrame(encodeMuxFrame(source.nextFrame())));
      }
      expect(out?.json).toEqual(json);
      expect(out?.binary).toBeNull();
    });

    it("rejects an unchunked STREAM_FRAME arriving mid-sequence", () => {
      const reassembler = createReassembler();
      expect(
        reassembler.accept(
          frame({ streamId: 2, seq: 0, chunkFirst: true, binary: new Uint8Array([1]) }),
        ),
      ).toBeNull();
      expect(() =>
        reassembler.accept(
          frame({
            streamId: 2,
            seq: 99,
            chunked: false,
            binary: encodeMuxMessageBody({ kind: "y" }, null),
          }),
        ),
      ).toThrow(ChunkReassemblyErrorCtor);
    });

    it("lets an unchunked FATAL abort an in-flight sequence and still delivers it", () => {
      const reassembler = createReassembler();
      expect(
        reassembler.accept(
          frame({ streamId: 4, seq: 0, chunkFirst: true, binary: new Uint8Array([1]) }),
        ),
      ).toBeNull();
      const out = reassembler.accept(
        frame({
          type: MuxFrameType.FATAL,
          streamId: 4,
          seq: 1,
          chunked: false,
          binary: encodeMuxMessageBody({ details: { code: "X" } }, null),
        }),
      );
      expect(out?.type).toBe(MuxFrameType.FATAL);
      expect(out?.json).toEqual({ details: { code: "X" } });
      // The partial body is abandoned: a fresh sequence on the stream starts clean.
      expect(
        reassembler.accept(
          frame({ streamId: 4, seq: 2, chunkFirst: true, binary: new Uint8Array([9]) }),
        ),
      ).toBeNull();
    });

    it("rejects a continuation chunk that arrives without its starting chunk", () => {
      const reassembler = createReassembler();
      expect(() =>
        reassembler.accept(
          frame({ streamId: 6, seq: 5, binary: new Uint8Array([1]) }),
        ),
      ).toThrow(ChunkReassemblyErrorCtor);
    });

    it("rejects interleaved chunked messages on the same stream fail-closed", () => {
      const reassembler = createReassembler();
      expect(
        reassembler.accept(
          frame({ streamId: 7, seq: 0, chunkFirst: true, binary: new Uint8Array([1]) }),
        ),
      ).toBeNull();
      expect(() =>
        reassembler.accept(
          frame({ streamId: 7, seq: 50, chunkFirst: true, binary: new Uint8Array([2]) }),
        ),
      ).toThrow(ChunkReassemblyErrorCtor);
      // The original sequence's accumulator was dropped by the interleave
      // above - its own continuation must now fail closed too, not resume.
      expect(() =>
        reassembler.accept(
          frame({ streamId: 7, seq: 1, binary: new Uint8Array([3]) }),
        ),
      ).toThrow(ChunkReassemblyErrorCtor);
    });

    it("rejects out-of-order chunks on a stream instead of splicing payloads", () => {
      const reassembler = createReassembler();
      expect(
        reassembler.accept(
          frame({ streamId: 8, seq: 0, chunkFirst: true, binary: new Uint8Array([1]) }),
        ),
      ).toBeNull();
      // Expected seq 1; a reordering/splicing relay delivers seq 2 instead.
      expect(() =>
        reassembler.accept(
          frame({ streamId: 8, seq: 2, chunkLast: true, binary: new Uint8Array([2]) }),
        ),
      ).toThrow(ChunkReassemblyErrorCtor);
    });

    it("rejects a chunk whose type changes mid-sequence", () => {
      const reassembler = createReassembler();
      expect(
        reassembler.accept(
          frame({
            type: MuxFrameType.STREAM_FRAME,
            streamId: 10,
            seq: 0,
            chunkFirst: true,
            binary: new Uint8Array([1]),
          }),
        ),
      ).toBeNull();
      expect(() =>
        reassembler.accept(
          frame({
            type: MuxFrameType.RESPONSE,
            streamId: 10,
            seq: 1,
            binary: new Uint8Array([2]),
          }),
        ),
      ).toThrow(ChunkReassemblyErrorCtor);
    });

    it("rejects a frame that still carries a frame-level json section", () => {
      const reassembler = createReassembler();
      expect(() =>
        reassembler.accept(
          frame({
            streamId: 11,
            seq: 0,
            chunked: false,
            json: { kind: "legacy" },
            binary: encodeMuxMessageBody({ kind: "x" }, null),
          }),
        ),
      ).toThrow(ChunkReassemblyErrorCtor);
    });

    it("reset() clears in-flight accumulators so a repeated frame starts fresh", () => {
      const reassembler = createReassembler();
      expect(
        reassembler.accept(
          frame({ streamId: 3, seq: 0, chunkFirst: true, binary: new Uint8Array([1]) }),
        ),
      ).toBeNull();
      reassembler.reset();
      // Re-submitting the same starting frame must begin a fresh accumulator
      // (returns null again) rather than throwing "sequence already in
      // flight" - proving reset() actually cleared the prior state.
      expect(
        reassembler.accept(
          frame({ streamId: 3, seq: 0, chunkFirst: true, binary: new Uint8Array([1]) }),
        ),
      ).toBeNull();
    });
  });
}
