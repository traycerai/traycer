import type { RemoteSessionEvidence } from "@traycer/protocol/host-transport/remote/session";
import { RESTART_INTENT_EPISODE_MS } from "../../host-selection/selection-authority-engine";
import type { TimerHandle } from "../timer-handle";

/**
 * The evidence sink for sessions to the server pool, and the only one they
 * get. A pool session never reports to the selection authority: the pool is
 * not a host the authority may choose, and it holds no lease there.
 *
 * Whether the pool is reachable is read from the session cache, as for any
 * remote session (`hasReadyRemoteSession`). What this adds is the one fact
 * that cache cannot hold: a drain the pool ANNOUNCED. A pool instance going
 * away on purpose sends `HOST_RESTARTING` with a restart intent before its
 * socket closes; the session reports the intent first and the loss second,
 * and this turns the intent into a bounded hold, so the loss that follows
 * reads as a restart rather than an outage.
 *
 * The hold follows the authority's episode rule for a host's tombstone: the
 * FIRST receipt of a tombstone opens one fixed episode of
 * {@link RESTART_INTENT_EPISODE_MS}, a repeat of the same tombstone never
 * extends it, and the peer's own `expiresAt` is its clock, so it is not read.
 * A session that opens again ends the hold early.
 */
export class PoolSessionPresence implements RemoteSessionEvidence<"pool-direct"> {
  private readonly now: () => number;
  private readonly holds = new Map<
    string,
    { readonly until: number; readonly timer: TimerHandle }
  >();
  private readonly seenTombstoneIds = new Map<string, Set<string>>();
  private readonly listeners = new Set<() => void>();

  constructor(now: () => number) {
    this.now = now;
  }

  /** Whether `hostId`'s pool announced a drain whose hold has not lapsed. */
  isRestartExpected(hostId: string): boolean {
    const hold = this.holds.get(hostId);
    return hold !== undefined && this.now() < hold.until;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  sessionEstablished(hostId: string): void {
    this.endHold(hostId);
  }

  sessionLost(): void {
    // The loss itself reaches readers through the session cache's readiness
    // edge; a hold, if one is open, already covers it.
  }

  reportDialSuccess(hostId: string): void {
    this.endHold(hostId);
  }

  reportDialRefusal(): void {
    // A refused redial does not end an announced drain: the episode bound
    // does.
  }

  reportDialIndeterminate(): void {
    // Says nothing about the pool.
  }

  reportRestartIntent(hostId: string, tombstoneId: string): void {
    const seen = this.seenTombstoneIds.get(hostId) ?? new Set<string>();
    if (seen.has(tombstoneId)) {
      return;
    }
    seen.add(tombstoneId);
    this.seenTombstoneIds.set(hostId, seen);
    this.clearHoldTimer(hostId);
    const timer = setTimeout(() => {
      this.holds.delete(hostId);
      this.notify();
    }, RESTART_INTENT_EPISODE_MS);
    this.holds.set(hostId, {
      until: this.now() + RESTART_INTENT_EPISODE_MS,
      timer,
    });
    this.notify();
  }

  private endHold(hostId: string): void {
    if (!this.holds.has(hostId)) {
      return;
    }
    this.clearHoldTimer(hostId);
    this.holds.delete(hostId);
    this.notify();
  }

  private clearHoldTimer(hostId: string): void {
    const hold = this.holds.get(hostId);
    if (hold !== undefined) {
      clearTimeout(hold.timer);
    }
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

/** The app's one pool evidence sink. */
export const poolSessionPresence = new PoolSessionPresence(() => Date.now());
