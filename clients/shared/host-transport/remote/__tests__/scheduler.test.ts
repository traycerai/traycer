import { describe, expect, it, vi } from "vitest";
import {
  MuxFrameType,
  QosClass,
  type QosClassValue,
} from "@traycer/protocol/host-transport/mux";
import {
  BULK_CHUNK_SIZE_BYTES,
  CHUNK_PACE_BURST_BYTES,
  CHUNK_PACE_BURST_FRAMES,
  CHUNK_PACE_BYTES_PER_SEC,
  CHUNK_PACE_FRAMES_PER_SEC,
  ChunkInterleaveWindow,
  MAX_ACTIVE_CHUNKED_STREAMS,
  OutboundChunkSource,
} from "@traycer/protocol/host-transport/chunking";
import { StreamTurnIndex } from "@traycer/protocol/host-transport/remote/stream-turn-index";
import { InboundCreditTracker, PriorityScheduler } from "../scheduler";
import { FINE_INBOUND_CREDIT_GRANT_BATCH } from "@traycer/protocol/host-transport/mux";

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** A single-frame message on `streamId` at `qos` (body far under one chunk). */
function messageSource(
  streamId: number,
  qos: QosClassValue,
): OutboundChunkSource {
  let seq = 0;
  return new OutboundChunkSource(
    {
      type: MuxFrameType.STREAM_FRAME,
      streamId,
      qos,
      json: { kind: "x", hasBinaryPayload: false },
      binary: null,
    },
    () => seq++,
    false,
  );
}

/**
 * A genuinely multi-frame (chunked) message: `chunkMultiplier` chunks' worth
 * of filler bytes, comfortably over `BULK_CHUNK_SIZE_BYTES` so
 * `source.chunked === true` and `nextFrame()` must be called more than once
 * to drain it. Callers derive the exact frame count from
 * `Math.ceil(source.totalBodyBytes / BULK_CHUNK_SIZE_BYTES)` rather than
 * assuming `chunkMultiplier` - JSON encoding overhead pushes the body a
 * little past the requested multiple.
 */
function chunkedSource(
  streamId: number,
  qos: QosClassValue,
  chunkMultiplier: number,
): OutboundChunkSource {
  let seq = 0;
  return new OutboundChunkSource(
    {
      type: MuxFrameType.STREAM_FRAME,
      streamId,
      qos,
      json: {
        kind: "x",
        blob: "y".repeat(BULK_CHUNK_SIZE_BYTES * chunkMultiplier),
      },
      binary: null,
    },
    () => seq++,
    false,
  );
}

describe("PriorityScheduler", () => {
  it("sends interactive frames without consuming credits", async () => {
    const written: number[] = [];
    const scheduler = new PriorityScheduler({
      write: async (frame) => {
        written.push(frame.streamId);
      },
      onWriteError: () => undefined,
      initialBulkCredits: 0,
      now: undefined,
    });
    scheduler.enqueue(messageSource(1, QosClass.INTERACTIVE));
    await flush();
    expect(written).toEqual([1]);
  });

  it("gates bulk frames on credits and releases them on a grant", async () => {
    const written: number[] = [];
    const scheduler = new PriorityScheduler({
      write: async (frame) => {
        written.push(frame.streamId);
      },
      onWriteError: () => undefined,
      initialBulkCredits: 0,
      now: undefined,
    });
    scheduler.enqueue(messageSource(2, QosClass.BULK));
    await flush();
    expect(written).toEqual([]); // parked: no credits

    scheduler.grantCredits(1);
    await flush();
    expect(written).toEqual([2]);
  });

  it("drains a ready interactive frame while a bulk frame is credit-starved", async () => {
    const written: number[] = [];
    const scheduler = new PriorityScheduler({
      write: async (frame) => {
        written.push(frame.streamId);
      },
      onWriteError: () => undefined,
      initialBulkCredits: 0,
      now: undefined,
    });
    scheduler.enqueue(messageSource(3, QosClass.BULK));
    scheduler.enqueue(messageSource(4, QosClass.INTERACTIVE));
    await flush();
    // Interactive is sent (not gated); bulk stays parked until credits arrive.
    expect(written).toEqual([4]);
    scheduler.grantCredits(1);
    await flush();
    expect(written).toEqual([4, 3]);
  });

  it("holds an interactive frame behind an earlier bulk message on the SAME stream (per-stream FIFO across classes)", async () => {
    const written: { streamId: number; seq: number }[] = [];
    const scheduler = new PriorityScheduler({
      write: async (frame) => {
        written.push({ streamId: frame.streamId, seq: frame.seq });
      },
      onWriteError: () => undefined,
      initialBulkCredits: 0,
      now: undefined,
    });
    let seq = 0;
    const nextSeq = (): number => seq++;
    const bulkFirst = new OutboundChunkSource(
      {
        type: MuxFrameType.STREAM_FRAME,
        streamId: 7,
        qos: QosClass.BULK,
        json: { kind: "snapshot", hasBinaryPayload: false },
        binary: null,
      },
      nextSeq,
      false,
    );
    const interactiveAfter = new OutboundChunkSource(
      {
        type: MuxFrameType.STREAM_FRAME,
        streamId: 7,
        qos: QosClass.INTERACTIVE,
        json: { kind: "delta", hasBinaryPayload: false },
        binary: null,
      },
      nextSeq,
      false,
    );
    scheduler.enqueue(bulkFirst);
    scheduler.enqueue(interactiveAfter);
    // A different stream's interactive traffic is NOT held back.
    scheduler.enqueue(messageSource(8, QosClass.INTERACTIVE));
    await flush();
    expect(written).toEqual([{ streamId: 8, seq: 0 }]);
    scheduler.grantCredits(1);
    await flush();
    // Enqueue order restored for stream 7 once the bulk message could send.
    expect(written).toEqual([
      { streamId: 8, seq: 0 },
      { streamId: 7, seq: 0 },
      { streamId: 7, seq: 1 },
    ]);
  });

  it("holds queued frames while paused and flushes them on resume", async () => {
    const written: number[] = [];
    const scheduler = new PriorityScheduler({
      write: async (frame) => {
        written.push(frame.streamId);
      },
      onWriteError: () => undefined,
      initialBulkCredits: 10,
      now: undefined,
    });
    scheduler.pause();
    scheduler.enqueue(messageSource(5, QosClass.INTERACTIVE));
    await flush();
    expect(written).toEqual([]);
    scheduler.resume();
    await flush();
    expect(written).toEqual([5]);
  });

  it("paces a chunked transfer within the ChunkPacer's bytes/frames-per-second budget (plus burst) in any 1s window", async () => {
    vi.useFakeTimers();
    try {
      const streamId = 900;
      const samples: Array<{ tMs: number; bytes: number }> = [];
      const scheduler = new PriorityScheduler({
        write: async (frame) => {
          if (frame.streamId === streamId) {
            samples.push({
              tMs: Date.now(),
              bytes: frame.binary === null ? 0 : frame.binary.length,
            });
          }
        },
        onWriteError: (error) => {
          throw error instanceof Error ? error : new Error(String(error));
        },
        initialBulkCredits: 1000,
        now: () => Date.now(),
      });

      const source = chunkedSource(streamId, QosClass.BULK, 200);
      const totalFrames = Math.ceil(
        source.totalBodyBytes / BULK_CHUNK_SIZE_BYTES,
      );
      scheduler.enqueue(source);

      for (let i = 0; i < 100 && samples.length < totalFrames; i += 1) {
        await vi.advanceTimersByTimeAsync(50);
      }
      expect(samples.length).toBe(totalFrames);

      for (const sample of samples) {
        const windowStart = sample.tMs - 1000;
        const inWindow = samples.filter(
          (s) => s.tMs > windowStart && s.tMs <= sample.tMs,
        );
        const bytesInWindow = inWindow.reduce((sum, s) => sum + s.bytes, 0);
        expect(bytesInWindow).toBeLessThanOrEqual(
          CHUNK_PACE_BYTES_PER_SEC + CHUNK_PACE_BURST_BYTES,
        );
        expect(inWindow.length).toBeLessThanOrEqual(
          CHUNK_PACE_FRAMES_PER_SEC + CHUNK_PACE_BURST_FRAMES,
        );
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps per-stream FIFO within one queue when a pace-blocked transfer's follow-up is enqueued mid-transfer, while an unrelated stream still interleaves", async () => {
    vi.useFakeTimers();
    try {
      const written: Array<{
        streamId: number;
        seq: number;
        chunked: boolean;
      }> = [];
      const scheduler = new PriorityScheduler({
        write: async (frame) => {
          written.push({
            streamId: frame.streamId,
            seq: frame.seq,
            chunked: frame.chunked,
          });
        },
        onWriteError: (error) => {
          throw error instanceof Error ? error : new Error(String(error));
        },
        // `first` below is ~5 MiB, well over `BULK_QOS_BODY_THRESHOLD_BYTES`
        // (1 MiB), so `OutboundChunkSource` overrides its effective qos to
        // BULK regardless of the requested class - it needs enough bulk
        // credits to actually drain, or `ChunkPacer` would never get a chance
        // to pace-block it at all.
        initialBulkCredits: 1000,
        now: () => Date.now(),
      });

      const streamA = 100;
      const streamB = 200;
      // Both messages on stream A share ONE seq generator (as a real
      // per-stream sequence does): `seq` is drawn at `nextFrame()` time, i.e.
      // exactly when the scheduler pulls that frame.
      let seqA = 0;
      const nextSeqA = (): number => seqA++;

      // A transfer well past the pacer's burst (CHUNK_PACE_BURST_BYTES = 1
      // MiB / CHUNK_PACE_BURST_FRAMES = 64 frames): 80 chunks of
      // BULK_CHUNK_SIZE_BYTES (~5 MiB, ~81 frames) guarantees
      // `ChunkPacer.tryConsume` starts returning false mid-transfer, so this
      // test actually drives the `blockedStreams` guard inside
      // `pullFromQueue` (the WITHIN-one-queue same-stream ordering guard) -
      // not just `blockedByOtherQueue`. A first source of only a handful of
      // frames never exhausts the burst and leaves `blockedStreams` untested.
      const first = new OutboundChunkSource(
        {
          type: MuxFrameType.STREAM_FRAME,
          streamId: streamA,
          qos: QosClass.INTERACTIVE,
          json: {
            kind: "x",
            blob: "y".repeat(BULK_CHUNK_SIZE_BYTES * 80),
          },
          binary: null,
        },
        nextSeqA,
        false,
      );
      expect(first.chunked).toBe(true);
      const totalFramesFirst = Math.ceil(
        first.totalBodyBytes / BULK_CHUNK_SIZE_BYTES,
      );
      expect(totalFramesFirst).toBeGreaterThan(CHUNK_PACE_BURST_FRAMES);

      scheduler.enqueue(first);
      // Drain everything the pacer's burst allows in one synchronous pass; no
      // real time elapses under fake timers, so this stops deterministically
      // exactly at the burst boundary with the transfer still mid-flight.
      await vi.advanceTimersByTimeAsync(0);
      expect(first.done).toBe(false);
      const drainedInBurst = written.filter(
        (w) => w.streamId === streamA,
      ).length;
      expect(drainedInBurst).toBeGreaterThan(0);
      expect(drainedInBurst).toBeLessThan(totalFramesFirst);

      // WHILE stream A is still pace-blocked mid-transfer: a same-stream
      // follow-up (single-frame, so `chunked === false` on the wire - a
      // reliable provenance marker distinguishing it from `first`'s frames,
      // since the pull-order `seq` alone is monotonic regardless of which
      // source produced a frame) and an unrelated stream's frame.
      // `first`'s ~5 MiB body is auto-upclassed to BULK by
      // `OutboundChunkSource` (bodies over `BULK_QOS_BODY_THRESHOLD_BYTES`
      // ride BULK regardless of the requested class - see chunking.ts), so
      // `second` must be explicitly BULK too: only messages sharing the SAME
      // class queue exercise `blockedStreams` (the within-queue guard). If
      // `second` stayed INTERACTIVE it would sit in the OTHER class queue and
      // only `blockedByOtherQueue` (already covered elsewhere) would apply.
      const second = new OutboundChunkSource(
        {
          type: MuxFrameType.STREAM_FRAME,
          streamId: streamA,
          qos: QosClass.BULK,
          json: { kind: "follow-up", hasBinaryPayload: false },
          binary: null,
        },
        nextSeqA,
        false,
      );
      scheduler.enqueue(second);
      scheduler.enqueue(messageSource(streamB, QosClass.INTERACTIVE));
      await vi.advanceTimersByTimeAsync(0);

      // Still blocked: the follow-up must not have jumped the
      // still-in-progress first transfer.
      expect(first.done).toBe(false);
      expect(written.some((w) => w.streamId === streamA && !w.chunked)).toBe(
        false,
      );

      // Let the pacer refill and everything drain to completion.
      for (let i = 0; i < 100 && !(first.done && second.done); i += 1) {
        await vi.advanceTimersByTimeAsync(50);
      }
      expect(first.done).toBe(true);
      expect(second.done).toBe(true);

      const streamAWritten = written.filter((w) => w.streamId === streamA);
      const firstFrames = streamAWritten.filter((w) => w.chunked);
      const secondFrames = streamAWritten.filter((w) => !w.chunked);
      expect(firstFrames).toHaveLength(totalFramesFirst);
      expect(secondFrames).toHaveLength(1);
      // Per-stream FIFO WITHIN ONE QUEUE: every one of `first`'s frames lands
      // before `second`'s single frame - the invariant `blockedStreams`
      // guards (deleting that guard lets `second` - unchunked, never paced -
      // jump ahead the moment `first` is skipped for pacing in the same scan).
      const lastFirstIndex = written.reduce(
        (last, w, i) => (w.streamId === streamA && w.chunked ? i : last),
        -1,
      );
      const secondIndex = written.findIndex(
        (w) => w.streamId === streamA && !w.chunked,
      );
      expect(lastFirstIndex).toBeLessThan(secondIndex);
      // Sanity: the shared per-stream seq counter still produced a strictly
      // increasing pull-order sequence across both messages.
      expect(streamAWritten.map((w) => w.seq)).toEqual(
        Array.from({ length: totalFramesFirst + 1 }, (_, i) => i),
      );

      // The unrelated stream is not starved behind stream A's pace-blocked
      // transfer - it flows while A is still mid-drain.
      expect(written.some((w) => w.streamId === streamB)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("spends exactly one bulk credit per FRAME of a chunked BULK transfer - stalls at zero credits and resumes on grantCredits", async () => {
    const written: Array<{ streamId: number }> = [];
    const scheduler = new PriorityScheduler({
      write: async (frame) => {
        written.push({ streamId: frame.streamId });
      },
      onWriteError: (error) => {
        throw error instanceof Error ? error : new Error(String(error));
      },
      initialBulkCredits: 0,
      now: undefined,
    });

    const streamId = 300;
    const source = chunkedSource(streamId, QosClass.BULK, 10);
    const totalFrames = Math.ceil(
      source.totalBodyBytes / BULK_CHUNK_SIZE_BYTES,
    );
    scheduler.enqueue(source);
    await flush();
    // No credits at all: not even the first frame of the transfer goes out.
    expect(written).toHaveLength(0);
    expect(scheduler.availableCredits()).toBe(0);

    // Grant fewer credits than the full transfer needs - exactly that many
    // frames flow (one credit spent per FRAME, not per message), and the
    // transfer stalls again partway through.
    const partial = Math.min(3, totalFrames - 1);
    scheduler.grantCredits(partial);
    await flush();
    expect(written).toHaveLength(partial);
    expect(source.done).toBe(false);
    expect(scheduler.availableCredits()).toBe(0);

    // Granting the rest resumes and completes the transfer.
    scheduler.grantCredits(totalFrames - partial);
    await flush();
    expect(written).toHaveLength(totalFrames);
    expect(source.done).toBe(true);
  });

  it("pace-bounds an unchunked interactive burst to CHUNK_PACE_BURST_FRAMES under a frozen clock, then resumes on refill", async () => {
    vi.useFakeTimers();
    try {
      const written: number[] = [];
      const scheduler = new PriorityScheduler({
        write: async (frame) => {
          written.push(frame.streamId);
        },
        onWriteError: (error) => {
          throw error instanceof Error ? error : new Error(String(error));
        },
        initialBulkCredits: 0,
        now: () => Date.now(),
      });

      // A burst of single-frame INTERACTIVE messages, well past the pacer's
      // frame burst (`CHUNK_PACE_BURST_FRAMES` = 64) - INTERACTIVE is never
      // credit-gated, so nothing but the pacer can explain a stop short of
      // `CHUNK_PACE_BURST_FRAMES`. This is the regression pin for "every
      // frame - not just chunked ones - now consults the pacer": deleting
      // the `tryConsume` call for unchunked frames in `pullFromQueue` would
      // let every one of these 100 frames drain in this same synchronous
      // pass instead of stopping at exactly 64.
      const total = CHUNK_PACE_BURST_FRAMES + 36;
      for (let i = 0; i < total; i += 1) {
        scheduler.enqueue(messageSource(1, QosClass.INTERACTIVE));
      }
      // No simulated time elapses: only the frozen burst can drain.
      await vi.advanceTimersByTimeAsync(0);
      expect(written.length).toBe(CHUNK_PACE_BURST_FRAMES);

      // Advancing the clock refills the bucket at CHUNK_PACE_FRAMES_PER_SEC
      // and the rest drains.
      for (let i = 0; i < 100 && written.length < total; i += 1) {
        await vi.advanceTimersByTimeAsync(50);
      }
      expect(written.length).toBe(total);
    } finally {
      vi.useRealTimers();
    }
  });

  it("interleaves a later interactive stream before a large chunked interactive stream completes", async () => {
    vi.useFakeTimers();
    try {
      const largeStreamId = 401;
      const tinyStreamId = 402;
      const written: Array<{ streamId: number; chunked: boolean }> = [];
      const scheduler = new PriorityScheduler({
        write: async (frame) => {
          written.push({ streamId: frame.streamId, chunked: frame.chunked });
        },
        onWriteError: (error) => {
          throw error instanceof Error ? error : new Error(String(error));
        },
        initialBulkCredits: 0,
        now: () => Date.now(),
      });

      // Eight chunks remain below the 1 MiB threshold that would auto-upclass
      // this source to BULK, while still requiring multiple interactive frames.
      const large = chunkedSource(largeStreamId, QosClass.INTERACTIVE, 8);
      const largeFrameCount = Math.ceil(
        large.totalBodyBytes / BULK_CHUNK_SIZE_BYTES,
      );
      expect(large.chunked).toBe(true);
      expect(largeFrameCount).toBeGreaterThan(1);
      expect(largeFrameCount).toBeLessThan(CHUNK_PACE_BURST_FRAMES);

      scheduler.enqueue(large);
      scheduler.enqueue(messageSource(tinyStreamId, QosClass.INTERACTIVE));
      // Drain the current burst without advancing the fake clock. The tiny
      // stream should get a turn before the large source's final frame.
      await vi.advanceTimersByTimeAsync(0);

      expect(large.done).toBe(true);
      expect(
        written.filter((frame) => frame.streamId === largeStreamId),
      ).toHaveLength(largeFrameCount);
      expect(
        written.filter((frame) => frame.streamId === tinyStreamId),
      ).toHaveLength(1);
      const tinyIndex = written.findIndex(
        (frame) => frame.streamId === tinyStreamId,
      );
      const largeFinalIndex = written.reduce(
        (last, frame, index) =>
          frame.streamId === largeStreamId ? index : last,
        -1,
      );
      expect(tinyIndex).toBeGreaterThanOrEqual(0);
      expect(tinyIndex).toBeLessThan(largeFinalIndex);

      // Under a frozen clock the total interactive frame count cannot exceed
      // the pacer's configured burst; this also catches accidental unpaced
      // draining without relying on wall-clock durations.
      expect(written).toHaveLength(largeFrameCount + 1);
      expect(written.length).toBeLessThanOrEqual(CHUNK_PACE_BURST_FRAMES);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rotates same-class BULK streams between frames while honoring credits and pacing", async () => {
    vi.useFakeTimers();
    try {
      const largeStreamId = 501;
      const smallStreamId = 502;
      const initialCredits = 1000;
      const written: Array<{ streamId: number }> = [];
      const scheduler = new PriorityScheduler({
        write: async (frame) => {
          written.push({ streamId: frame.streamId });
        },
        onWriteError: (error) => {
          throw error instanceof Error ? error : new Error(String(error));
        },
        initialBulkCredits: initialCredits,
        now: () => Date.now(),
      });
      const large = chunkedSource(largeStreamId, QosClass.BULK, 200);
      const largeFrameCount = Math.ceil(
        large.totalBodyBytes / BULK_CHUNK_SIZE_BYTES,
      );
      const small = messageSource(smallStreamId, QosClass.BULK);

      scheduler.enqueue(large);
      scheduler.enqueue(small);
      // With the clock frozen, the current burst is the byte budget's 16 full
      // chunks (and at most the frame budget). Both sources share the BULK
      // queue, so the small source must take a turn inside that burst.
      await vi.advanceTimersByTimeAsync(0);

      expect(large.done).toBe(false);
      expect(
        written.filter((entry) => entry.streamId === smallStreamId),
      ).toHaveLength(1);
      const smallIndex = written.findIndex(
        (entry) => entry.streamId === smallStreamId,
      );
      const largeFinalIndex = written.reduce(
        (last, entry, index) =>
          entry.streamId === largeStreamId ? index : last,
        -1,
      );
      expect(smallIndex).toBeGreaterThanOrEqual(0);
      expect(smallIndex).toBeLessThan(largeFinalIndex);
      const largeFramesInBurst = written.filter(
        (entry) => entry.streamId === largeStreamId,
      ).length;
      expect(largeFramesInBurst).toBeGreaterThan(0);
      expect(largeFramesInBurst).toBeLessThanOrEqual(
        Math.ceil(CHUNK_PACE_BURST_BYTES / BULK_CHUNK_SIZE_BYTES),
      );
      expect(written.length).toBeLessThanOrEqual(CHUNK_PACE_BURST_FRAMES);
      expect(scheduler.availableCredits()).toBe(
        initialCredits - written.length,
      );

      for (let i = 0; i < 300 && !large.done; i += 1) {
        await vi.advanceTimersByTimeAsync(50);
      }
      expect(large.done).toBe(true);
      expect(
        written.filter((entry) => entry.streamId === largeStreamId),
      ).toHaveLength(largeFrameCount);
      expect(
        written.filter((entry) => entry.streamId === smallStreamId),
      ).toHaveLength(1);
      expect(scheduler.availableCredits()).toBe(
        initialCredits - largeFrameCount - 1,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains a locally aborted chunk reservation until its terminal frame is written", async () => {
    vi.useFakeTimers();
    try {
      let releaseTerminalWrite: (() => void) | undefined;
      let markTerminalHeld: (() => void) | undefined;
      let releaseAbortedChunk: (() => void) | undefined;
      let markAbortedChunkHeld: (() => void) | undefined;
      const terminalHeld = new Promise<void>((resolve) => {
        markTerminalHeld = resolve;
      });
      const abortedChunkHeld = new Promise<void>((resolve) => {
        markAbortedChunkHeld = resolve;
      });
      const abortedChunkGate = new Promise<void>((resolve) => {
        releaseAbortedChunk = resolve;
      });
      const terminalWriteGate = new Promise<void>((resolve) => {
        releaseTerminalWrite = resolve;
      });
      const written: Array<{ streamId: number; type: number }> = [];
      const abortedStreamId = 1000;
      const nextStreamId = 1016;
      const writesByStream = new Map<number, number>();
      const activeSources: OutboundChunkSource[] = [];
      const scheduler = new PriorityScheduler({
        write: async (frame) => {
          written.push({ streamId: frame.streamId, type: frame.type });
          if (frame.type === MuxFrameType.STREAM_FRAME) {
            const count = (writesByStream.get(frame.streamId) ?? 0) + 1;
            writesByStream.set(frame.streamId, count);
            if (frame.streamId === abortedStreamId && count === 2) {
              markAbortedChunkHeld?.();
              await abortedChunkGate;
            }
          }
          if (
            frame.streamId === abortedStreamId &&
            frame.type === MuxFrameType.CLOSE
          ) {
            markTerminalHeld?.();
            await terminalWriteGate;
          }
        },
        onWriteError: (error) => {
          throw error instanceof Error ? error : new Error(String(error));
        },
        initialBulkCredits: 1000,
        now: () => Date.now(),
      });

      // Queue sixteen partial INTERACTIVE streams plus the blocked seventeenth
      // before pumping. As the first chunks rotate through, the waiter reaches
      // the head before all active continuations.
      scheduler.pause();
      for (
        let streamId = abortedStreamId;
        streamId < nextStreamId;
        streamId += 1
      ) {
        const source = chunkedSource(streamId, QosClass.INTERACTIVE, 4);
        activeSources.push(source);
        scheduler.enqueue(source);
      }
      scheduler.enqueue(chunkedSource(nextStreamId, QosClass.INTERACTIVE, 4));
      scheduler.resume();
      for (
        let i = 0;
        i < 100 && (writesByStream.get(abortedStreamId) ?? 0) < 2;
        i += 1
      ) {
        await vi.advanceTimersByTimeAsync(50);
      }
      await abortedChunkHeld;
      expect(writesByStream.size).toBe(16);
      expect(
        [...writesByStream.keys()].sort((left, right) => left - right),
      ).toEqual(
        Array.from({ length: 16 }, (_, index) => abortedStreamId + index),
      );
      expect(activeSources.every((source) => !source.done)).toBe(true);
      expect(written.length).toBeGreaterThanOrEqual(16);
      expect(written.length).toBeLessThanOrEqual(CHUNK_PACE_BURST_FRAMES);

      // The waiter is at the queue head before the active continuations. Refill
      // pacing while the writer is held so a premature release makes its first
      // chunk eligible immediately, before CLOSE or those continuations.
      await vi.advanceTimersByTimeAsync(500);
      scheduler.dropStreamOutbound(abortedStreamId);
      let seq = 0;
      scheduler.enqueue(
        new OutboundChunkSource(
          {
            type: MuxFrameType.CLOSE,
            streamId: abortedStreamId,
            qos: QosClass.INTERACTIVE,
            json: null,
            binary: null,
          },
          () => seq++,
          false,
        ),
      );
      releaseAbortedChunk?.();
      await vi.advanceTimersByTimeAsync(0);
      await terminalHeld;
      expect(written.some((entry) => entry.streamId === nextStreamId)).toBe(
        false,
      );

      releaseTerminalWrite?.();
      for (
        let i = 0;
        i < 100 && !written.some((entry) => entry.streamId === nextStreamId);
        i += 1
      ) {
        await vi.advanceTimersByTimeAsync(50);
      }
      const terminalIndex = written.findIndex(
        (entry) =>
          entry.streamId === abortedStreamId &&
          entry.type === MuxFrameType.CLOSE,
      );
      const nextStreamIndex = written.findIndex(
        (entry) => entry.streamId === nextStreamId,
      );
      expect(terminalIndex).toBeGreaterThanOrEqual(0);
      expect(nextStreamIndex).toBeGreaterThan(terminalIndex);
      expect(written.length).toBeLessThanOrEqual(CHUNK_PACE_BURST_FRAMES + 100);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a peer abort releases a chunk slot and wakes a blocked client pump", async () => {
    vi.useFakeTimers();
    try {
      const firstStreamId = 1100;
      const blockedStreamId = 1116;
      const firstFramesByStream = new Set<number>();
      const written: number[] = [];
      const scheduler = new PriorityScheduler({
        write: async (frame) => {
          written.push(frame.streamId);
          if (frame.type === MuxFrameType.STREAM_FRAME) {
            firstFramesByStream.add(frame.streamId);
          }
        },
        onWriteError: (error) => {
          throw error instanceof Error ? error : new Error(String(error));
        },
        initialBulkCredits: 0,
        now: () => Date.now(),
      });

      // Sixteen partial INTERACTIVE streams occupy every reassembly slot.
      for (
        let streamId = firstStreamId;
        streamId < blockedStreamId;
        streamId += 1
      ) {
        scheduler.enqueue(chunkedSource(streamId, QosClass.INTERACTIVE, 8));
      }
      for (let i = 0; i < 100 && firstFramesByStream.size < 16; i += 1) {
        await vi.advanceTimersByTimeAsync(50);
      }
      expect(firstFramesByStream.size).toBe(16);

      // Local aborts retain the reservations while their terminal messages
      // remain outstanding, leaving the pump idle with one blocked source.
      for (
        let streamId = firstStreamId;
        streamId < blockedStreamId;
        streamId += 1
      ) {
        scheduler.dropStreamOutbound(streamId);
      }
      scheduler.enqueue(
        chunkedSource(blockedStreamId, QosClass.INTERACTIVE, 4),
      );
      await vi.advanceTimersByTimeAsync(100);
      expect(written).not.toContain(blockedStreamId);

      // No enqueue or credit event follows. The peer-confirmed release itself
      // must wake the scheduler and let the blocked source acquire that slot.
      scheduler.dropStreamOutboundAfterPeerAbort(firstStreamId);
      for (let i = 0; i < 20 && !written.includes(blockedStreamId); i += 1) {
        await vi.advanceTimersByTimeAsync(50);
      }
      expect(written).toContain(blockedStreamId);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps same-class fairness after a queued source is dropped from stream counts", async () => {
    vi.useFakeTimers();
    try {
      const largeStreamId = 1120;
      const droppedStreamId = 1121;
      const laterStreamId = 1122;
      const written: Array<{ streamId: number; chunked: boolean }> = [];
      const scheduler = new PriorityScheduler({
        write: async (frame) => {
          written.push({ streamId: frame.streamId, chunked: frame.chunked });
        },
        onWriteError: (error) => {
          throw error instanceof Error ? error : new Error(String(error));
        },
        initialBulkCredits: 0,
        now: () => Date.now(),
      });
      const large = chunkedSource(largeStreamId, QosClass.INTERACTIVE, 8);
      const largeFrameCount = Math.ceil(
        large.totalBodyBytes / BULK_CHUNK_SIZE_BYTES,
      );

      scheduler.pause();
      scheduler.enqueue(large);
      scheduler.enqueue(messageSource(droppedStreamId, QosClass.INTERACTIVE));
      scheduler.dropStreamOutbound(droppedStreamId);
      scheduler.enqueue(messageSource(laterStreamId, QosClass.INTERACTIVE));
      scheduler.resume();
      await vi.advanceTimersByTimeAsync(0);

      expect(
        written.filter((entry) => entry.streamId === droppedStreamId),
      ).toHaveLength(0);
      const laterIndex = written.findIndex(
        (entry) => entry.streamId === laterStreamId,
      );
      const largeFinalIndex = written.reduce(
        (last, entry, index) =>
          entry.streamId === largeStreamId ? index : last,
        -1,
      );
      expect(laterIndex).toBeGreaterThanOrEqual(0);
      expect(laterIndex).toBeLessThan(largeFinalIndex);
      expect(written.length).toBeLessThanOrEqual(CHUNK_PACE_BURST_FRAMES);

      for (let i = 0; i < 100 && !large.done; i += 1) {
        await vi.advanceTimersByTimeAsync(50);
      }
      expect(large.done).toBe(true);
      expect(
        written.filter((entry) => entry.streamId === largeStreamId),
      ).toHaveLength(largeFrameCount);
      expect(
        written.filter((entry) => entry.streamId === laterStreamId),
      ).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("interleaves chunk streams around a deep same-stream FIFO tail", async () => {
    vi.useFakeTimers();
    try {
      const streamA = 1130;
      const streamB = 1131;
      const tailCount = 1000;
      const written: Array<{ streamId: number; chunked: boolean }> = [];
      const scheduler = new PriorityScheduler({
        write: async (frame) => {
          written.push({ streamId: frame.streamId, chunked: frame.chunked });
        },
        onWriteError: (error) => {
          throw error instanceof Error ? error : new Error(String(error));
        },
        initialBulkCredits: 0,
        now: () => Date.now(),
      });
      const largeA = chunkedSource(streamA, QosClass.INTERACTIVE, 8);
      const largeB = chunkedSource(streamB, QosClass.INTERACTIVE, 8);
      const framesA = Math.ceil(largeA.totalBodyBytes / BULK_CHUNK_SIZE_BYTES);
      const framesB = Math.ceil(largeB.totalBodyBytes / BULK_CHUNK_SIZE_BYTES);

      scheduler.pause();
      scheduler.enqueue(largeA);
      for (let index = 0; index < tailCount; index += 1) {
        scheduler.enqueue(messageSource(streamA, QosClass.INTERACTIVE));
      }
      scheduler.enqueue(largeB);
      scheduler.resume();

      const expectedStreamFrames = framesA + framesB + tailCount;
      for (
        let i = 0;
        i < 200 &&
        written.filter(
          (entry) => entry.streamId === streamA || entry.streamId === streamB,
        ).length < expectedStreamFrames;
        i += 1
      ) {
        await vi.advanceTimersByTimeAsync(50);
      }
      expect(
        written.filter((entry) => entry.streamId === streamA),
      ).toHaveLength(framesA + tailCount);
      expect(
        written.filter((entry) => entry.streamId === streamB),
      ).toHaveLength(framesB);

      const chunkIndexes = (streamId: number): number[] =>
        written.flatMap((entry, index) =>
          entry.streamId === streamId && entry.chunked ? [index] : [],
        );
      const aChunks = chunkIndexes(streamA);
      const bChunks = chunkIndexes(streamB);
      expect(aChunks).toHaveLength(framesA);
      expect(bChunks).toHaveLength(framesB);
      expect(aChunks[1]).toBeLessThan(bChunks[bChunks.length - 1]);
      expect(bChunks[1]).toBeLessThan(aChunks[aChunks.length - 1]);

      const firstTailIndex = written.findIndex(
        (entry) => entry.streamId === streamA && !entry.chunked,
      );
      expect(aChunks[aChunks.length - 1]).toBeLessThan(firstTailIndex);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not rescan window-blocked stream heads on every active continuation", async () => {
    vi.useFakeTimers();
    const canPullSpy = vi.spyOn(ChunkInterleaveWindow.prototype, "canPull");
    try {
      const activeCount = MAX_ACTIVE_CHUNKED_STREAMS;
      const blockedCount = 128;
      const firstActiveStreamId = 5200;
      const firstBlockedStreamId = 5300;
      const activeSources = Array.from({ length: activeCount }, (_, index) =>
        chunkedSource(firstActiveStreamId + index, QosClass.INTERACTIVE, 8),
      );
      const firstActiveSource = activeSources[0];
      if (firstActiveSource === undefined) {
        throw new Error("expected at least one active source");
      }
      const framesPerActiveSource = Math.ceil(
        firstActiveSource.totalBodyBytes / BULK_CHUNK_SIZE_BYTES,
      );
      const written: number[] = [];
      const scheduler = new PriorityScheduler({
        write: async (frame) => {
          written.push(frame.streamId);
        },
        onWriteError: (error) => {
          throw error instanceof Error ? error : new Error(String(error));
        },
        initialBulkCredits: 0,
        now: () => Date.now(),
      });
      scheduler.pause();
      for (const source of activeSources) scheduler.enqueue(source);
      for (let index = 0; index < blockedCount; index += 1) {
        scheduler.enqueue(
          chunkedSource(firstBlockedStreamId + index, QosClass.INTERACTIVE, 1),
        );
      }
      scheduler.resume();
      await vi.advanceTimersByTimeAsync(0);
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const startedStreams = new Set(written);
        if (startedStreams.size === activeCount) break;
        await vi.advanceTimersByTimeAsync(50);
      }
      expect(new Set(written).size).toBe(activeCount);
      expect(
        written.every(
          (streamId) =>
            streamId >= firstActiveStreamId &&
            streamId < firstActiveStreamId + activeCount,
        ),
      ).toBe(true);
      for (let index = 0; index < activeCount; index += 1) {
        expect(
          written.filter((streamId) => streamId === firstActiveStreamId + index)
            .length,
        ).toBeLessThan(framesPerActiveSource);
      }

      // The initial pass admits the active set and parks the remaining heads.
      // Measure only repeated continuation turns, not that one-time discovery.
      canPullSpy.mockClear();
      const initialWriteCount = written.length;
      for (
        let attempt = 0;
        attempt < 20 && written.length < initialWriteCount + 4;
        attempt += 1
      ) {
        await vi.advanceTimersByTimeAsync(50);
      }
      const continuationCount = written.length - initialWriteCount;
      expect(continuationCount).toBeGreaterThanOrEqual(4);
      expect(
        written
          .slice(initialWriteCount)
          .every(
            (streamId) =>
              streamId >= firstActiveStreamId &&
              streamId < firstActiveStreamId + activeCount,
          ),
      ).toBe(true);
      for (let index = 0; index < activeCount; index += 1) {
        expect(
          written.filter((streamId) => streamId === firstActiveStreamId + index)
            .length,
        ).toBeLessThan(framesPerActiveSource);
      }
      expect(canPullSpy.mock.calls.length).toBeLessThan(
        blockedCount + activeCount * 2 + continuationCount * 3,
      );
      scheduler.stop();
    } finally {
      canPullSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("lets a parked interactive peer take the slot before a completed stream successor", async () => {
    vi.useFakeTimers();
    const originalCanPull = ChunkInterleaveWindow.prototype.canPull;
    const canPullSpy = vi.spyOn(ChunkInterleaveWindow.prototype, "canPull");
    try {
      const activeBulkCount = MAX_ACTIVE_CHUNKED_STREAMS - 1;
      const firstBulkStreamId = 6100;
      const streamA = 6200;
      const streamB = 6201;
      const sourceB = chunkedSource(streamB, QosClass.INTERACTIVE, 1);
      let bWasWindowBlocked = false;
      canPullSpy.mockImplementation(
        function (this: ChunkInterleaveWindow, source) {
          const canPull = originalCanPull.call(this, source);
          if (source === sourceB && !canPull) bWasWindowBlocked = true;
          return canPull;
        },
      );
      let schedulerNow = 0;
      const written: Array<{ streamId: number; chunked: boolean }> = [];
      const scheduler = new PriorityScheduler({
        write: async (frame) => {
          written.push({ streamId: frame.streamId, chunked: frame.chunked });
          schedulerNow += 50;
        },
        onWriteError: (error) => {
          throw error instanceof Error ? error : new Error(String(error));
        },
        initialBulkCredits: 0,
        now: () => schedulerNow,
      });
      scheduler.pause();
      scheduler.adoptNegotiatedCreditWindow(activeBulkCount);
      for (let index = 0; index < activeBulkCount; index += 1) {
        scheduler.enqueue(
          chunkedSource(firstBulkStreamId + index, QosClass.BULK, 2),
        );
      }
      scheduler.resume();
      await vi.advanceTimersByTimeAsync(0);
      expect(
        written.filter(
          (entry) =>
            entry.streamId >= firstBulkStreamId &&
            entry.streamId < firstBulkStreamId + activeBulkCount,
        ),
      ).toHaveLength(activeBulkCount);
      expect(scheduler.availableCredits()).toBe(0);

      const sourceA = chunkedSource(streamA, QosClass.INTERACTIVE, 8);
      const sourceAFrames = Math.ceil(
        sourceA.totalBodyBytes / BULK_CHUNK_SIZE_BYTES,
      );
      scheduler.enqueue(sourceA);
      scheduler.enqueue(messageSource(streamA, QosClass.INTERACTIVE));
      scheduler.enqueue(sourceB);

      for (let attempt = 0; attempt < 40; attempt += 1) {
        const hasB = written.some((entry) => entry.streamId === streamB);
        const hasASuccessor = written.some(
          (entry) => entry.streamId === streamA && !entry.chunked,
        );
        if (hasB && hasASuccessor) break;
        await vi.advanceTimersByTimeAsync(50);
      }
      const aLastChunkIndex = written.reduce(
        (last, entry, index) =>
          entry.streamId === streamA && entry.chunked ? index : last,
        -1,
      );
      const aSuccessorIndex = written.findIndex(
        (entry) => entry.streamId === streamA && !entry.chunked,
      );
      const bFirstChunkIndex = written.findIndex(
        (entry) => entry.streamId === streamB,
      );
      expect(
        written.filter((entry) => entry.streamId === streamA && entry.chunked),
      ).toHaveLength(sourceAFrames);
      expect(bWasWindowBlocked).toBe(true);
      expect(bFirstChunkIndex).toBeGreaterThan(aLastChunkIndex);
      expect(aSuccessorIndex).toBeGreaterThanOrEqual(0);
      expect(bFirstChunkIndex).toBeLessThan(aSuccessorIndex);
      scheduler.stop();
    } finally {
      canPullSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("does not rescan FIFO-blocked successors on unrelated active turns", async () => {
    vi.useFakeTimers();
    const headSerialSpy = vi.spyOn(StreamTurnIndex.prototype, "headSerial");
    try {
      const activeStreamId = 7100;
      const firstBlockedStreamId = 7200;
      const blockedCount = 80;
      const written: number[] = [];
      const scheduler = new PriorityScheduler({
        write: async (frame) => {
          written.push(frame.streamId);
        },
        onWriteError: (error) => {
          throw error instanceof Error ? error : new Error(String(error));
        },
        initialBulkCredits: 0,
        now: () => Date.now(),
      });
      scheduler.pause();
      for (let index = 0; index < blockedCount; index += 1) {
        const streamId = firstBlockedStreamId + index;
        scheduler.enqueue(messageSource(streamId, QosClass.BULK));
        scheduler.enqueue(messageSource(streamId, QosClass.INTERACTIVE));
      }
      const activeSource = chunkedSource(
        activeStreamId,
        QosClass.INTERACTIVE,
        8,
      );
      const activeFrameCount = Math.ceil(
        activeSource.totalBodyBytes / BULK_CHUNK_SIZE_BYTES,
      );
      scheduler.enqueue(activeSource);
      headSerialSpy.mockClear();
      scheduler.resume();
      await vi.advanceTimersByTimeAsync(0);
      expect(written).toHaveLength(activeFrameCount);
      expect(written.every((streamId) => streamId === activeStreamId)).toBe(
        true,
      );
      expect(
        written.some(
          (streamId) =>
            streamId >= firstBlockedStreamId &&
            streamId < firstBlockedStreamId + blockedCount,
        ),
      ).toBe(false);
      expect(headSerialSpy.mock.calls.length).toBeLessThan(
        blockedCount + activeFrameCount * 3 + 20,
      );
      scheduler.stop();
    } finally {
      headSerialSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe("PriorityScheduler.queuedBytesForStream / onFrameWritten", () => {
  it("sums only the named stream across both queues and drops to 0 after dropStreamOutbound", async () => {
    const scheduler = new PriorityScheduler({
      write: async () => undefined,
      onWriteError: () => undefined,
      initialBulkCredits: 0,
      now: undefined,
    });

    const bulkOnStream1 = messageSource(1, QosClass.BULK);
    const interactiveOnStream1 = messageSource(1, QosClass.INTERACTIVE);
    // BULK, so with zero credits it provably stays queued; its size is captured
    // up front so a drained source cannot make the comparison 0 === 0.
    const onStream2 = messageSource(2, QosClass.BULK);
    const stream1Bytes =
      bulkOnStream1.remainingBytes + interactiveOnStream1.remainingBytes;
    const stream2Bytes = onStream2.remainingBytes;
    expect(stream2Bytes).toBeGreaterThan(0);

    // No credits at all, so nothing drains and every source stays queued -
    // the sum below is read against a known, held state.
    scheduler.enqueue(bulkOnStream1);
    scheduler.enqueue(interactiveOnStream1);
    scheduler.enqueue(onStream2);

    expect(scheduler.queuedBytesForStream(1)).toBe(stream1Bytes);
    expect(scheduler.queuedBytesForStream(2)).toBe(stream2Bytes);
    expect(scheduler.queuedBytesForStream(999)).toBe(0);

    scheduler.dropStreamOutbound(1);
    expect(scheduler.queuedBytesForStream(1)).toBe(0);
    expect(scheduler.queuedBytesForStream(2)).toBe(stream2Bytes);
  });

  it("fires onFrameWritten once per written frame, with that frame's streamId, after the write resolves", async () => {
    const writeOrder: string[] = [];
    // A holder, not a `let`: an assignment inside the promise executor is
    // invisible to TypeScript, which would narrow a bare variable to `null`.
    const firstWrite: { resolve: (() => void) | null } = { resolve: null };
    const scheduler = new PriorityScheduler({
      write: async (frame) => {
        writeOrder.push(`write-start:${frame.streamId}`);
        if (frame.streamId === 1) {
          await new Promise<void>((resolve) => {
            firstWrite.resolve = resolve;
          });
        }
        writeOrder.push(`write-done:${frame.streamId}`);
      },
      onWriteError: () => undefined,
      initialBulkCredits: 0,
      now: undefined,
    });
    const written: number[] = [];
    scheduler.onFrameWritten = (streamId) => {
      writeOrder.push(`notified:${streamId}`);
      written.push(streamId);
    };

    scheduler.enqueue(messageSource(1, QosClass.INTERACTIVE));
    await flush();
    // The write is deliberately held open: onFrameWritten must not fire
    // before it resolves.
    expect(written).toEqual([]);
    expect(writeOrder).toEqual(["write-start:1"]);

    const resolve = firstWrite.resolve;
    if (resolve === null) {
      throw new Error("expected the first write to be pending");
    }
    resolve();
    await flush();

    expect(written).toEqual([1]);
    expect(writeOrder).toEqual(["write-start:1", "write-done:1", "notified:1"]);
  });

  it("lets a listener that enqueues another message from inside the callback append without corrupting FIFO order", async () => {
    const written: number[] = [];
    let enqueuedFollowUp = false;
    const scheduler = new PriorityScheduler({
      write: async (frame) => {
        written.push(frame.streamId);
      },
      onWriteError: () => undefined,
      initialBulkCredits: 0,
      now: undefined,
    });
    scheduler.onFrameWritten = (streamId) => {
      if (streamId === 1 && !enqueuedFollowUp) {
        enqueuedFollowUp = true;
        // A tunnel releasing bytes it had held back, from inside the very
        // callback that told it progress was made.
        scheduler.enqueue(messageSource(2, QosClass.INTERACTIVE));
      }
    };

    scheduler.enqueue(messageSource(1, QosClass.INTERACTIVE));
    await flush();

    // Both messages actually got written, in FIFO order: the follow-up
    // appended to a queue nobody was mid-iteration over, and the pump's own
    // "already pumping" guard let its nested call return immediately rather
    // than double-drive the loop.
    expect(written).toEqual([1, 2]);
  });

  it("does not let a throwing listener trigger onWriteError", async () => {
    const writeErrors: unknown[] = [];
    const written: number[] = [];
    const scheduler = new PriorityScheduler({
      write: async (frame) => {
        written.push(frame.streamId);
      },
      onWriteError: (error) => {
        writeErrors.push(error);
      },
      initialBulkCredits: 0,
      now: undefined,
    });
    scheduler.onFrameWritten = () => {
      throw new Error("listener blew up");
    };

    scheduler.enqueue(messageSource(1, QosClass.INTERACTIVE));
    await flush();

    expect(written).toEqual([1]);
    expect(writeErrors).toEqual([]);
  });
});

describe("InboundCreditTracker", () => {
  it("grants a batch of credits back after enough bulk frames are consumed", () => {
    const tracker = new InboundCreditTracker();
    for (let i = 0; i < FINE_INBOUND_CREDIT_GRANT_BATCH - 1; i += 1) {
      expect(tracker.onBulkFrameConsumed()).toBe(0);
    }
    expect(tracker.onBulkFrameConsumed()).toBe(FINE_INBOUND_CREDIT_GRANT_BATCH);
    expect(tracker.onBulkFrameConsumed()).toBe(0);
  });
});
