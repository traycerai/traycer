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
import { describe, it, expect, vi } from "vitest";

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
import { sessionKeyOf, type SessionRegistryPolicy } from "../session-registry";
import type { Replica, ReplicaApplyOutcome } from "../replica";
import type { AdapterHost, LaneAdapter } from "../adapter";
import type { LeaseMaterializer } from "../lease";

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
    expect(compareLaneCursors(cursor("e1", "a", 5), cursor("e1", "a", 10))).toBe(
      "before",
    );
    expect(compareLaneCursors(cursor("e1", "a", 10), cursor("e1", "a", 5))).toBe(
      "after",
    );
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
    expect(compareLaneCursors(cursor("e2", "a", 5), cursor("e10", "a", 100))).toBe(
      "incomparable",
    );
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
    const sink = createTransactionalProjectionSink(0, deliver);

    sink.publish(1);

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith(1, 1);
    expect(sink.revision()).toBe(1);
    expect(sink.read()).toBe(1);
  });

  it("delivers once with the last value for three publishes in one transaction", () => {
    const deliver = vi.fn();
    const sink = createTransactionalProjectionSink(0, deliver);

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
    const sink = createTransactionalProjectionSink(0, deliver);

    sink.transact(() => {
      // no publish
    });

    expect(deliver).not.toHaveBeenCalled();
    expect(sink.revision()).toBe(0);
  });

  it("delivers only on the outermost exit of nested transactions", () => {
    const deliver = vi.fn();
    const sink = createTransactionalProjectionSink(0, deliver);

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
    const sink = createTransactionalProjectionSink(0, deliver);

    sink.transact(() => {
      sink.publish(42);
      expect(sink.read()).toBe(42);
    });
  });

  it("delivers what was published and rethrows when body() throws", () => {
    const deliver = vi.fn();
    const sink = createTransactionalProjectionSink(0, deliver);

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
    // The reason for the NUL separator: a `:`-joined key would fold these
    // two distinct tuples onto the same string ("a:b:c").
    const left = sessionKeyOf(["a:b", "c"]);
    const right = sessionKeyOf(["a", "b:c"]);
    expect(left).not.toBe(right);
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
  | { readonly kind: "upsert"; readonly rowId: string; readonly revision: number; readonly row: FakeRow }
  | { readonly kind: "remove"; readonly rowId: string; readonly revision: number };

type FakeProjection = readonly { readonly rowId: string; readonly row: FakeRow }[];

/** A controllable clock/scheduler with no real timers and no DOM. */
function createFakeEnvironment(): RuntimeEnvironment & {
  advanceClock(ms: number): void;
  drainMicrotasks(): void;
} {
  let nowMs = 0;
  const pendingTimers: { fireAt: number; callback: () => void; cancelled: boolean }[] = [];
  const pendingMicrotasks: (() => void)[] = [];

  return {
    clock: {
      now(): number {
        return nowMs;
      },
    },
    scheduler: {
      schedule(delayMs, callback) {
        const entry = { fireAt: nowMs + delayMs, callback, cancelled: false };
        pendingTimers.push(entry);
        return {
          cancel(): void {
            entry.cancelled = true;
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
      for (const entry of pendingTimers) {
        if (!entry.cancelled && entry.fireAt <= nowMs) {
          entry.cancelled = true; // fire once
          entry.callback();
        }
      }
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
function createFakeReplica(planeId: string): Replica<FakeEvent, FakeProjection> {
  const rows = new Map<string, { revision: number; row: FakeRow }>();
  let disposed = false;
  let currentWatermark: LaneCursor | null = null;
  const sink = createTransactionalProjectionSink<FakeProjection>([], () => {
    // Reference sink; the smoke test reads through `replica.sink.read()`.
  });

  return {
    planeId,
    dataClass: "records",
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
      return unknownFreshness(planeId, "records");
    },
    reset(): void {
      rows.clear();
      currentWatermark = null;
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
  replica: Replica<FakeEvent, FakeProjection>,
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
    requestReplacement(): void {
      // Smoke test does not exercise replacement.
    },
  };
}

/** A minimal in-memory `LaneAdapter<FakeEvent>` with a test-only frame pump. */
function createFakeLaneAdapter(laneId: string): LaneAdapter<FakeEvent> & {
  pushFrame(events: readonly FakeEvent[]): void;
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
      return null;
    },
    detach(reason): void {
      detachReasons.push(reason);
      host = null;
    },
    pushFrame(events: readonly FakeEvent[]): void {
      if (host === null) throw new Error("adapter not attached");
      for (const event of events) host.emit(event);
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
    expect(replica.apply({ kind: "upsert", rowId: "row-2", revision: 1, row: { label: "x" } })).toEqual(
      { kind: "ignored", reason: "disposed" },
    );
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
    maxActiveDeferMs: 30_000,
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
  };
}

describe("SessionRegistryPolicy conformance", () => {
  it("is implementable and drives dispose/retain from plane-supplied predicates", () => {
    const policy = createFakeSessionPolicy();

    const dirtySession: FakeSession = { busy: false, clean: false, disposed: false };
    expect(policy.hasActiveWork(dirtySession)).toBe(false);
    expect(policy.isEvictable(dirtySession)).toBe(false);
    expect(policy.onBeforeDispose(dirtySession, "idle-expired")).toBe("retain");

    const cleanSession: FakeSession = { busy: false, clean: true, disposed: false };
    expect(policy.onBeforeDispose(cleanSession, "idle-expired")).toBe("dispose");
    policy.dispose(cleanSession);
    expect(cleanSession.disposed).toBe(true);
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
