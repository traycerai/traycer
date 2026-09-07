import type { DialPriority } from "./dial-priority";

/**
 * Process-wide cap on host WebSockets that are connecting. A slot is taken at native construction and released on first of open/error/close.
 * Wrapper close() is not a release; a cancelled dial that has not started is dequeued so Chromium never sees a handshake failure.
 */

/** Sits under Chromium's ~10 pending knee so Vite HMR and DevTools still have room. Workers must not get a second gate. */
const MAX_CONNECTING = 6;

const MAX_BACKGROUND_CONNECTING = 3;

/** Interactive drains fully before background. */
const DRAIN_ORDER: readonly DialPriority[] = ["interactive", "background"];

export interface DialTicket {
  /** True if this dequeued a not-yet-started dial; the caller then owes its own close. */
  cancel(): boolean;
  /** Idempotent. */
  release(): void;
}

export interface DialGateStats {
  readonly connecting: number;
  readonly connectingInteractive: number;
  readonly connectingBackground: number;
  readonly queued: number;
}

export interface DialGate {
  /** `start` runs once, never re-entrantly, always on a later microtask. */
  acquire(priority: DialPriority, start: () => void): DialTicket;
  stats(): DialGateStats;
}

interface QueueEntry {
  readonly priority: DialPriority;
  readonly start: () => void;
  started: boolean;
  cancelled: boolean;
  released: boolean;
}

/** Production shares one gate; this factory is the test seam. */
export function createDialGate(): DialGate {
  const queues: Record<DialPriority, QueueEntry[]> = {
    interactive: [],
    background: [],
  };
  /** Total connecting is derived from these; do not track a second counter beside them. */
  const connectingByPriority: Record<DialPriority, number> = {
    interactive: 0,
    background: 0,
  };
  const totalConnecting = (): number =>
    connectingByPriority.interactive + connectingByPriority.background;
  let pumping = false;

  /** Asked before draining so a background entry that cannot be admitted stays queued in order. */
  function canAdmit(priority: DialPriority): boolean {
    if (priority === "interactive") return true;
    return connectingByPriority.background < MAX_BACKGROUND_CONNECTING;
  }

  function takeNext(): QueueEntry | null {
    for (const priority of DRAIN_ORDER) {
      if (!canAdmit(priority)) continue;
      const queue = queues[priority];
      while (queue.length > 0) {
        const entry = queue.shift();
        if (entry === undefined) break;
        if (entry.cancelled) continue;
        return entry;
      }
    }
    return null;
  }

  function pump(): void {
    if (pumping) return;
    pumping = true;
    try {
      while (totalConnecting() < MAX_CONNECTING) {
        // Null is nothing admissible, not nothing queued; background at reserve waits for a release.
        const entry = takeNext();
        if (entry === null) return;
        entry.started = true;
        connectingByPriority[entry.priority] += 1;
        try {
          entry.start();
        } catch (cause) {
          // start threw before listeners were installed; release the slot here or the gate shrinks for the process lifetime.
          entry.released = true;
          connectingByPriority[entry.priority] -= 1;
          throw cause;
        }
      }
    } finally {
      pumping = false;
    }
  }

  return {
    acquire(priority: DialPriority, start: () => void): DialTicket {
      const entry: QueueEntry = {
        priority,
        start,
        started: false,
        cancelled: false,
        released: false,
      };
      queues[priority].push(entry);
      // Defer so start cannot run inside the caller's constructor.
      queueMicrotask(pump);
      return {
        cancel(): boolean {
          if (entry.started || entry.cancelled) return false;
          // Leave cancelled entries for takeNext to skip; splicing is O(n) on bulk cancel.
          entry.cancelled = true;
          return true;
        },
        release(): void {
          if (!entry.started || entry.released) return;
          entry.released = true;
          connectingByPriority[entry.priority] -= 1;
          pump();
        },
      };
    },

    stats(): DialGateStats {
      // Count still-waiting entries so a cancelled item is not a pending dial.
      const waiting = (queue: readonly QueueEntry[]): number =>
        queue.filter((entry) => !entry.cancelled).length;
      return {
        connecting: totalConnecting(),
        connectingInteractive: connectingByPriority.interactive,
        connectingBackground: connectingByPriority.background,
        queued: waiting(queues.interactive) + waiting(queues.background),
      };
    },
  };
}

/** Shared by unary and stream factories; a per-factory gate would double the cap. */
export const hostDialGate: DialGate = createDialGate();
