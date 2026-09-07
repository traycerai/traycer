import type { TimerHandle } from "../timer-handle";
import {
  FINE_INBOUND_CREDIT_GRANT_BATCH,
  QosClass,
  type EncodeMuxFrameInput,
} from "@traycer/protocol/host-transport/mux";
import {
  ChunkPacer,
  type OutboundChunkSource,
} from "@traycer/protocol/host-transport/chunking";

/**
 * Priority scheduler with per-session bulk credits (Architecture §3, audit C2).
 * The unit of queued work is a logical message (`OutboundChunkSource`), not a frame: frames materialize one at a time as the pump pulls, drawing their per-stream `seq` at pull time.
 */

interface QueuedSource {
  readonly source: OutboundChunkSource;
  /** Enqueue order across both queues; the per-stream FIFO comparator. */
  readonly serial: number;
}

export interface PrioritySchedulerOptions {
  /** Serialized wire write (encode → Noise-encrypt → socket.send). */
  readonly write: (frame: EncodeMuxFrameInput) => Promise<void>;
  /** Invoked once if a write rejects; the pump stops and the session recovers. */
  readonly onWriteError: (error: unknown) => void;
  readonly initialBulkCredits: number;
  /** Injectable clock for the pacer + resume timer; `undefined` = `Date.now`. */
  readonly now: (() => number) | undefined;
}

export class PriorityScheduler {
  private readonly interactive: QueuedSource[] = [];
  private readonly bulk: QueuedSource[] = [];
  private readonly options: PrioritySchedulerOptions;
  private readonly now: () => number;
  private readonly pacer: ChunkPacer;
  private bulkCredits: number;
  private nextSerial = 0;
  private pumping = false;
  private stopped = false;
  private paused = false;
  private paceResumeTimer: TimerHandle | null = null;
  private paceResumeAtMs: number | null = null;

  constructor(options: PrioritySchedulerOptions) {
    this.options = options;
    this.now = options.now ?? (() => Date.now());
    this.pacer = new ChunkPacer(this.now);
    this.bulkCredits = options.initialBulkCredits;
  }

  enqueue(source: OutboundChunkSource): void {
    if (this.stopped) {
      return;
    }
    const item: QueuedSource = { source, serial: this.nextSerial++ };
    if (source.qos === QosClass.BULK) {
      this.bulk.push(item);
    } else {
      this.interactive.push(item);
    }
    void this.pump();
  }

  /** Replenishes bulk credits granted by the peer and resumes the pump. */
  grantCredits(credits: number): void {
    if (credits <= 0) {
      return;
    }
    this.bulkCredits += credits;
    void this.pump();
  }

  /**
   * Replaces the unspent send window once the peer's `openAck` proved it grants credits finely (`SESSION_CAPABILITY_FINE_CREDITS`).
   * In practice neither happens - no bulk frame can be pulled before the session is ready, so the window is still untouched when this runs - but if that ever stops being true, this fails toward the recoverable side.
   */
  adoptNegotiatedCreditWindow(credits: number): void {
    this.bulkCredits = credits;
    void this.pump();
  }

  availableCredits(): number {
    return this.bulkCredits;
  }

  /**
   * Pauses draining without dropping queued frames - used during a host blip (`host_detached`), where the same Noise session resumes on `host_attached`.
   */
  pause(): void {
    this.paused = true;
  }

  resume(): void {
    if (!this.paused) {
      return;
    }
    this.paused = false;
    void this.pump();
  }

  /** Queued messages (a mid-transfer chunk source still counts as one). */
  queuedCount(): number {
    return this.interactive.length + this.bulk.length;
  }

  /** Drops every queued message for one stream - including a partially-sent chunk source. */
  dropStreamOutbound(streamId: number): void {
    for (const queue of [this.interactive, this.bulk]) {
      for (let index = queue.length - 1; index >= 0; index -= 1) {
        if (queue[index].source.streamId === streamId) {
          queue.splice(index, 1);
        }
      }
    }
  }

  /**
   * Drops all queued frames and halts the pump - called when the underlying session resets (a resume rebuilds the mux, so in-flight frames are re-driven by the higher layer, never replayed blindly).
   */
  stop(): void {
    this.stopped = true;
    this.interactive.length = 0;
    this.bulk.length = 0;
    if (this.paceResumeTimer !== null) {
      clearTimeout(this.paceResumeTimer);
      this.paceResumeTimer = null;
    }
  }

  private blockedByOtherQueue(
    other: readonly QueuedSource[],
    item: QueuedSource,
  ): boolean {
    for (const candidate of other) {
      if (
        candidate.source.streamId === item.source.streamId &&
        candidate.serial < item.serial
      ) {
        return true;
      }
    }
    return false;
  }

  private pullFromQueue(
    queue: QueuedSource[],
    other: readonly QueuedSource[],
  ): EncodeMuxFrameInput | null {
    // Streams already passed over in this scan: a later item for one of them
    // must not overtake the earlier item that was skipped.
    const blockedStreams = new Set<number>();
    for (let index = 0; index < queue.length; index += 1) {
      const item = queue[index];
      const streamId = item.source.streamId;
      if (blockedStreams.has(streamId)) {
        continue;
      }
      if (this.blockedByOtherQueue(other, item)) {
        blockedStreams.add(streamId);
        continue;
      }
      const frameBytes = item.source.nextFrameByteSize;
      if (!this.pacer.tryConsume(frameBytes)) {
        this.notePaceWait(this.pacer.msUntilAvailable(frameBytes));
        blockedStreams.add(streamId);
        continue;
      }
      const frame = item.source.nextFrame();
      if (item.source.done) {
        queue.splice(index, 1);
      }
      return frame;
    }
    return null;
  }

  private next(): EncodeMuxFrameInput | null {
    const interactive = this.pullFromQueue(this.interactive, this.bulk);
    if (interactive !== null) {
      return interactive;
    }
    if (this.bulk.length > 0 && this.bulkCredits > 0) {
      const bulk = this.pullFromQueue(this.bulk, this.interactive);
      if (bulk !== null) {
        this.bulkCredits -= 1;
        return bulk;
      }
    }
    return null;
  }

  private notePaceWait(waitMs: number): void {
    const resumeAt = this.now() + waitMs;
    if (this.paceResumeAtMs === null || resumeAt < this.paceResumeAtMs) {
      this.paceResumeAtMs = resumeAt;
    }
  }

  private armPaceResume(): void {
    const resumeAt = this.paceResumeAtMs;
    this.paceResumeAtMs = null;
    if (
      resumeAt === null ||
      this.stopped ||
      this.paused ||
      this.paceResumeTimer !== null
    ) {
      return;
    }
    const delay = Math.max(1, resumeAt - this.now());
    this.paceResumeTimer = setTimeout(() => {
      this.paceResumeTimer = null;
      void this.pump();
    }, delay);
  }

  private async pump(): Promise<void> {
    if (this.pumping || this.stopped || this.paused) {
      return;
    }
    this.pumping = true;
    try {
      for (;;) {
        if (this.stopped || this.paused) {
          return;
        }
        this.paceResumeAtMs = null;
        const frame = this.next();
        if (frame === null) {
          this.armPaceResume();
          return;
        }
        await this.options.write(frame);
      }
    } catch (error) {
      try {
        this.options.onWriteError(error);
      } catch {
        // onWriteError must not throw; swallow to avoid an unhandled rejection.
      }
    } finally {
      this.pumping = false;
    }
  }
}

/**
 * Tracks inbound bulk frames consumed and tells the caller when to grant a fresh batch of credits back to the peer (so the peer's send window reopens).
 * It is the send window that must not shrink without the peer's consent.
 */
export class InboundCreditTracker {
  private consumed = 0;

  /** Records one consumed inbound bulk frame; returns credits to grant, or 0. */
  onBulkFrameConsumed(): number {
    this.consumed += 1;
    if (this.consumed >= FINE_INBOUND_CREDIT_GRANT_BATCH) {
      const grant = this.consumed;
      this.consumed = 0;
      return grant;
    }
    return 0;
  }

  reset(): void {
    this.consumed = 0;
  }
}
