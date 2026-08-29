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
import { sessionKeyOf, type SessionRegistryPolicy } from "../session-registry";
import type {
  Replica,
  ReplicaApplyOutcome,
  ReplicaReplacementReason,
  ReplicaResetCause,
} from "../replica";
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
function createFakeEnvironment(): RuntimeEnvironment & {
  advanceClock(ms: number): void;
  drainMicrotasks(): void;
} {
  let nowMs = 0;
  const pendingTimers: {
    fireAt: number;
    callback: () => void;
    cancelled: boolean;
  }[] = [];
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
function createFakeReplica(
  planeId: string,
): Replica<FakeEvent, FakeProjection> & {
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
  triggerReplacementRequest(reason: ReplicaReplacementReason): void;
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
    triggerReplacementRequest(reason: ReplicaReplacementReason): void {
      if (host === null) throw new Error("adapter not attached");
      // `AdapterHost.requestReplacement` is the only path an adapter has to
      // this — its signature accepts a `ReplicaReplacementReason`, never a
      // `ReplicaResetCause`, so a client-origin cause cannot even be
      // constructed at this call site.
      host.requestReplacement(reason);
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
    adapter.triggerReplacementRequest("resume-too-old");

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
