/**
 * Behavioural coverage for the replica-runtime interface seam (T2 of the
 * epic-sync-overhaul story).
 *
 * Two halves:
 *  1. The pure helpers' invariants — the ones a naive re-implementation is
 *     most likely to get wrong (epoch replacement vs advance, transaction
 *     buffering, generation-guard suppression, NUL-separated keys).
 *  2. A conformance smoke test: minimal in-memory implementations of
 *     `Replica`, `LaneAdapter`, `AdapterHost`, `SessionRegistryPolicy` and
 *     `LeaseMaterializer`, proving the interfaces are implementable with no
 *     DOM and no real timers — the worker-portability requirement made
 *     executable.
 */
import { describe, it, expect, vi, type Mock } from "vitest";

import {
  createMonotonicSequence,
  type RuntimeEnvironment,
} from "../runtime-environment";
import {
  compareLaneCursors,
  advancesLaneCursor,
  type LaneCursor,
} from "../lane-cursor";
import { createTransactionalProjectionSink } from "../projection-sink";
import { unknownFreshness } from "../freshness";
import { createGenerationGuard, guardHandler } from "../generation-guard";
import {
  sessionKeyOf,
  sessionKeyPartsOf,
  createSessionRegistry,
  type SessionRegistryPolicy,
  type SessionDisposeCause,
  type SessionDisposeVerdict,
  type WarmCapScope,
} from "../session-registry";
import type {
  Replica,
  ReplicaApplyOutcome,
  ReplicaReplacementReason,
  ReplicaResetCause,
  ReplicaTransitionToken,
} from "../replica";
import { resumeTooOldTransition } from "../replica";
import type { AdapterHost, LaneAdapter } from "../adapter";
import type {
  LeaseGrant,
  LeaseHandle,
  LeaseMaterializer,
  LeaseRegistry,
} from "../lease";
import type { DocReplicaEvent } from "../replica-events";

// ─── createMonotonicSequence ────────────────────────────────────────────────

describe("createMonotonicSequence", () => {
  it("starts at 0 before the first next()", () => {
    const seq = createMonotonicSequence();
    expect(seq.current()).toBe(0);
  });

  it("is strictly increasing and current() tracks the last issued value", () => {
    const seq = createMonotonicSequence();
    const values = [seq.next(), seq.next(), seq.next()];
    expect(values).toEqual([1, 2, 3]);
    expect(seq.current()).toBe(3);
  });
});

// ─── compareLaneCursors / advancesLaneCursor ───────────────────────────────

function cursor(
  authorityEpoch: string,
  lane: string,
  position: number,
): LaneCursor {
  return { authorityEpoch, lane, position };
}

describe("compareLaneCursors", () => {
  it("orders same-epoch, same-lane cursors by position", () => {
    expect(
      compareLaneCursors(cursor("e1", "a", 5), cursor("e1", "a", 10)),
    ).toBe("before");
    expect(
      compareLaneCursors(cursor("e1", "a", 10), cursor("e1", "a", 5)),
    ).toBe("after");
    expect(compareLaneCursors(cursor("e1", "a", 5), cursor("e1", "a", 5))).toBe(
      "same",
    );
  });

  it("is incomparable across differing epochs, never an ordering", () => {
    // Same lane, same position, different epoch — a naive comparator would
    // fold this to "same" by comparing only position.
    expect(compareLaneCursors(cursor("e1", "a", 5), cursor("e2", "a", 5))).toBe(
      "incomparable",
    );
    // "e2" vs "e10": string-lexicographic order says "e10" < "e2", numeric
    // order (if the epoch were mistakenly parsed as a number) says 2 < 10.
    // Neither ordering is legal — only equality is — so this pair would slip
    // through as "after" or "before" if `compareLaneCursors` were ever
    // "fixed" into a lexicographic or numeric comparison instead of an
    // equality check.
    expect(
      compareLaneCursors(cursor("e2", "a", 5), cursor("e10", "a", 100)),
    ).toBe("incomparable");
  });

  it("is incomparable across differing lanes, never an ordering", () => {
    expect(compareLaneCursors(cursor("e1", "a", 5), cursor("e1", "b", 5))).toBe(
      "incomparable",
    );
  });
});

describe("advancesLaneCursor", () => {
  it("accepts anything against a null held cursor", () => {
    expect(advancesLaneCursor(null, cursor("e1", "a", 0))).toBe(true);
  });

  it("rejects an equal position as an advance", () => {
    expect(advancesLaneCursor(cursor("e1", "a", 5), cursor("e1", "a", 5))).toBe(
      false,
    );
  });

  it("rejects a behind position as an advance", () => {
    expect(advancesLaneCursor(cursor("e1", "a", 5), cursor("e1", "a", 3))).toBe(
      false,
    );
  });

  it("accepts a strictly ahead same-epoch position", () => {
    expect(advancesLaneCursor(cursor("e1", "a", 5), cursor("e1", "a", 6))).toBe(
      true,
    );
  });

  it("rejects an epoch change as an advance — replacement, not advance", () => {
    // The one a naive implementation is most likely to "fix" into true: a
    // far-ahead position under a bumped, opaque, NON-sequential epoch still
    // must not read as an advance. "room-a" -> "room-b" cannot be satisfied
    // by accidental lexicographic or numeric ordering the way "e1" -> "e2"
    // could be.
    expect(
      advancesLaneCursor(cursor("room-a", "a", 5), cursor("room-b", "a", 100)),
    ).toBe(false);
  });
});

// ─── createTransactionalProjectionSink ─────────────────────────────────────

describe("createTransactionalProjectionSink", () => {
  it("delivers immediately outside a transaction and bumps revision by 1", () => {
    const deliver = vi.fn();
    const sink = createTransactionalProjectionSink<number>(0, deliver);

    sink.publish(1);

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith(1, 1);
    expect(sink.revision()).toBe(1);
    expect(sink.read()).toBe(1);
  });

  it("delivers once with the last value for three publishes in one transaction", () => {
    const deliver = vi.fn();
    const sink = createTransactionalProjectionSink<number>(0, deliver);

    sink.transact(() => {
      sink.publish(1);
      sink.publish(2);
      sink.publish(3);
    });

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith(3, 1);
    expect(sink.revision()).toBe(1);
  });

  it("delivers nothing and does not bump revision for an empty transaction", () => {
    const deliver = vi.fn();
    const sink = createTransactionalProjectionSink<number>(0, deliver);

    sink.transact(() => {
      // no publish
    });

    expect(deliver).not.toHaveBeenCalled();
    expect(sink.revision()).toBe(0);
  });

  it("delivers only on the outermost exit of nested transactions", () => {
    const deliver = vi.fn();
    const sink = createTransactionalProjectionSink<number>(0, deliver);

    sink.transact(() => {
      sink.publish(1);
      sink.transact(() => {
        sink.publish(2);
      });
      expect(deliver).not.toHaveBeenCalled();
      sink.publish(3);
    });

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith(3, 1);
    expect(sink.revision()).toBe(1);
  });

  it("read() inside an open transaction returns the buffered value", () => {
    const deliver = vi.fn();
    const sink = createTransactionalProjectionSink<number>(0, deliver);

    sink.transact(() => {
      sink.publish(42);
      expect(sink.read()).toBe(42);
    });
  });

  it("delivers what was published and rethrows when body() throws", () => {
    const deliver = vi.fn();
    const sink = createTransactionalProjectionSink<number>(0, deliver);

    expect(() =>
      sink.transact(() => {
        sink.publish(7);
        throw new Error("boom");
      }),
    ).toThrow("boom");

    // A partially applied transaction is still the runtime's current state.
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith(7, 1);
    expect(sink.read()).toBe(7);
    expect(sink.revision()).toBe(1);
  });
});

// ─── createGenerationGuard / guardHandler ──────────────────────────────────

describe("createGenerationGuard / guardHandler", () => {
  it("stops a handler wrapped at a retired generation from firing", () => {
    const guard = createGenerationGuard();
    const generationOne = guard.current(); // 0
    const inner = vi.fn();
    const wrapped = guardHandler(guard, generationOne, inner);

    guard.next(); // retires generation 0

    wrapped("frame");

    // Vacuous "no error thrown" proves nothing here — assert the inner
    // handler was never invoked.
    expect(inner).not.toHaveBeenCalled();
  });

  it("fires the handler bound to the new generation", () => {
    const guard = createGenerationGuard();
    guard.next();
    const currentGeneration = guard.current();
    const inner = vi.fn();
    const wrapped = guardHandler(guard, currentGeneration, inner);

    wrapped("frame");

    expect(inner).toHaveBeenCalledTimes(1);
    expect(inner).toHaveBeenCalledWith("frame");
  });

  it("current() starts at 0 and next() returns the retired-into generation", () => {
    const guard = createGenerationGuard();
    expect(guard.current()).toBe(0);
    expect(guard.next()).toBe(1);
    expect(guard.current()).toBe(1);
  });
});

// ─── sessionKeyOf ───────────────────────────────────────────────────────────

describe("sessionKeyOf", () => {
  it("produces different keys for different part tuples", () => {
    expect(sessionKeyOf(["a", "b"])).not.toBe(sessionKeyOf(["a", "c"]));
  });

  it("does not collide when a part itself contains the printable ':' separator", () => {
    // The original reason to abandon a `:`-joined key: it would fold these two
    // distinct tuples onto the same string ("a:b:c"). Kept as a control - the
    // length-prefixed encoding must still satisfy the property that motivated
    // the NUL one it replaced.
    const left = sessionKeyOf(["a:b", "c"]);
    const right = sessionKeyOf(["a", "b:c"]);
    expect(left).not.toBe(right);
  });

  it("does not collide when a part contains a NUL either", () => {
    // THE REDDENING ONE. A NUL-joined key folds these two exactly as a
    // `:`-joined key folds the pair above, and the argument its doc made for
    // NUL ("no id can contain a NUL") is the same unenforced claim that doc
    // rejects for `:` one line earlier. Nothing excludes U+0000: the protocol
    // fields are bare `z.string()`, JSON carries it, and a `hostId` is adopted
    // verbatim from `~/.traycer/host-id` with only a `trim()`, which does not
    // strip NUL because NUL is not whitespace.
    const left = sessionKeyOf(["a\u0000b", "c"]);
    const right = sessionKeyOf(["a", "b\u0000c"]);
    expect(left).not.toBe(right);
  });

  it("round-trips every part back out, NUL and separators included", () => {
    // The decode half has to survive the same inputs: `chatSessionKeyHostId`
    // reads the host back OUT of the key rather than mirroring it on the entry.
    const parts = ["epic\u0000one", "chat:two", "", "host\u0000:three"];
    expect(sessionKeyPartsOf(sessionKeyOf(parts))).toEqual(parts);
  });
});

// ─── unknownFreshness ───────────────────────────────────────────────────────

describe("unknownFreshness", () => {
  it("reports unknown status with null watermark and null trust, not a defaulted verdict", () => {
    const freshness = unknownFreshness("epic-1", "records");
    expect(freshness).toEqual({
      planeId: "epic-1",
      dataClass: "records",
      status: "unknown",
      watermark: null,
      observedAtMs: null,
      trust: null,
      degradedReason: null,
    });
  });
});

// ─── Conformance smoke test ─────────────────────────────────────────────────
//
// Minimal in-memory implementations proving the seam is implementable with
// no DOM and no real timers. A fake `RuntimeEnvironment` drives a fake
// `LaneAdapter` feeding a fake `Replica` through a fake `AdapterHost`.

interface FakeRow {
  readonly label: string;
}

type FakeEvent =
  | {
      readonly kind: "upsert";
      readonly rowId: string;
      readonly revision: number;
      readonly row: FakeRow;
    }
  | {
      readonly kind: "remove";
      readonly rowId: string;
      readonly revision: number;
    };

type FakeProjection = readonly {
  readonly rowId: string;
  readonly row: FakeRow;
}[];

/** A controllable clock/scheduler with no real timers and no DOM. */
interface FakeTimerEntry {
  readonly fireAt: number;
  readonly callback: () => void;
}

/**
 * The injected environment, with the clock and the scheduler independently
 * controllable — a suite has to be able to advance timers without moving the
 * clock, and move the clock without letting a timer fire, or the early-fire
 * re-check can never be exercised.
 *
 * **Firing is the fake's job, never a test's.** A timer fires only by leaving
 * this object's pending list, so an entry can never fire twice. That is not
 * tidiness: a test that hand-invokes a captured `schedule` callback leaves the
 * fake's own entry live, and the STALE entry then fires on the next
 * `advanceClock` — so an assertion meant to prove a re-armed timer did the work
 * is satisfied by the original one, and stays green with the re-arm removed
 * entirely. {@link fireDueTimerEarly} is the sanctioned way to simulate a
 * throttled background tab.
 */
function createFakeEnvironment(): RuntimeEnvironment & {
  advanceClock(ms: number): void;
  drainMicrotasks(): void;
  /**
   * Fire the earliest live timer WITHOUT moving the clock, and remove it —
   * exactly what a throttled tab does. Returns false when nothing is pending.
   */
  fireDueTimerEarly(): boolean;
  /** When the earliest live timer is due, or `null` when none is pending. */
  nextTimerFireAt(): number | null;
  pendingTimerCount(): number;
} {
  let nowMs = 0;
  let pendingTimers: FakeTimerEntry[] = [];
  const pendingMicrotasks: (() => void)[] = [];

  const remove = (entry: FakeTimerEntry): void => {
    pendingTimers = pendingTimers.filter((candidate) => candidate !== entry);
  };
  const earliest = (): FakeTimerEntry | null =>
    pendingTimers.reduce<FakeTimerEntry | null>(
      (best, entry) =>
        best === null || entry.fireAt < best.fireAt ? entry : best,
      null,
    );

  return {
    clock: {
      now(): number {
        return nowMs;
      },
    },
    scheduler: {
      schedule(delayMs, callback) {
        const entry: FakeTimerEntry = { fireAt: nowMs + delayMs, callback };
        pendingTimers.push(entry);
        return {
          cancel(): void {
            remove(entry);
          },
        };
      },
      scheduleMicrotask(callback) {
        pendingMicrotasks.push(callback);
      },
    },
    logger: {
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    advanceClock(ms: number): void {
      nowMs += ms;
      // Collect, remove, then invoke — a callback that re-arms must not be
      // fired again by the same pass, and the re-armed entry must be judged
      // against the clock as it now stands rather than mid-iteration. Bounded
      // so a pathological immediately-due re-arm surfaces as a failed test
      // rather than a hung suite.
      for (let pass = 0; pass < 100; pass += 1) {
        const due = pendingTimers.filter((entry) => entry.fireAt <= nowMs);
        if (due.length === 0) return;
        for (const entry of due) remove(entry);
        for (const entry of due) entry.callback();
      }
      throw new Error("fake scheduler: timers re-armed as due 100 times");
    },
    fireDueTimerEarly(): boolean {
      const entry = earliest();
      if (entry === null) return false;
      remove(entry);
      entry.callback();
      return true;
    },
    nextTimerFireAt(): number | null {
      return earliest()?.fireAt ?? null;
    },
    pendingTimerCount(): number {
      return pendingTimers.length;
    },
    drainMicrotasks(): void {
      while (pendingMicrotasks.length > 0) {
        const next = pendingMicrotasks.shift();
        next?.();
      }
    },
  };
}

/** A minimal in-memory `Replica<FakeEvent, FakeProjection>` for one records plane. */
function createFakeReplica(planeId: string): Replica<
  FakeEvent,
  FakeProjection
> & {
  readonly resetCauses: ReplicaResetCause[];
} {
  const rows = new Map<string, { revision: number; row: FakeRow }>();
  let disposed = false;
  let seeded = false;
  let currentWatermark: LaneCursor | null = null;
  const resetCauses: ReplicaResetCause[] = [];
  const sink = createTransactionalProjectionSink<FakeProjection>([], () => {
    // Reference sink; the smoke test reads through `replica.sink.read()`.
  });

  return {
    planeId,
    dataClass: "records",
    resetCauses,
    apply(event: FakeEvent): ReplicaApplyOutcome {
      if (disposed) return { kind: "ignored", reason: "disposed" };
      const held = rows.get(event.rowId);
      if (held !== undefined && event.revision <= held.revision) {
        return { kind: "ignored", reason: "stale-revision" };
      }
      if (event.kind === "upsert") {
        rows.set(event.rowId, { revision: event.revision, row: event.row });
      } else {
        rows.delete(event.rowId);
      }
      seeded = true;
      return { kind: "applied", cursor: currentWatermark };
    },
    project(): void {
      sink.publish(
        Array.from(rows.entries()).map(([rowId, entry]) => ({
          rowId,
          row: entry.row,
        })),
      );
    },
    sink,
    watermark(): LaneCursor | null {
      return currentWatermark;
    },
    freshness() {
      // Not hardcoded to "unknown": the reset tests below rely on this
      // actually flipping to "live" after an apply and back after a reset.
      if (!seeded) return unknownFreshness(planeId, "records");
      return {
        planeId,
        dataClass: "records",
        status: "live",
        watermark: currentWatermark,
        observedAtMs: null,
        trust: null,
        degradedReason: null,
      };
    },
    reset(cause: ReplicaResetCause): void {
      resetCauses.push(cause);
      rows.clear();
      currentWatermark = null;
      seeded = false;
      sink.publish([]);
    },
    dispose(): void {
      disposed = true;
      rows.clear();
    },
  };
}

/** A minimal in-memory `AdapterHost<FakeEvent>` wrapping a replica. */
function createFakeAdapterHost(
  environment: RuntimeEnvironment,
  replica: Replica<FakeEvent, FakeProjection> & {
    reset(cause: ReplicaResetCause): void;
  },
): AdapterHost<FakeEvent> & { readonly outcomes: ReplicaApplyOutcome[] } {
  const outcomes: ReplicaApplyOutcome[] = [];
  return {
    environment,
    outcomes,
    emit(event: FakeEvent): void {
      outcomes.push(replica.apply(event));
    },
    reportResume(): void {
      // Smoke test does not exercise resume outcomes.
    },
    reportStatus(): void {
      // Smoke test does not exercise connection status.
    },
    requestReplacement(reason: ReplicaReplacementReason): void {
      // `transition` is accepted and ignored here on purpose: it is the
      // RUNTIME's coalescing key, and this smoke fake has no coalescer.
      // The runtime side of the seam: `AdapterHost.requestReplacement` is
      // deliberately narrow — an adapter can only hand it an authority
      // reason — and it is the runtime, not the adapter, that turns that
      // into the ONE reset entry point. A client-requested reseed can never
      // reach the replica through this path.
      replica.reset({ origin: "authority", reason });
    },
  };
}

/** A minimal in-memory `LaneAdapter<FakeEvent>` with a test-only frame pump. */
function createFakeLaneAdapter(laneId: string): LaneAdapter<FakeEvent> & {
  pushFrame(events: readonly FakeEvent[]): void;
  triggerReplacementRequest(
    reason: ReplicaReplacementReason,
    transition: ReplicaTransitionToken,
  ): void;
  readonly detachReasons: string[];
} {
  let host: AdapterHost<FakeEvent> | null = null;
  const detachReasons: string[] = [];
  return {
    descriptor: { laneId, kind: "lane", label: "fake lane" },
    detachReasons,
    attach(nextHost: AdapterHost<FakeEvent>): void {
      host = nextHost;
    },
    resumeOffer() {
      // The cursored-lane form of the union: a records/log adapter offers a
      // cursor, never a bare `LaneCursor`.
      return { kind: "cursor", cursor: cursor("e1", laneId, 0) };
    },
    detach(reason): void {
      detachReasons.push(reason);
      host = null;
    },
    pushFrame(events: readonly FakeEvent[]): void {
      if (host === null) throw new Error("adapter not attached");
      for (const event of events) host.emit(event);
    },
    triggerReplacementRequest(
      reason: ReplicaReplacementReason,
      transition: ReplicaTransitionToken,
    ): void {
      if (host === null) throw new Error("adapter not attached");
      // `AdapterHost.requestReplacement` is the only path an adapter has to
      // this — its signature accepts a `ReplicaReplacementReason`, never a
      // `ReplicaResetCause`, so a client-origin cause cannot even be
      // constructed at this call site.
      host.requestReplacement(reason, transition);
    },
  };
}

describe("Replica / LaneAdapter / AdapterHost conformance smoke test", () => {
  it("drives a fake environment with no DOM and no real timers", () => {
    const environment = createFakeEnvironment();
    let fired = false;
    environment.scheduler.schedule(1000, () => {
      fired = true;
    });
    expect(fired).toBe(false);
    environment.advanceClock(999);
    expect(fired).toBe(false);
    environment.advanceClock(1);
    expect(fired).toBe(true);

    let ran = false;
    environment.scheduler.scheduleMicrotask(() => {
      ran = true;
    });
    expect(ran).toBe(false);
    environment.drainMicrotasks();
    expect(ran).toBe(true);
  });

  it("applies the first event and ignores the second as stale-revision", () => {
    const environment = createFakeEnvironment();
    const replica = createFakeReplica("epic-1");
    const host = createFakeAdapterHost(environment, replica);
    const adapter = createFakeLaneAdapter("epic.state.subscribe@1.0");

    adapter.attach(host);
    // The cursored-lane arm of the `ResumeOffer` union — a records/log
    // adapter's offer, distinct from the doc class's `doc-seed` arm below.
    expect(adapter.resumeOffer()).toEqual({
      kind: "cursor",
      cursor: cursor("e1", "epic.state.subscribe@1.0", 0),
    });
    adapter.pushFrame([
      { kind: "upsert", rowId: "row-1", revision: 2, row: { label: "second" } },
      // Same or lower revision than what was just applied — must be dropped,
      // not merged and not thrown.
      { kind: "upsert", rowId: "row-1", revision: 1, row: { label: "stale" } },
    ]);
    replica.project();

    expect(host.outcomes).toEqual([
      { kind: "applied", cursor: null },
      { kind: "ignored", reason: "stale-revision" },
    ]);
    expect(replica.sink.read()).toEqual([
      { rowId: "row-1", row: { label: "second" } },
    ]);

    adapter.detach("disposed");
    expect(adapter.detachReasons).toEqual(["disposed"]);

    replica.dispose();
    expect(
      replica.apply({
        kind: "upsert",
        rowId: "row-2",
        revision: 1,
        row: { label: "x" },
      }),
    ).toEqual({ kind: "ignored", reason: "disposed" });
  });
});

// ─── SessionRegistryPolicy conformance ─────────────────────────────────────

interface FakeSession {
  busy: boolean;
  clean: boolean;
  disposed: boolean;
}

function createFakeSessionPolicy(): SessionRegistryPolicy<FakeSession> {
  return {
    idleTtlMs: 60_000,
    maxWarm: 4,
    warmCapScope: "demand-free",
    busyCountsTowardWarmCap: true,
    maxActiveDeferMs: 30_000,
    refreshOrderOnRelease: true,
    retainWhenIdle(): boolean {
      return true;
    },
    hasActiveWork(session: FakeSession): boolean {
      return session.busy;
    },
    isEvictable(session: FakeSession): boolean {
      return session.clean;
    },
    onBeforeDispose(session: FakeSession, cause) {
      if (cause === "idle-expired" && !session.clean) return "retain";
      return "dispose";
    },
    dispose(session: FakeSession): void {
      session.disposed = true;
    },
    onParked(): void {},
    onRevived(): void {},
  };
}

describe("SessionRegistryPolicy conformance", () => {
  it("is implementable and drives dispose/retain from plane-supplied predicates", () => {
    const policy = createFakeSessionPolicy();

    const dirtySession: FakeSession = {
      busy: false,
      clean: false,
      disposed: false,
    };
    expect(policy.hasActiveWork(dirtySession)).toBe(false);
    expect(policy.isEvictable(dirtySession)).toBe(false);
    expect(policy.onBeforeDispose(dirtySession, "idle-expired")).toBe("retain");

    const cleanSession: FakeSession = {
      busy: false,
      clean: true,
      disposed: false,
    };
    expect(policy.onBeforeDispose(cleanSession, "idle-expired")).toBe(
      "dispose",
    );
    policy.dispose(cleanSession);
    expect(cleanSession.disposed).toBe(true);
  });
});

// ─── createSessionRegistry ──────────────────────────────────────────────────
//
// The unified registry behind chats, terminals, and open-epic sessions. These
// cases target the policy knobs new to the unification — the ones an
// implementation that hardcoded one plane's answer, or dropped a knob
// entirely, would still pass every OTHER test here while getting wrong.

interface RegSession {
  readonly id: string;
  busy: boolean;
  evictable: boolean;
  disposed: boolean;
}

function makeSession(id: string): RegSession {
  return { id, busy: false, evictable: true, disposed: false };
}

interface PolicyConfig {
  readonly idleTtlMs: number | null;
  readonly maxWarm: number;
  readonly warmCapScope: WarmCapScope;
  readonly busyCountsTowardWarmCap: boolean;
  readonly maxActiveDeferMs: number | null;
  readonly refreshOrderOnRelease: boolean;
  readonly retainWhenIdle: (session: RegSession) => boolean;
  readonly onBeforeDisposeVerdict: (
    session: RegSession,
    cause: SessionDisposeCause,
  ) => SessionDisposeVerdict;
  /**
   * What `onRevived` throws, or `null` for the ordinary revival.
   *
   * Not hypothetical: the terminal plane's `onRevived` retags the session
   * `presentation`, and that `setViewer` reconstructs the stream
   * SYNCHRONOUSLY - which throws when the captured transport or directory has
   * since disappeared.
   */
  readonly onRevivedError: Error | null;
}

function defaultPolicyConfig(): PolicyConfig {
  return {
    idleTtlMs: 10_000,
    maxWarm: 10,
    warmCapScope: "demand-free",
    busyCountsTowardWarmCap: true,
    maxActiveDeferMs: null,
    refreshOrderOnRelease: true,
    retainWhenIdle: () => true,
    onBeforeDisposeVerdict: () => "dispose",
    onRevivedError: null,
  };
}

type TrackedPolicy = SessionRegistryPolicy<RegSession> & {
  readonly disposeSpy: Mock;
  readonly onParkedSpy: Mock;
  readonly onRevivedSpy: Mock;
};

function createTrackedPolicy(config: PolicyConfig): TrackedPolicy {
  const disposeSpy = vi.fn();
  const onParkedSpy = vi.fn();
  const onRevivedSpy = vi.fn();
  return {
    idleTtlMs: config.idleTtlMs,
    maxWarm: config.maxWarm,
    warmCapScope: config.warmCapScope,
    busyCountsTowardWarmCap: config.busyCountsTowardWarmCap,
    maxActiveDeferMs: config.maxActiveDeferMs,
    refreshOrderOnRelease: config.refreshOrderOnRelease,
    retainWhenIdle: config.retainWhenIdle,
    hasActiveWork(session: RegSession): boolean {
      return session.busy;
    },
    isEvictable(session: RegSession): boolean {
      return session.evictable;
    },
    onBeforeDispose: config.onBeforeDisposeVerdict,
    dispose(session: RegSession): void {
      session.disposed = true;
      disposeSpy(session.id);
    },
    onParked(session: RegSession): void {
      onParkedSpy(session.id);
    },
    onRevived(session: RegSession): void {
      onRevivedSpy(session.id);
      if (config.onRevivedError !== null) throw config.onRevivedError;
    },
    disposeSpy,
    onParkedSpy,
    onRevivedSpy,
  };
}

describe("createSessionRegistry", () => {
  describe("warmCapScope", () => {
    it('"demand-free" excludes held sessions from the cap entirely — N held + 1 warm evicts nothing under maxWarm 1', () => {
      const environment = createFakeEnvironment();
      const config: PolicyConfig = {
        ...defaultPolicyConfig(),
        maxWarm: 1,
        warmCapScope: "demand-free",
        idleTtlMs: null,
      };
      const policy = createTrackedPolicy(config);
      const registry = createSessionRegistry({ environment, policy });

      registry.acquire("held-1", "scope", () => makeSession("held-1"));
      registry.acquire("held-2", "scope", () => makeSession("held-2"));
      registry.acquire("warm-1", "scope", () => makeSession("warm-1"));
      registry.release("warm-1", "warm");

      expect(registry.peek("held-1")).not.toBeNull();
      expect(registry.peek("held-2")).not.toBeNull();
      expect(registry.peek("warm-1")).not.toBeNull();
      expect(policy.disposeSpy).not.toHaveBeenCalled();
    });

    it('"all-entries" counts a held session toward the cap but never evicts it — the demand-free entry is evicted instead', () => {
      const environment = createFakeEnvironment();
      const config: PolicyConfig = {
        ...defaultPolicyConfig(),
        maxWarm: 1,
        warmCapScope: "all-entries",
        idleTtlMs: null,
      };
      const policy = createTrackedPolicy(config);
      const registry = createSessionRegistry({ environment, policy });

      const held = registry.acquire("held-1", "scope", () =>
        makeSession("held-1"),
      );
      registry.acquire("warm-1", "scope", () => makeSession("warm-1"));
      registry.release("warm-1", "warm");

      // The held session counted toward the cap (it is why warm-1 overflowed)
      // but was never itself a candidate.
      expect(registry.peek("held-1")).toBe(held);
      expect(registry.peek("warm-1")).toBeNull();
      expect(policy.disposeSpy).toHaveBeenCalledWith("warm-1");
    });
  });

  describe("a warm revival that FAILS", () => {
    it("tears the entry down and rethrows, rather than leaving an unreachable entry with positive demand", () => {
      const environment = createFakeEnvironment();
      const revivalFailure = new Error("setViewer: the transport is gone");
      const config: PolicyConfig = {
        ...defaultPolicyConfig(),
        onRevivedError: revivalFailure,
      };
      const policy = createTrackedPolicy(config);
      const registry = createSessionRegistry({ environment, policy });

      registry.acquire("s", "scope", () => makeSession("s"));
      registry.release("s", "warm");
      expect(registry.peek("s")).not.toBeNull();
      // Parked: one idle window armed, and it is the only thing that would
      // ever reclaim this entry.
      expect(environment.pendingTimerCount()).toBe(1);

      expect(() =>
        registry.acquire("s", "scope", () => makeSession("s")),
      ).toThrow(revivalFailure);
      // The stimulus actually fired - without this the assertions below would
      // also pass on a registry that never called `onRevived` at all.
      expect(policy.onRevivedSpy).toHaveBeenCalledTimes(1);

      // THE REDDENING ASSERTION. By the time `onRevived` throws, the demand
      // transition has already happened: demand incremented, `parkedAtMs`
      // cleared, idle timer cancelled. The throw escapes `attach` with no
      // handle returned, so no caller owes a release - and the entry can
      // neither expire (no timer, not parked) nor be pruned (the warm
      // population excludes anything with demand).
      expect(registry.peek("s")).toBeNull();
      expect(policy.disposeSpy).toHaveBeenCalledWith("s");

      // ...and permanently so, which is what makes it a leak rather than a
      // delay: nothing is armed to reclaim it later.
      expect(environment.pendingTimerCount()).toBe(0);
      environment.advanceClock(100_000);
      expect(registry.peek("s")).toBeNull();
      expect(policy.disposeSpy).toHaveBeenCalledTimes(1);
    });

    it("keeps the session when the revival SUCCEEDS - the teardown is scoped to the failure", () => {
      // The control. Without it the assertions above are satisfied by a
      // registry that discards every revived session, which would be a far
      // worse bug than the one being fixed.
      const environment = createFakeEnvironment();
      const policy = createTrackedPolicy(defaultPolicyConfig());
      const registry = createSessionRegistry({ environment, policy });

      const created = registry.acquire("s", "scope", () => makeSession("s"));
      registry.release("s", "warm");
      const revived = registry.acquire("s", "scope", () => makeSession("s"));

      expect(revived).toBe(created);
      expect(policy.onRevivedSpy).toHaveBeenCalledTimes(1);
      expect(policy.disposeSpy).not.toHaveBeenCalled();
      expect(registry.peek("s")).toBe(created);
    });
  });

  describe("busyCountsTowardWarmCap", () => {
    it("true: a busy demand-free session is counted in overflow and can push an older idle one out, but is never itself evicted", () => {
      const environment = createFakeEnvironment();
      const config: PolicyConfig = {
        ...defaultPolicyConfig(),
        maxWarm: 1,
        warmCapScope: "demand-free",
        busyCountsTowardWarmCap: true,
      };
      const policy = createTrackedPolicy(config);
      const registry = createSessionRegistry({ environment, policy });

      const idleOld = registry.acquire("idle-old", "scope", () =>
        makeSession("idle-old"),
      );
      registry.release("idle-old", "warm");

      const busyNew = registry.acquire("busy-new", "scope", () => {
        const session = makeSession("busy-new");
        session.busy = true;
        return session;
      });
      registry.release("busy-new", "warm");

      // Positive premise: busy-new really is busy at the moment of the cap check.
      expect(policy.hasActiveWork(busyNew)).toBe(true);
      expect(registry.peek("idle-old")).toBeNull();
      expect(registry.peek("busy-new")).toBe(busyNew);
      expect(policy.disposeSpy).toHaveBeenCalledWith("idle-old");
      expect(policy.disposeSpy).not.toHaveBeenCalledWith("busy-new");
      expect(idleOld.disposed).toBe(true);
    });

    it("false: N busy demand-free sessions do not flush the idle ones — they are excluded from the cap arithmetic entirely", () => {
      const environment = createFakeEnvironment();
      const config: PolicyConfig = {
        ...defaultPolicyConfig(),
        maxWarm: 1,
        warmCapScope: "demand-free",
        busyCountsTowardWarmCap: false,
      };
      const policy = createTrackedPolicy(config);
      const registry = createSessionRegistry({ environment, policy });

      registry.acquire("idle-1", "scope", () => makeSession("idle-1"));
      registry.release("idle-1", "warm");

      const busy1 = registry.acquire("busy-1", "scope", () => {
        const session = makeSession("busy-1");
        session.busy = true;
        return session;
      });
      registry.release("busy-1", "warm");

      const busy2 = registry.acquire("busy-2", "scope", () => {
        const session = makeSession("busy-2");
        session.busy = true;
        return session;
      });
      registry.release("busy-2", "warm");

      // Positive premise: both really are busy, and there are two of them —
      // "counting them would let N running agents flush every lingering
      // shell immediately" is the bug this knob prevents.
      expect(policy.hasActiveWork(busy1)).toBe(true);
      expect(policy.hasActiveWork(busy2)).toBe(true);
      expect(registry.peek("idle-1")).not.toBeNull();
      expect(registry.peek("busy-1")).not.toBeNull();
      expect(registry.peek("busy-2")).not.toBeNull();
      expect(policy.disposeSpy).not.toHaveBeenCalled();
    });
  });

  describe("idleTtlMs: null", () => {
    it("never schedules an expiry timer, however long the clock advances", () => {
      const environment = createFakeEnvironment();
      const scheduleSpy = vi.spyOn(environment.scheduler, "schedule");
      const config: PolicyConfig = {
        ...defaultPolicyConfig(),
        idleTtlMs: null,
      };
      const policy = createTrackedPolicy(config);
      const registry = createSessionRegistry({ environment, policy });
      const session = makeSession("s1");
      registry.acquire("s1", "scope", () => session);

      registry.release("s1", "warm");
      environment.advanceClock(1_000_000);

      // The load-bearing assertion: the scheduler was never touched, not
      // merely that the session happened to survive.
      expect(scheduleSpy).not.toHaveBeenCalled();
      expect(registry.peek("s1")).toBe(session);
    });
  });

  describe("maxActiveDeferMs", () => {
    it("null defers a busy session indefinitely — no timer armed at park time, survives arbitrary clock advancement", () => {
      const environment = createFakeEnvironment();
      const scheduleSpy = vi.spyOn(environment.scheduler, "schedule");
      const config: PolicyConfig = {
        ...defaultPolicyConfig(),
        idleTtlMs: 10_000,
        maxActiveDeferMs: null,
      };
      const policy = createTrackedPolicy(config);
      const registry = createSessionRegistry({ environment, policy });
      const session = makeSession("s1");
      session.busy = true;
      registry.acquire("s1", "scope", () => session);

      registry.release("s1", "warm");

      // Positive premise: the session really is busy going into park().
      expect(policy.hasActiveWork(session)).toBe(true);
      expect(scheduleSpy).not.toHaveBeenCalled();

      environment.advanceClock(10_000_000);
      expect(registry.peek("s1")).toBe(session);
    });

    it("a numeric value re-arms on each early check and disposes once the defer window elapses, measured from park time", () => {
      const environment = createFakeEnvironment();
      const scheduleSpy = vi.spyOn(environment.scheduler, "schedule");
      const config: PolicyConfig = {
        ...defaultPolicyConfig(),
        idleTtlMs: 1_000,
        maxActiveDeferMs: 5_000,
      };
      const policy = createTrackedPolicy(config);
      const registry = createSessionRegistry({ environment, policy });
      const session = makeSession("s1");
      session.busy = true;
      registry.acquire("s1", "scope", () => session);

      registry.release("s1", "warm");
      expect(scheduleSpy).toHaveBeenCalledTimes(1);

      // Each 1000ms tick re-arms because the busy session has not yet been
      // parked for the full 5000ms defer window.
      environment.advanceClock(1000); // 1000ms since park
      expect(session.disposed).toBe(false);
      environment.advanceClock(1000); // 2000ms since park
      expect(session.disposed).toBe(false);
      environment.advanceClock(1000); // 3000ms since park
      expect(session.disposed).toBe(false);
      environment.advanceClock(1000); // 4000ms since park
      expect(registry.peek("s1")).toBe(session);

      // The 5th tick crosses the 5000ms defer window measured from park —
      // not from the previous check — and the session is finally disposed.
      environment.advanceClock(1000); // 5000ms since park
      expect(session.disposed).toBe(true);
      expect(registry.peek("s1")).toBeNull();
    });
  });

  describe("refreshOrderOnRelease", () => {
    interface ReleaseOrderScenario {
      readonly sessionA: RegSession;
      readonly sessionB: RegSession;
    }

    function runReleaseOrderScenario(
      refreshOrderOnRelease: boolean,
    ): ReleaseOrderScenario {
      const environment = createFakeEnvironment();
      const config: PolicyConfig = {
        ...defaultPolicyConfig(),
        maxWarm: 1,
        warmCapScope: "demand-free",
        idleTtlMs: null,
        refreshOrderOnRelease,
      };
      const policy = createTrackedPolicy(config);
      const registry = createSessionRegistry({ environment, policy });
      const sessionA = makeSession("A");
      const sessionB = makeSession("B");
      // A acquired first, held longest; B acquired second, released first.
      registry.acquire("A", "scope", () => sessionA);
      registry.acquire("B", "scope", () => sessionB);
      registry.release("B", "warm"); // released first
      registry.release("A", "warm"); // released last — triggers the cap check
      return { sessionA, sessionB };
    }

    it("picks the earlier-RELEASED session when true, and the earlier-ACQUIRED session when false — for the identical release sequence", () => {
      const refreshed = runReleaseOrderScenario(true);
      // B released before A: refreshing on release means B is older in the
      // eviction queue despite A being acquired first.
      expect(refreshed.sessionB.disposed).toBe(true);
      expect(refreshed.sessionA.disposed).toBe(false);

      const notRefreshed = runReleaseOrderScenario(false);
      // Order never moves on release: A, acquired first, stays oldest and is
      // evicted regardless of which one released last.
      expect(notRefreshed.sessionA.disposed).toBe(true);
      expect(notRefreshed.sessionB.disposed).toBe(false);
    });
  });

  describe("retainWhenIdle", () => {
    it("returning false disposes the session at demand zero instead of parking it — no timer, gone immediately", () => {
      const environment = createFakeEnvironment();
      const scheduleSpy = vi.spyOn(environment.scheduler, "schedule");
      const config: PolicyConfig = {
        ...defaultPolicyConfig(),
        retainWhenIdle: () => false,
      };
      const policy = createTrackedPolicy(config);
      const registry = createSessionRegistry({ environment, policy });
      const session = makeSession("s1");
      registry.acquire("s1", "scope", () => session);

      registry.release("s1", "warm");

      expect(session.disposed).toBe(true);
      expect(registry.peek("s1")).toBeNull();
      expect(scheduleSpy).not.toHaveBeenCalled();
      expect(policy.onParkedSpy).not.toHaveBeenCalled();
    });
  });

  describe("ReleaseDisposition", () => {
    it('"dispose" tears the session down at demand zero even when retainWhenIdle would keep it warm', () => {
      const environment = createFakeEnvironment();
      const config: PolicyConfig = {
        ...defaultPolicyConfig(),
        retainWhenIdle: () => true,
      };
      const policy = createTrackedPolicy(config);
      const registry = createSessionRegistry({ environment, policy });
      const session = makeSession("s1");
      registry.acquire("s1", "scope", () => session);

      registry.release("s1", "dispose");

      expect(session.disposed).toBe(true);
      expect(policy.onParkedSpy).not.toHaveBeenCalled();
    });

    it("does not dispose while a unit of demand remains — a second holder keeps the session alive", () => {
      const environment = createFakeEnvironment();
      const policy = createTrackedPolicy(defaultPolicyConfig());
      const registry = createSessionRegistry({ environment, policy });
      const session = makeSession("s1");
      registry.acquire("s1", "scope", () => session); // first unit of demand
      registry.acquire("s1", "scope", () => session); // second unit of demand

      registry.release("s1", "dispose"); // drops only one unit

      // Positive premise: one unit of demand is still held.
      expect(registry.peekEntry("s1")?.demand).toBe(1);
      expect(session.disposed).toBe(false);

      registry.release("s1", "warm"); // last unit — retainWhenIdle defaults true
      expect(session.disposed).toBe(false);
      expect(registry.peek("s1")).toBe(session);
    });
  });

  describe("onParked / onRevived", () => {
    it("fires onParked exactly when a session goes warm, and onRevived only when a warm session is re-acquired", () => {
      const environment = createFakeEnvironment();
      const policy = createTrackedPolicy(defaultPolicyConfig());
      const registry = createSessionRegistry({ environment, policy });
      const session = makeSession("s1");

      registry.acquire("s1", "scope", () => session); // fresh acquire
      expect(policy.onParkedSpy).not.toHaveBeenCalled();
      expect(policy.onRevivedSpy).not.toHaveBeenCalled();

      registry.acquire("s1", "scope", () => session); // second unit of demand — never was warm
      expect(policy.onRevivedSpy).not.toHaveBeenCalled();

      registry.release("s1", "warm"); // demand 2 -> 1, still held
      expect(policy.onParkedSpy).not.toHaveBeenCalled();

      registry.release("s1", "warm"); // demand 1 -> 0, now warm
      expect(policy.onParkedSpy).toHaveBeenCalledTimes(1);
      expect(policy.onParkedSpy).toHaveBeenCalledWith("s1");
      expect(policy.onRevivedSpy).not.toHaveBeenCalled();

      registry.acquire("s1", "scope", () => session); // re-acquiring the WARM session — a revival
      expect(policy.onRevivedSpy).toHaveBeenCalledTimes(1);
      expect(policy.onRevivedSpy).toHaveBeenCalledWith("s1");
    });

    it("fails toward disposal when onParked throws — the session is disposed, not left warm", () => {
      const environment = createFakeEnvironment();
      const config = defaultPolicyConfig();
      const policy = createTrackedPolicy(config);
      policy.onParked = (): void => {
        throw new Error("boom");
      };
      const registry = createSessionRegistry({ environment, policy });
      const session = makeSession("s1");
      registry.acquire("s1", "scope", () => session);

      registry.release("s1", "warm");

      expect(session.disposed).toBe(true);
      expect(registry.peek("s1")).toBeNull();
      expect(environment.logger.error).toHaveBeenCalled();
    });
  });

  describe("transact coalescing", () => {
    it("notifies subscribers exactly once for a transact that changes membership several times, folding an inner notify() into it", () => {
      const environment = createFakeEnvironment();
      const policy = createTrackedPolicy(defaultPolicyConfig());
      const registry = createSessionRegistry({ environment, policy });
      const listener = vi.fn();
      registry.subscribe(listener);

      registry.transact(() => {
        registry.acquire("s1", "scope", () => makeSession("s1"));
        registry.acquire("s2", "scope", () => makeSession("s2"));
        registry.release("s1", "dispose");
        registry.notify(); // an explicit notify folded into the same transaction
      });

      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("returns what its operation returned, so a plane method can batch AND answer in one call", () => {
      // Every plane that batches also answers - `acquireMounted` hands back the
      // handle it attached, `replaceMounted` whether it won the race - so the
      // value has to flow out through the transaction rather than be swallowed
      // at the boundary.
      //
      // Pinned at RUNTIME deliberately, because the way this broke was
      // type-only: the interface declared `transact(op: () => void): void` over
      // a generic implementation, a `() => T` is assignable to a `() => void`,
      // and every caller's own `return` silently became `void`. A transpiling
      // test runner sees none of that, so 1,266 green tests said nothing about
      // it. This assertion is what a runner CAN see.
      const environment = createFakeEnvironment();
      const policy = createTrackedPolicy(defaultPolicyConfig());
      const registry = createSessionRegistry({ environment, policy });
      const session = makeSession("s1");

      const attached = registry.transact(() =>
        registry.acquire("s1", "scope", () => session),
      );
      expect(attached).toBe(session);

      // Nested, since the inner transaction is the one that must not eat it.
      const nested = registry.transact(() =>
        registry.transact(() => registry.peek("s1")),
      );
      expect(nested).toBe(session);
    });
  });

  describe("materialize vs acquire", () => {
    it("materialize takes no demand and is immediately cap-eligible; acquire takes one unit", () => {
      const environment = createFakeEnvironment();
      const config: PolicyConfig = {
        ...defaultPolicyConfig(),
        maxWarm: 1,
        warmCapScope: "demand-free",
        idleTtlMs: null,
      };
      const policy = createTrackedPolicy(config);
      const registry = createSessionRegistry({ environment, policy });

      registry.materialize("mat-1", "scope", () => makeSession("mat-1"));
      // Zero demand from the start — no acquire ever happened for it.
      expect(registry.peekEntry("mat-1")?.demand).toBe(0);

      registry.acquire("acq-1", "scope", () => makeSession("acq-1"));
      registry.release("acq-1", "warm");

      // The cap check on acq-1's release finds two demand-free entries under
      // maxWarm 1 — mat-1 was cap-eligible from the moment it was
      // materialized, so it is the one that gets evicted.
      expect(registry.peek("mat-1")).toBeNull();
      expect(registry.peek("acq-1")).not.toBeNull();
    });

    it("acquire takes one unit of demand", () => {
      const environment = createFakeEnvironment();
      const policy = createTrackedPolicy(defaultPolicyConfig());
      const registry = createSessionRegistry({ environment, policy });

      registry.acquire("s1", "scope", () => makeSession("s1"));

      expect(registry.peekEntry("s1")?.demand).toBe(1);
    });
  });

  describe("rekey", () => {
    it("moves a demand-free entry to a new key and re-parks it with a fresh window", () => {
      const environment = createFakeEnvironment();
      const scheduleSpy = vi.spyOn(environment.scheduler, "schedule");
      const config: PolicyConfig = {
        ...defaultPolicyConfig(),
        idleTtlMs: 1000,
      };
      const policy = createTrackedPolicy(config);
      const registry = createSessionRegistry({ environment, policy });
      const session = makeSession("s1");
      registry.acquire("old-key", "scope", () => session);
      registry.release("old-key", "warm"); // parks, arms one timer

      expect(scheduleSpy).toHaveBeenCalledTimes(1);

      const moved = registry.rekey("old-key", "new-key");

      expect(moved).toBe(true);
      expect(registry.peek("old-key")).toBeNull();
      expect(registry.peek("new-key")).toBe(session);
      // Re-parked: the old timer was cancelled and a fresh one armed.
      expect(scheduleSpy).toHaveBeenCalledTimes(2);

      // The window is fresh from the rekey, not inherited from the original
      // park — 900ms is short of the 1000ms TTL measured from either point,
      // but this proves the new timer (not a stale leftover) is what governs.
      environment.advanceClock(900);
      expect(registry.peek("new-key")).toBe(session);
    });

    it("refuses when the entry is held", () => {
      const environment = createFakeEnvironment();
      const policy = createTrackedPolicy(defaultPolicyConfig());
      const registry = createSessionRegistry({ environment, policy });
      registry.acquire("held-key", "scope", () => makeSession("held-key"));

      expect(registry.rekey("held-key", "new-key")).toBe(false);
      expect(registry.peek("held-key")).not.toBeNull();
      expect(registry.peek("new-key")).toBeNull();
    });

    it("refuses when the source entry is absent", () => {
      const environment = createFakeEnvironment();
      const policy = createTrackedPolicy(defaultPolicyConfig());
      const registry = createSessionRegistry({ environment, policy });

      expect(registry.rekey("missing", "new-key")).toBe(false);
    });

    it("refuses when the target key is already taken", () => {
      const environment = createFakeEnvironment();
      const policy = createTrackedPolicy(defaultPolicyConfig());
      const registry = createSessionRegistry({ environment, policy });
      const source = makeSession("source");
      const target = makeSession("target");
      registry.acquire("source-key", "scope", () => source);
      registry.release("source-key", "warm");
      registry.acquire("target-key", "scope", () => target);

      expect(registry.rekey("source-key", "target-key")).toBe(false);
      expect(registry.peek("source-key")).toBe(source);
      expect(registry.peek("target-key")).toBe(target);
    });
  });

  describe("replace", () => {
    it('inherits the demand count and routes the outgoing session through onBeforeDispose with cause "replaced"', () => {
      const environment = createFakeEnvironment();
      const disposeCauses: SessionDisposeCause[] = [];
      const config: PolicyConfig = {
        ...defaultPolicyConfig(),
        onBeforeDisposeVerdict: (
          _session: RegSession,
          cause: SessionDisposeCause,
        ): SessionDisposeVerdict => {
          disposeCauses.push(cause);
          return "dispose";
        },
      };
      const policy = createTrackedPolicy(config);
      const registry = createSessionRegistry({ environment, policy });
      const previous = makeSession("prev");
      const next = makeSession("next");
      registry.acquire("k1", "scope", () => previous);
      registry.acquire("k1", "scope", () => previous); // second unit of demand

      const replaced = registry.replace("k1", previous, next);

      expect(replaced).toBe(true);
      expect(disposeCauses).toEqual(["replaced"]);
      expect(previous.disposed).toBe(true);
      expect(registry.peekEntry("k1")?.session).toBe(next);
      // The replacement inherits the outgoing entry's demand count.
      expect(registry.peekEntry("k1")?.demand).toBe(2);
    });

    it("returns false when previous is no longer the session at that key", () => {
      const environment = createFakeEnvironment();
      const policy = createTrackedPolicy(defaultPolicyConfig());
      const registry = createSessionRegistry({ environment, policy });
      const actual = makeSession("actual");
      const stale = makeSession("stale");
      const next = makeSession("next");
      registry.acquire("k1", "scope", () => actual);

      const replaced = registry.replace("k1", stale, next);

      expect(replaced).toBe(false);
      expect(registry.peek("k1")).toBe(actual);
      expect(next.disposed).toBe(false);
    });
  });

  describe('onBeforeDispose returning "retain"', () => {
    it("removes the entry from the registry without calling dispose", () => {
      const environment = createFakeEnvironment();
      const config: PolicyConfig = {
        ...defaultPolicyConfig(),
        onBeforeDisposeVerdict: () => "retain",
      };
      const policy = createTrackedPolicy(config);
      const registry = createSessionRegistry({ environment, policy });
      const session = makeSession("s1");
      registry.acquire("s1", "scope", () => session);

      registry.forceRelease("s1");

      expect(registry.peek("s1")).toBeNull();
      expect(policy.disposeSpy).not.toHaveBeenCalled();
      expect(session.disposed).toBe(false);
    });
  });

  describe("the timer-fired-early re-check", () => {
    it("re-arms instead of evicting when the scheduled callback fires before the TTL has actually elapsed on the clock", () => {
      const environment = createFakeEnvironment();
      const scheduleSpy = vi.spyOn(environment.scheduler, "schedule");
      const config: PolicyConfig = {
        ...defaultPolicyConfig(),
        idleTtlMs: 1000,
      };
      const policy = createTrackedPolicy(config);
      const registry = createSessionRegistry({ environment, policy });
      const session = makeSession("s1");
      registry.acquire("s1", "scope", () => session);
      registry.release("s1", "warm");

      // Parked at t=0 for 1000ms.
      expect(scheduleSpy).toHaveBeenCalledTimes(1);
      expect(environment.nextTimerFireAt()).toBe(1000);

      // 400ms of the window really has elapsed, and then the timer fires
      // early — the throttled-background-tab scenario the re-check exists to
      // guard against. A suite that only ever advances clock and timers
      // together never exercises this branch.
      environment.advanceClock(400);
      expect(environment.fireDueTimerEarly()).toBe(true);

      // Not evicted: re-checking against the clock finds only 400ms elapsed.
      expect(registry.peek("s1")).toBe(session);
      expect(session.disposed).toBe(false);
      expect(scheduleSpy).toHaveBeenCalledTimes(2);

      // THE assertion. The re-armed timer must carry what is LEFT of the
      // window — 600ms from t=400, i.e. the original t=1000 deadline — not a
      // fresh full TTL, which would push eviction out to t=1400 and turn every
      // early fire into an almost-doubled warm window. Asserting the DEADLINE
      // rather than "something was scheduled" is what makes this test able to
      // fail: a full re-arm schedules a timer too, and every other assertion
      // here passes under it.
      expect(scheduleSpy.mock.calls[1][0]).toBe(600);
      expect(environment.nextTimerFireAt()).toBe(1000);
      expect(environment.pendingTimerCount()).toBe(1);

      // 599ms more: the original deadline has NOT arrived, so nothing fires
      // and the session is still warm.
      environment.advanceClock(599);
      expect(session.disposed).toBe(false);

      // The 1000ms mark, on the nose. The re-armed timer — the only one left —
      // fires, the re-check finds the window genuinely elapsed, and the
      // session goes.
      environment.advanceClock(1);
      expect(session.disposed).toBe(true);
      expect(registry.peek("s1")).toBeNull();
      expect(environment.pendingTimerCount()).toBe(0);
    });

    it("never lengthens the window past one full TTL when the clock steps BACKWARD", () => {
      // The case the `Math.max(0, elapsed)` clamp exists for. A backward clock
      // adjustment makes the elapsed term negative, and an unclamped
      // `ttl - elapsed` would schedule LONGER than the window the session was
      // ever promised — repeatedly, since each early fire re-reads the clock.
      const environment = createFakeEnvironment();
      const scheduleSpy = vi.spyOn(environment.scheduler, "schedule");
      const policy = createTrackedPolicy({
        ...defaultPolicyConfig(),
        idleTtlMs: 1000,
      });
      const registry = createSessionRegistry({ environment, policy });
      const session = makeSession("s1");
      registry.acquire("s1", "scope", () => session);

      environment.advanceClock(5000);
      registry.release("s1", "warm");
      // Parked at t=5000, due at t=6000.
      expect(environment.nextTimerFireAt()).toBe(6000);

      // The clock jumps back behind the park time.
      environment.advanceClock(-3000);
      expect(environment.fireDueTimerEarly()).toBe(true);

      expect(session.disposed).toBe(false);
      // 1000, not 4000: capped at one full window rather than
      // `ttl - (2000 - 5000)`.
      expect(scheduleSpy.mock.calls[1][0]).toBe(1000);
    });
  });
});

// ─── LeaseMaterializer conformance ──────────────────────────────────────────

function createFakeLeaseMaterializer(): LeaseMaterializer<{ bytes: number }> & {
  readonly demoted: string[];
} {
  const seeded = new Map<string, number>([["doc-1", 128]]);
  const demoted: string[] = [];
  return {
    demoted,
    async materialize(resourceId: string) {
      const bytes = seeded.get(resourceId);
      return bytes === undefined ? null : { bytes };
    },
    demote(resourceId: string): void {
      demoted.push(resourceId);
    },
  };
}

describe("LeaseMaterializer conformance", () => {
  it("resolves an unseeded resource id to null, not an empty resource", async () => {
    const materializer = createFakeLeaseMaterializer();
    await expect(materializer.materialize("doc-unseeded")).resolves.toBeNull();
  });

  it("materialises a seeded resource and demotes it deterministically", async () => {
    const materializer = createFakeLeaseMaterializer();
    const resource = await materializer.materialize("doc-1");
    expect(resource).toEqual({ bytes: 128 });
    materializer.demote("doc-1", resource!);
    expect(materializer.demoted).toEqual(["doc-1"]);
  });
});

// ─── Doc-class Replica conformance ──────────────────────────────────────────
//
// The four rules `DocSnapshotEvent`/`DocUpdateEvent`/`DocCoverageAckEvent`/
// `DocUnavailableEvent` exist to protect. Content is modelled as a set of
// opaque string tokens rather than real CRDT bytes — the point here is the
// replica's DECISION per event kind, not Yjs merge semantics, which this seam
// deliberately keeps out of the runtime's own dependency surface.

type DocProjection = readonly string[];

function tokensOf(update: Uint8Array): readonly string[] {
  return new TextDecoder()
    .decode(update)
    .split(",")
    .filter((token) => token.length > 0);
}

function updateOf(...tokens: readonly string[]): Uint8Array {
  return new TextEncoder().encode(tokens.join(","));
}

/**
 * A minimal in-memory `Replica<DocReplicaEvent, DocProjection>`.
 *
 * `markLocalDivergence` is test-only scaffolding standing in for the local
 * unsynced-edit tracking a real doc replica would own — the point under test
 * is which event retires it, not how it is set.
 */
function createFakeDocReplica(planeId: string): Replica<
  DocReplicaEvent,
  DocProjection
> & {
  markLocalDivergence(): void;
  isLocallyDivergent(): boolean;
} {
  let heldGuid: string | null = null;
  let tokens = new Set<string>();
  let divergent = false;
  let disposed = false;
  const sink = createTransactionalProjectionSink<DocProjection>([], () => {});

  return {
    planeId,
    dataClass: "doc",
    markLocalDivergence(): void {
      divergent = true;
    },
    isLocallyDivergent(): boolean {
      return divergent;
    },
    apply(event: DocReplicaEvent): ReplicaApplyOutcome {
      if (disposed) return { kind: "ignored", reason: "disposed" };
      switch (event.kind) {
        case "doc-snapshot": {
          heldGuid = event.docGuid;
          const incoming = tokensOf(event.update);
          if (event.seed === "full") {
            // Self-sufficient: safe, and REQUIRED, to install wholesale.
            tokens = new Set(incoming);
          } else {
            // A delta against this replica's own offer — merging is the only
            // correct move. Installing it wholesale would silently drop
            // every token the delta legitimately omitted.
            for (const token of incoming) tokens.add(token);
          }
          return { kind: "applied", cursor: null };
        }
        case "doc-update": {
          if (event.docGuid !== heldGuid) {
            // The bytes describe a document this replica does not hold.
            // Deliberately NOT `"stale-generation"`: the frame is current,
            // the DOCUMENT was replaced underneath it.
            return { kind: "ignored", reason: "guid-mismatch" };
          }
          for (const token of tokensOf(event.update)) tokens.add(token);
          return { kind: "applied", cursor: null };
        }
        case "doc-coverage-ack": {
          // The ONLY event that retires local divergence — nothing else
          // touches it below.
          divergent = false;
          return { kind: "applied", cursor: null };
        }
        case "doc-awareness":
        case "doc-ready":
          return { kind: "applied", cursor: null };
        case "doc-unavailable": {
          if (event.code === "stale-authority-epoch") {
            // Always terminal and never an availability state: the whole
            // epic view is void, so the replica itself must be replaced.
            return {
              kind: "requires-replacement",
              reason: "authority-epoch-changed",
            };
          }
          // "artifact-not-found" and "body-unavailable" (terminal or not)
          // are availability facts about THIS body, not a replica-identity
          // change — the replica stays and just records the state.
          return { kind: "applied", cursor: null };
        }
      }
    },
    project(): void {
      sink.publish(Array.from(tokens).sort());
    },
    sink,
    watermark(): LaneCursor | null {
      return null;
    },
    freshness() {
      return unknownFreshness(planeId, "doc");
    },
    reset(): void {
      // The doc fake does not assert on reset provenance itself — the
      // records fake and the AdapterHost-wiring test below cover
      // `ReplicaResetCause`; this signature change is exercised here only to
      // prove the doc class implements the same one entry point.
      heldGuid = null;
      tokens = new Set();
      divergent = false;
      sink.publish([]);
    },
    dispose(): void {
      disposed = true;
      tokens = new Set();
    },
  };
}

describe("doc-class Replica conformance", () => {
  it("drops a doc-update whose docGuid differs from the held one, applies a matching one", () => {
    const replica = createFakeDocReplica("doc-plane-1");
    replica.apply({
      kind: "doc-snapshot",
      authorityEpoch: "e1",
      docId: "doc-1",
      docGuid: "guid-1",
      update: updateOf("a", "b"),
      hostStateVectorBase64: null,
      seed: "full",
    });

    const droppedOutcome = replica.apply({
      kind: "doc-update",
      authorityEpoch: "e1",
      docId: "doc-1",
      docGuid: "guid-WRONG",
      update: updateOf("c"),
    });
    expect(droppedOutcome).toEqual({
      kind: "ignored",
      reason: "guid-mismatch",
    });

    const appliedOutcome = replica.apply({
      kind: "doc-update",
      authorityEpoch: "e1",
      docId: "doc-1",
      docGuid: "guid-1",
      update: updateOf("c"),
    });
    expect(appliedOutcome).toEqual({ kind: "applied", cursor: null });

    replica.project();
    // "c" from the wrong-guid update never lands — only the matching one does.
    expect(replica.sink.read()).toEqual(["a", "b", "c"]);
  });

  it("merges a delta-against-offer snapshot but replaces wholesale on a full snapshot", () => {
    const replica = createFakeDocReplica("doc-plane-1");
    replica.apply({
      kind: "doc-snapshot",
      authorityEpoch: "e1",
      docId: "doc-1",
      docGuid: "guid-1",
      update: updateOf("a", "b", "c"),
      hostStateVectorBase64: null,
      seed: "full",
    });

    replica.apply({
      kind: "doc-snapshot",
      authorityEpoch: "e1",
      docId: "doc-1",
      docGuid: "guid-1",
      update: updateOf("d"),
      hostStateVectorBase64: "vector-1",
      seed: "delta-against-offer",
    });
    replica.project();
    // The delta carried only "d" — "a", "b", "c" survive because a delta
    // MERGES. Installing it wholesale (the bug this field exists to
    // prevent) would have dropped them silently.
    expect(replica.sink.read()).toEqual(["a", "b", "c", "d"]);

    replica.apply({
      kind: "doc-snapshot",
      authorityEpoch: "e1",
      docId: "doc-1",
      docGuid: "guid-1",
      update: updateOf("x", "y"),
      hostStateVectorBase64: null,
      seed: "full",
    });
    replica.project();
    // A full snapshot REPLACES — none of the prior tokens survive.
    expect(replica.sink.read()).toEqual(["x", "y"]);
  });

  it("retires local divergence only on a doc-coverage-ack, nothing else", () => {
    const replica = createFakeDocReplica("doc-plane-1");
    replica.markLocalDivergence();
    expect(replica.isLocallyDivergent()).toBe(true);

    replica.apply({
      kind: "doc-awareness",
      authorityEpoch: "e1",
      docId: "doc-1",
      frame: new Uint8Array(),
    });
    expect(replica.isLocallyDivergent()).toBe(true);

    replica.apply({
      kind: "doc-ready",
      authorityEpoch: "e1",
      docId: "doc-1",
    });
    expect(replica.isLocallyDivergent()).toBe(true);

    replica.apply({
      kind: "doc-coverage-ack",
      authorityEpoch: "e1",
      docId: "doc-1",
      docGuid: "guid-1",
      coverageStateVectorBase64: "vector-2",
    });
    expect(replica.isLocallyDivergent()).toBe(false);
  });

  it("routes stale-authority-epoch to replacement, and non-terminal body-unavailable to a plain applied state", () => {
    const replica = createFakeDocReplica("doc-plane-1");

    const staleEpochOutcome = replica.apply({
      kind: "doc-unavailable",
      authorityEpoch: "e1",
      docId: "doc-1",
      code: "stale-authority-epoch",
      terminal: true,
      reason: "epoch bumped under an open attach",
    });
    expect(staleEpochOutcome).toEqual({
      kind: "requires-replacement",
      reason: "authority-epoch-changed",
    });

    const transientUnavailableOutcome = replica.apply({
      kind: "doc-unavailable",
      authorityEpoch: "e1",
      docId: "doc-1",
      code: "body-unavailable",
      terminal: false,
      reason: "materialising",
    });
    expect(transientUnavailableOutcome).toEqual({
      kind: "applied",
      cursor: null,
    });
    expect(transientUnavailableOutcome.kind).not.toBe("requires-replacement");
  });
});

// ─── Replica.reset — one entry point, provenance in the argument ───────────

describe("Replica.reset provenance", () => {
  it("distinguishes an authority reset from a client reset after the fact, with the same empty end state", () => {
    const replica = createFakeReplica("epic-1");
    replica.apply({
      kind: "upsert",
      rowId: "row-1",
      revision: 1,
      row: { label: "x" },
    });
    replica.project();
    expect(replica.freshness().status).toBe("live");

    replica.reset({ origin: "authority", reason: "resume-too-old" });
    expect(replica.resetCauses).toEqual([
      { origin: "authority", reason: "resume-too-old" },
    ]);
    expect(replica.sink.read()).toEqual([]);
    expect(replica.watermark()).toBeNull();
    expect(replica.freshness().status).toBe("unknown");

    replica.apply({
      kind: "upsert",
      rowId: "row-2",
      revision: 1,
      row: { label: "y" },
    });
    replica.project();

    replica.reset({ origin: "client", intent: "fresh-snapshot-requested" });
    // Distinguishable after the fact — the whole point of moving provenance
    // into the argument instead of a second reset method.
    expect(replica.resetCauses).toEqual([
      { origin: "authority", reason: "resume-too-old" },
      { origin: "client", intent: "fresh-snapshot-requested" },
    ]);
    // Provenance changes what may be CLAIMED, never what HAPPENS: the client
    // reset leaves the replica in exactly the same empty state as the
    // authority reset did above.
    expect(replica.sink.read()).toEqual([]);
    expect(replica.watermark()).toBeNull();
    expect(replica.freshness().status).toBe("unknown");
  });

  it("routes an adapter-requested replacement through AdapterHost to an authority-origin reset only", () => {
    const environment = createFakeEnvironment();
    const replica = createFakeReplica("epic-2");
    const host = createFakeAdapterHost(environment, replica);
    const adapter = createFakeLaneAdapter("epic.state.subscribe@1.0");
    adapter.attach(host);

    // `AdapterHost.requestReplacement` is deliberately narrow — it accepts
    // only a `ReplicaReplacementReason` — so there is no call an adapter can
    // make here that reaches the replica as a client-origin reset.
    adapter.triggerReplacementRequest(
      "resume-too-old",
      resumeTooOldTransition("e1/0"),
    );

    expect(replica.resetCauses).toEqual([
      { origin: "authority", reason: "resume-too-old" },
    ]);
  });
});

// ─── LeaseRegistry / LeaseGrant conformance — demand vs residency ──────────
//
// The rule: a lease is a statement of DEMAND, not a handle on bytes, and
// there is exactly one demand book. `leaseCount` tracks demand;
// `materializedIds` tracks residency; the two disagree for exactly as long
// as a resource is "awaiting-seed".

function createSeedableLeaseMaterializer<
  TResource,
>(): LeaseMaterializer<TResource> & {
  seed(resourceId: string, resource: TResource): void;
  // `Mock`, not `ReturnType<typeof vi.fn>` — the repo's type-safety lint bans
  // `ReturnType<...>` in every `.ts` file, and this package grants no test
  // exemption.
  readonly demote: Mock;
} {
  const seeded = new Map<string, TResource>();
  return {
    demote: vi.fn(),
    seed(resourceId: string, resource: TResource): void {
      seeded.set(resourceId, resource);
    },
    async materialize(resourceId: string): Promise<TResource | null> {
      return seeded.get(resourceId) ?? null;
    },
  };
}

/** A minimal in-memory `LeaseRegistry<TResource>` driving a `LeaseMaterializer`. */
function createFakeLeaseRegistry<TResource>(
  materializer: LeaseMaterializer<TResource>,
): LeaseRegistry<TResource> {
  const leaseCounts = new Map<string, number>();
  const materialized = new Map<string, TResource>();
  let disposed = false;

  function currentCount(resourceId: string): number {
    return leaseCounts.get(resourceId) ?? 0;
  }

  function makeLease(resourceId: string): LeaseHandle {
    let released = false;
    return {
      resourceId,
      release(): void {
        if (released) return;
        released = true;
        const next = currentCount(resourceId) - 1;
        if (next <= 0) leaseCounts.delete(resourceId);
        else leaseCounts.set(resourceId, next);
      },
      isReleased(): boolean {
        return released;
      },
    };
  }

  return {
    async acquire(resourceId: string): Promise<LeaseGrant<TResource>> {
      if (disposed) {
        // The only arm with no lease: no demand was registered.
        return { kind: "unavailable", reason: "disposed" };
      }
      // Demand is counted BEFORE materialisation completes, and stays
      // counted whether or not anything comes back below.
      leaseCounts.set(resourceId, currentCount(resourceId) + 1);
      const lease = makeLease(resourceId);
      const resource = await materializer.materialize(resourceId);
      if (resource === null) {
        return { kind: "awaiting-seed", lease };
      }
      materialized.set(resourceId, resource);
      return { kind: "granted", lease, resource };
    },
    peek(resourceId: string): TResource | null {
      return materialized.get(resourceId) ?? null;
    },
    leaseCount(resourceId: string): number {
      return currentCount(resourceId);
    },
    materializedIds(): readonly string[] {
      return Array.from(materialized.keys());
    },
    demoteIdle(): void {
      for (const [resourceId, resource] of materialized) {
        if (currentCount(resourceId) === 0) {
          materializer.demote(resourceId, resource);
          materialized.delete(resourceId);
        }
      }
    },
    dispose(): void {
      disposed = true;
      for (const [resourceId, resource] of materialized) {
        materializer.demote(resourceId, resource);
      }
      materialized.clear();
      leaseCounts.clear();
    },
  };
}

describe("LeaseRegistry / LeaseGrant conformance", () => {
  it("registers demand even when nothing is materialisable yet, and releases it like a granted lease", async () => {
    const materializer = createSeedableLeaseMaterializer<{ bytes: number }>();
    const registry = createFakeLeaseRegistry(materializer);

    const grant = await registry.acquire("doc-cold");
    expect(grant.kind).toBe("awaiting-seed");
    if (grant.kind !== "awaiting-seed")
      throw new Error("expected awaiting-seed");

    // Demand is on the books even though nothing materialised.
    expect(registry.leaseCount("doc-cold")).toBe(1);
    // Demand and residency are different questions: absent from the
    // materialised set while awaiting seed.
    expect(registry.materializedIds()).not.toContain("doc-cold");

    grant.lease.release();
    expect(registry.leaseCount("doc-cold")).toBe(0);
  });

  it("materialises under a still-held lease without cooling the resource — the stranded-editor bug", async () => {
    const materializer = createSeedableLeaseMaterializer<{ bytes: number }>();
    const registry = createFakeLeaseRegistry(materializer);

    const firstGrant = await registry.acquire("doc-cold");
    if (firstGrant.kind !== "awaiting-seed") {
      throw new Error("expected awaiting-seed");
    }

    // The seed arrives while the first lease is still held.
    materializer.seed("doc-cold", { bytes: 64 });
    const secondGrant = await registry.acquire("doc-cold");
    expect(secondGrant.kind).toBe("granted");
    expect(registry.materializedIds()).toContain("doc-cold");
    expect(registry.leaseCount("doc-cold")).toBe(2);

    // The bug this seam exists to prevent: a resource that has just
    // materialised under demand that was already counted must not be
    // treated as idle and cooled. Assert with a spy, not merely that a
    // value came back.
    expect(materializer.demote).not.toHaveBeenCalled();

    firstGrant.lease.release();
    if (secondGrant.kind === "granted") secondGrant.lease.release();
  });

  it("carries no lease on the unavailable arm — the only arm with no demand registered", async () => {
    const materializer = createSeedableLeaseMaterializer<{ bytes: number }>();
    const registry = createFakeLeaseRegistry(materializer);
    registry.dispose();

    const grant = await registry.acquire("doc-cold");
    expect(grant.kind).toBe("unavailable");
    expect(registry.leaseCount("doc-cold")).toBe(0);
    // Runtime shape, not just the discriminant: no `lease` property at all.
    expect("lease" in grant).toBe(false);
  });
});
