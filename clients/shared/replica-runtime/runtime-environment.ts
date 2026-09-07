/**
 * The ambient capabilities the replica runtime is allowed to use.
 * The chat plane already pays for this: `ChatSessionRegistry` calls `window.setTimeout` / `window.clearTimeout` directly, which is exactly the line the unified registry cannot carry across the worker boundary.
 */

/**
 * Wall-clock reads, injected.
 * Separate from {@link RuntimeScheduler} because the two are faked independently: a suite can advance timers without moving the clock, and a suite can move the clock without letting a timer fire.
 */
export interface RuntimeClock {
  /** Milliseconds since the epoch. Only ever compared, never formatted here. */
  now(): number;
}

/**
 * A scheduled callback that has not fired yet.
 * An object rather than a numeric id because the id type is platform-dependent (`number` in a DOM lib, `NodeJS.Timeout` under Node types) and the runtime is compiled under both.
 */
export interface RuntimeTimer {
  /** Idempotent: cancelling a timer that already fired is a no-op. */
  cancel(): void;
}

export interface RuntimeScheduler {
  /** Run `callback` after at least `delayMs`. */
  schedule(delayMs: number, callback: () => void): RuntimeTimer;
  /**
   * Run `callback` at the end of the current task, before the next one.
   * The coalescing primitive: the open-epic store schedules its `bindingVersion` bump this way so opening a canvas of N tiles costs one publication rather than N.
   */
  scheduleMicrotask(callback: () => void): void;
}

export type RuntimeLogFields = {
  readonly [key: string]: string | number | boolean | null;
};

/**
 * The runtime's logging seam.
 * Narrower than the gui's `appLogger` on purpose - it is a sink the host application supplies, not a logger the runtime configures.
 */
export interface RuntimeLogger {
  debug(message: string, fields: RuntimeLogFields): void;
  warn(message: string, fields: RuntimeLogFields): void;
  error(message: string, fields: RuntimeLogFields, error: unknown): void;
}

export interface RuntimeEnvironment {
  readonly clock: RuntimeClock;
  readonly scheduler: RuntimeScheduler;
  readonly logger: RuntimeLogger;
}

/**
 * A strictly increasing counter with no relationship to time.
 * The recency ordering behind every lru in this runtime, and deliberately not a clock read.
 */
export interface MonotonicSequence {
  /** The next value. Never repeats within one sequence's lifetime. */
  next(): number;
  /** The most recently issued value, or 0 before the first {@link next}. */
  current(): number;
}

export function createMonotonicSequence(): MonotonicSequence {
  let value = 0;
  return {
    next(): number {
      value += 1;
      return value;
    },
    current(): number {
      return value;
    },
  };
}
