import { describe, expect, it } from "vitest";
import {
  decodeMuxFrame,
  encodeMuxFrame,
  type EncodeMuxFrameInput,
  type MuxFrame,
  MuxFrameType,
  QosClass,
} from "../mux";

/**
 * Structural shape both the client (`clients/shared/host-transport/remote/chunker.ts`)
 * and host (`traycer-host/src/transport/remote/chunker.ts`) `ChunkReassembler`
 * classes satisfy. Defined locally rather than imported: `protocol` is a leaf
 * dependency and must not import from either consumer.
 */
export interface ReassembledMessageLike {
  readonly type: MuxFrame["type"];
  readonly streamId: number;
  readonly json: Record<string, unknown> | null;
  readonly binary: Uint8Array | null;
}

export interface ChunkReassemblerLike {
  accept(frame: MuxFrame): ReassembledMessageLike | null;
  reset(): void;
}

function frame(overrides: Partial<EncodeMuxFrameInput>): MuxFrame {
  const input: EncodeMuxFrameInput = {
    type: MuxFrameType.STREAM_FRAME,
    streamId: 1,
    seq: 0,
    qos: QosClass.BULK,
    chunked: true,
    chunkLast: false,
    json: null,
    binary: new Uint8Array([1]),
    ...overrides,
  };
  return decodeMuxFrame(encodeMuxFrame(input));
}

/**
 * Runs the same conformance cases against any `ChunkReassemblerLike`
 * implementation - this is the "guard for the guard" (Architecture §4 fix
 * #1 / S3): the host's `seq`-adjacency check silently diverged from the
 * client's despite a comment claiming they mirrored, and a per-copy test
 * would let that happen again. Each consuming repo's own test file imports
 * this factory and passes its own concrete `ChunkReassembler` + its own
 * `ChunkReassemblyError` class - `protocol` never imports either.
 */
export function runChunkReassemblerConformanceSpec(
  createReassembler: () => ChunkReassemblerLike,
  ChunkReassemblyErrorCtor: new (message: string) => Error,
): void {
  describe("ChunkReassembler conformance (shared client/host spec)", () => {
    it("passes an unchunked frame straight through", () => {
      const reassembler = createReassembler();
      const decoded = frame({
        streamId: 9,
        seq: 0,
        chunked: false,
        chunkLast: false,
        json: { requestId: "r", method: "m", result: 1, error: null },
        binary: null,
      });
      const out = reassembler.accept(decoded);
      expect(out).toEqual({
        type: MuxFrameType.STREAM_FRAME,
        streamId: 9,
        json: { requestId: "r", method: "m", result: 1, error: null },
        binary: null,
      });
    });

    it("reassembles in-order chunks back to the original binary + json, json only on the first chunk", () => {
      const reassembler = createReassembler();
      const chunkA = new Uint8Array([1, 2, 3]);
      const chunkB = new Uint8Array([4, 5, 6]);
      const chunkC = new Uint8Array([7]);

      expect(
        reassembler.accept(
          frame({
            streamId: 5,
            seq: 0,
            chunked: true,
            chunkLast: false,
            json: { kind: "snapshot" },
            binary: chunkA,
          }),
        ),
      ).toBeNull();
      expect(
        reassembler.accept(
          frame({
            streamId: 5,
            seq: 1,
            chunked: true,
            chunkLast: false,
            json: null,
            binary: chunkB,
          }),
        ),
      ).toBeNull();
      const completed = reassembler.accept(
        frame({
          streamId: 5,
          seq: 2,
          chunked: true,
          chunkLast: true,
          json: null,
          binary: chunkC,
        }),
      );
      expect(completed).not.toBeNull();
      expect(completed?.json).toEqual({ kind: "snapshot" });
      expect(completed?.binary).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6, 7]));
    });

    it("rejects an unchunked frame arriving on a stream with an in-flight chunk sequence", () => {
      const reassembler = createReassembler();
      expect(
        reassembler.accept(
          frame({
            streamId: 2,
            seq: 0,
            chunked: true,
            chunkLast: false,
            json: { kind: "x" },
            binary: new Uint8Array([1]),
          }),
        ),
      ).toBeNull();
      expect(() =>
        reassembler.accept(
          frame({
            streamId: 2,
            seq: 99,
            chunked: false,
            chunkLast: false,
            json: { kind: "y" },
            binary: null,
          }),
        ),
      ).toThrow(ChunkReassemblyErrorCtor);
    });

    it("rejects a continuation chunk that arrives without its first envelope", () => {
      const reassembler = createReassembler();
      expect(() =>
        reassembler.accept(
          frame({
            streamId: 6,
            seq: 5,
            chunked: true,
            chunkLast: false,
            json: null,
            binary: new Uint8Array([1]),
          }),
        ),
      ).toThrow(ChunkReassemblyErrorCtor);
    });

    it("rejects interleaved chunked messages on the same stream fail-closed", () => {
      const reassembler = createReassembler();
      expect(
        reassembler.accept(
          frame({
            streamId: 7,
            seq: 0,
            chunked: true,
            chunkLast: false,
            json: { kind: "first" },
            binary: new Uint8Array([1]),
          }),
        ),
      ).toBeNull();
      expect(() =>
        reassembler.accept(
          frame({
            streamId: 7,
            seq: 50,
            chunked: true,
            chunkLast: false,
            json: { kind: "second" },
            binary: new Uint8Array([2]),
          }),
        ),
      ).toThrow(ChunkReassemblyErrorCtor);
      // The original sequence's accumulator was dropped by the interleave
      // above - its own continuation must now fail closed too, not resume.
      expect(() =>
        reassembler.accept(
          frame({
            streamId: 7,
            seq: 1,
            chunked: true,
            chunkLast: false,
            json: null,
            binary: new Uint8Array([3]),
          }),
        ),
      ).toThrow(ChunkReassemblyErrorCtor);
    });

    it("rejects out-of-order chunks on a stream instead of splicing payloads", () => {
      const reassembler = createReassembler();
      expect(
        reassembler.accept(
          frame({
            streamId: 8,
            seq: 0,
            chunked: true,
            chunkLast: false,
            json: { kind: "snapshot" },
            binary: new Uint8Array([1]),
          }),
        ),
      ).toBeNull();
      // Expected seq 1; a reordering/splicing relay delivers seq 2 instead.
      expect(() =>
        reassembler.accept(
          frame({
            streamId: 8,
            seq: 2,
            chunked: true,
            chunkLast: true,
            json: null,
            binary: new Uint8Array([2]),
          }),
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
            chunked: true,
            chunkLast: false,
            json: { kind: "snapshot" },
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
            chunked: true,
            chunkLast: false,
            json: null,
            binary: new Uint8Array([2]),
          }),
        ),
      ).toThrow(ChunkReassemblyErrorCtor);
    });

    it("reset() clears in-flight accumulators so a repeated frame starts fresh", () => {
      const reassembler = createReassembler();
      expect(
        reassembler.accept(
          frame({
            streamId: 3,
            seq: 0,
            chunked: true,
            chunkLast: false,
            json: { kind: "x" },
            binary: new Uint8Array([1]),
          }),
        ),
      ).toBeNull();
      reassembler.reset();
      // Re-submitting the same starting frame must begin a fresh accumulator
      // (returns null again) rather than throwing "sequence already in
      // flight" - proving reset() actually cleared the prior state.
      expect(
        reassembler.accept(
          frame({
            streamId: 3,
            seq: 0,
            chunked: true,
            chunkLast: false,
            json: { kind: "x" },
            binary: new Uint8Array([1]),
          }),
        ),
      ).toBeNull();
    });
  });
}
