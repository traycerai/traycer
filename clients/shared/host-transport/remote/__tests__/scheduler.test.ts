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
  OutboundChunkSource,
} from "@traycer/protocol/host-transport/chunking";
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
