import { INBOUND_CREDIT_GRANT_BATCH } from "./config";
import {
  QosClass,
  type QosClassValue,
} from "@traycer/protocol/host-transport/mux";

/**
 * Priority scheduler with per-session bulk credits (Architecture §3, audit C2).
 *
 * Two send queues:
 *   - INTERACTIVE (high): keystrokes, live output, unary/control frames. Never
 *     credit-gated — it must not stall on a slow peer. Always drained first.
 *   - BULK (low): 64 KiB chunks of large transfers. Credit-gated and sent one
 *     frame at a time; between every frame the interactive queue is re-checked,
 *     so a keystroke preempts the next bulk chunk (interactivity under bulk).
 *
 * Writes are serialized (one in flight at a time) so per-stream FIFO survives
 * the async encode+encrypt: within a class the queue is FIFO, and a stream's
 * frames share one class (fixed at stream creation), so a stream never splits
 * across the two queues.
 */

export interface SchedulerItem {
  readonly qos: QosClassValue;
}

export interface PrioritySchedulerOptions<T extends SchedulerItem> {
  /** Serialized wire write (encode → Noise-encrypt → socket.send). */
  readonly write: (item: T) => Promise<void>;
  /** Invoked once if a write rejects; the pump stops and the session recovers. */
  readonly onWriteError: (error: unknown) => void;
  readonly initialBulkCredits: number;
}

export class PriorityScheduler<T extends SchedulerItem> {
  private readonly interactive: T[] = [];
  private readonly bulk: T[] = [];
  private readonly options: PrioritySchedulerOptions<T>;
  private bulkCredits: number;
  private pumping = false;
  private stopped = false;
  private paused = false;

  constructor(options: PrioritySchedulerOptions<T>) {
    this.options = options;
    this.bulkCredits = options.initialBulkCredits;
  }

  enqueue(item: T): void {
    if (this.stopped) {
      return;
    }
    if (item.qos === QosClass.BULK) {
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

  availableCredits(): number {
    return this.bulkCredits;
  }

  /**
   * Pauses draining WITHOUT dropping queued frames — used during a host blip
   * (`host_detached`), where the same Noise session resumes on `host_attached`.
   * Frames enqueued while paused are held (not lost to the relay, which has no
   * host to deliver to) and flushed on `resume`.
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

  queuedCount(): number {
    return this.interactive.length + this.bulk.length;
  }

  /**
   * Drops all queued frames and halts the pump — called when the underlying
   * session resets (a resume rebuilds the mux, so in-flight frames are re-driven
   * by the higher layer, never replayed blindly).
   */
  stop(): void {
    this.stopped = true;
    this.interactive.length = 0;
    this.bulk.length = 0;
  }

  private next(): T | null {
    const interactive = this.interactive.shift();
    if (interactive !== undefined) {
      return interactive;
    }
    if (this.bulk.length > 0 && this.bulkCredits > 0) {
      this.bulkCredits -= 1;
      const item = this.bulk.shift();
      return item ?? null;
    }
    return null;
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
        const item = this.next();
        if (item === null) {
          return;
        }
        await this.options.write(item);
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
 * Tracks inbound bulk frames consumed and tells the caller when to grant a
 * fresh batch of credits back to the peer (so the peer's send window reopens).
 * Coarse-grained on purpose — credit-return traffic must not itself be chatter.
 */
export class InboundCreditTracker {
  private consumed = 0;

  /** Records one consumed inbound bulk frame; returns credits to grant, or 0. */
  onBulkFrameConsumed(): number {
    this.consumed += 1;
    if (this.consumed >= INBOUND_CREDIT_GRANT_BATCH) {
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
