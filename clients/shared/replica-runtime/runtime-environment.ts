/**
 * The ambient capabilities the replica runtime is allowed to use.
 *
 * Everything the runtime needs from "the platform" arrives through this
 * object, and nothing else. That is not testing hygiene, it is the placement
 * decision made executable: the runtime is scheduled to move into a dedicated
 * Web Worker per renderer window, where `window`, `document`, React, and the
 * GUI's `appLogger` do not exist. A module that reaches for `window.setTimeout`
 * compiles today and throws the moment it is imported from a worker entry, and
 * the failure surfaces as a blank pane rather than as a build error - so the
 * boundary has to be a value that is passed in, not a global that happens to be
 * present.
 *
 * The chat plane already pays for this: `ChatSessionRegistry` calls
 * `window.setTimeout` / `window.clearTimeout` directly, which is exactly the
 * line the unified registry cannot carry across the worker boundary.
 */

/**
 * Wall-clock reads, injected.
 *
 * Separate from {@link RuntimeScheduler} because the two are faked
 * independently: a suite can advance timers without moving the clock, and a
 * suite can move the clock without letting a timer fire. Bundling them into one
 * object made both fakes one fake in the existing registries and is why some of
 * their TTL tests assert on the timer rather than on the elapsed time.
 */
export interface RuntimeClock {
  /** Milliseconds since the epoch. Only ever compared, never formatted here. */
  now(): number;
}

/**
 * A scheduled callback that has not fired yet.
 *
 * An object rather than a numeric id because the id type is platform-dependent
 * (`number` in a DOM lib, `NodeJS.Timeout` under Node types) and the runtime is
 * compiled under both. `host-transport/timer-handle.ts` solves the same problem
 * with an `infer` conditional; an opaque handle is cheaper here because nothing
 * in the runtime needs the underlying id.
 */
export interface RuntimeTimer {
  /** Idempotent: cancelling a timer that already fired is a no-op. */
  cancel(): void;
}

export interface RuntimeScheduler {
  /**
   * Run `callback` after at least `delayMs`. Firing later than requested is
   * legal and expected (a busy worker, a throttled background tab); firing
   * EARLIER is not, and nothing in the runtime may depend on a fired timer
   * meaning "exactly `delayMs` has elapsed" - re-check against
   * {@link RuntimeClock.now} instead. `ChatSessionRegistry.evictIfIdle` already
   * does this and it is the pattern the unified registry inherits.
   */
  schedule(delayMs: number, callback: () => void): RuntimeTimer;
  /**
   * Run `callback` at the end of the current task, before the next one.
   *
   * The coalescing primitive: the open-epic store schedules its
   * `bindingVersion` bump this way so opening a canvas of N tiles costs one
   * publication rather than N. Injected for the same reason as the timer -
   * `queueMicrotask` exists in workers but a fake must be able to drain it
   * synchronously.
   */
  scheduleMicrotask(callback: () => void): void;
}

/**
 * Structured log fields. Deliberately flat and scalar-only: these cross the
 * worker boundary by structured clone, and a nested object here is how a live
 * `Y.Doc` or a store handle ends up in a log call that then throws
 * `DataCloneError` at a point unrelated to the bug being logged.
 */
export type RuntimeLogFields = {
  readonly [key: string]: string | number | boolean | null;
};

/**
 * The runtime's logging seam.
 *
 * Narrower than the GUI's `appLogger` on purpose - it is a sink the host
 * application supplies, not a logger the runtime configures. `error` takes the
 * caught value as `unknown` because that is what a `catch` binding is; the
 * adapter on the other side is responsible for turning it into whatever its
 * transport wants.
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
 *
 * The recency ordering behind every LRU in this runtime, and deliberately not a
 * clock read. `OpenEpicSessionRegistry` and the artifact-room hot tier both
 * already use a counter, with the reason recorded on the latter: "a counter
 * rather than a clock so eviction order is deterministic under fake timers".
 * Two touches inside one millisecond are indistinguishable to `Date.now()`, so
 * a clock-ordered LRU evicts arbitrarily under exactly the conditions a test
 * creates.
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
