/**
 * The merge window, which is the only moment the runtime token earns its keep.
 *
 * Two runtimes for the same `(hostId, epicId)` are alive at once whenever a
 * session is replaced: the old handle is not disposed until the new one has
 * taken over (owed #1/#2). Every holder id and the book key itself are
 * composed from `hostId + epicId + runtimeToken`, so the token is the ONLY
 * thing distinguishing their books.
 *
 * This is what the 4e ruling nearly broke. "The worker mints its own token"
 * gives each thread an independent sequence, both mint `"1"`, both books
 * register under an identical `bookKey`, the second `attach` overwrites the
 * first, and then the OLD runtime's teardown deregisters the NEW runtime's
 * books — a live session silently unaccounted for the rest of its life.
 *
 * The pin is deliberately behavioural rather than an assertion about token
 * strings: it asserts that A's teardown leaves B's books attached, which is
 * the property, not the mechanism.
 */
import { describe, expect, it } from "vitest";
import type { RuntimeEnvironment } from "@traycer-clients/shared/replica-runtime";
import { ensureProcessMemoryRuntime } from "@/stores/replica-memory/process-memory-accountant";
import { HOT_DOCS_SOFT_LIMIT_BYTES } from "@/stores/replica-memory/budget-limits";
import { createProcessBackedAccountingPort } from "../process-backed-accounting-port";
import type { EpicRuntimeAccountingSource } from "../epic-runtime-accounting-port";

function environmentStub(): RuntimeEnvironment {
  return {
    clock: { now: () => 0 },
    scheduler: {
      schedule() {
        return { cancel(): void {} };
      },
      scheduleMicrotask(): void {},
    },
    logger: { debug: () => {}, warn: () => {}, error: () => {} },
  };
}

function sourceWithRooms(
  roomIds: readonly string[],
): EpicRuntimeAccountingSource {
  return {
    materializedRoomIds: () => roomIds,
    demoteColdestUnpinned: () => ({
      reclaimedBytes: 0,
      deferredBytes: 0,
      protectedBytesByKind: [],
    }),
    measureRootBytes: () => 0,
    projectionCounts: () => ({
      artifacts: 0,
      chats: 0,
      tuiAgents: 0,
      deletedArtifacts: 0,
      roleClaims: 0,
      treeNodes: 0,
    }),
  };
}

describe("two ports for the same (hostId, epicId)", () => {
  it("keep separate books, so the outgoing runtime's teardown does not deregister the incoming one", () => {
    const environment = environmentStub();
    // Counted as a DELTA against whatever else this process has attached: the
    // accountant is a module-scoped singleton by design, so an absolute
    // expectation here would depend on suite order.
    const memory = ensureProcessMemoryRuntime(environment);
    const baseline = memory.hotDocs.docsResident();

    const outgoing = createProcessBackedAccountingPort({
      hostId: "host-1",
      epicId: "epic-1",
      environment,
    });
    const incoming = createProcessBackedAccountingPort({
      hostId: "host-1",
      epicId: "epic-1",
      environment,
    });

    outgoing.registerBooks(sourceWithRooms(["room-a"]));
    incoming.registerBooks(sourceWithRooms(["room-b", "room-c"]));
    expect(memory.hotDocs.docsResident()).toBe(baseline + 3);

    // The merge window closing: the OLD handle disposes after the new one is
    // already serving.
    outgoing.unregisterBooks();

    // Two, not zero. Zero is what a shared token produces, and it is invisible
    // to every behavioural test in the suite because the session keeps working
    // perfectly - it is simply no longer accounted for.
    expect(memory.hotDocs.docsResident()).toBe(baseline + 2);

    incoming.unregisterBooks();
    expect(memory.hotDocs.docsResident()).toBe(baseline);
  });
});

/**
 * A tier that RECORDS what it was asked to free, standing in for the worker
 * proxy. `demoteColdestUnpinned` answering zero is the proxy's honest answer -
 * the freeing happens in the worker after the call returns - and it is also
 * what sets the plane's protected latch, which a release then clears.
 */
function recordingSource(): {
  readonly source: EpicRuntimeAccountingSource;
  readonly asks: number[];
} {
  const asks: number[] = [];
  return {
    asks,
    source: {
      materializedRoomIds: () => [],
      demoteColdestUnpinned: (overBytes) => {
        asks.push(overBytes);
        return {
          reclaimedBytes: 0,
          deferredBytes: overBytes,
          protectedBytesByKind: [],
        };
      },
      measureRootBytes: () => 0,
      projectionCounts: () => ({
        artifacts: 0,
        chats: 0,
        tuiAgents: 0,
        deletedArtifacts: 0,
        roleClaims: 0,
        treeNodes: 0,
      }),
    },
  };
}

/**
 * A hot-doc RELEASE has to re-drive the accountant, because on the worker path
 * it is the only thing main hears about an eviction.
 *
 * `demote()` deliberately emits no completion event - what the eviction freed
 * travels as the tier's own settlements - and a demoted doc is DROPPED rather
 * than re-settled. So a worker that frees some rooms but fewer bytes than were
 * asked for reports only `hot-doc-release`. `accountant.release` deletes the
 * holder and clears `protectedLatch` without re-examining the plane, so before
 * this fix the remaining overage was never handed to a later tier: the books
 * were correct, and nobody was asked to act on them until unrelated hot-doc
 * activity happened to reconcile.
 *
 * This is the partial-reclaim sibling of the deferred-eviction hole, and it is
 * distinct from it: there the tier freed NOTHING, here the release genuinely
 * succeeded and still drove nothing.
 */
describe("a hot-doc release on a plane that is still over its limit", () => {
  it("re-drives the accountant, so the remaining overage is asked of a tier again", () => {
    const environment = environmentStub();
    // Registers the process-wide planes this port charges against; nothing is
    // read back from it here - the observable is what the TIER was asked.
    ensureProcessMemoryRuntime(environment);
    const rig = recordingSource();
    const port = createProcessBackedAccountingPort({
      hostId: "host-release",
      epicId: "epic-release",
      environment,
    });
    port.registerBooks(rig.source);

    // The room that gets released is charged AT the limit, and the one that
    // survives is charged past it on its own. Two equal charges would leave
    // the plane exactly at the limit after the release - `charged <= soft` is
    // not over - and the pin would then be asserting nothing about the
    // reconcile, only about arithmetic.
    port.settleHotDocBytes("room-a", HOT_DOCS_SOFT_LIMIT_BYTES);
    port.settleHotDocBytes("room-b", HOT_DOCS_SOFT_LIMIT_BYTES + 1);

    // Whatever the settles themselves provoked is setup, not the observable.
    // `settleHotDocBytes` reconciles on its own - that is the driver this fix
    // makes the release match - so the pin is the DELTA across the release.
    const asksBeforeRelease = rig.asks.length;
    expect(asksBeforeRelease).toBeGreaterThan(0);

    port.releaseHotDoc("room-a");

    // Still over (one full soft limit remains charged), and the tier has been
    // asked again. Without the reconcile this stays flat: the latch is cleared
    // by the release and nothing looks at the plane.
    expect(rig.asks.length).toBeGreaterThan(asksBeforeRelease);

    port.unregisterBooks();
  });

  it("does not ask again once the release brings the plane back under the limit", () => {
    const environment = environmentStub();
    ensureProcessMemoryRuntime(environment);
    const rig = recordingSource();
    const port = createProcessBackedAccountingPort({
      hostId: "host-release-under",
      epicId: "epic-release-under",
      environment,
    });
    port.registerBooks(rig.source);

    // One charge over the limit, released entirely. The control that keeps the
    // fix from reading as "reconcile on every release" - a reconcile under the
    // limit must be a no-op, not an eviction.
    port.settleHotDocBytes("room-only", HOT_DOCS_SOFT_LIMIT_BYTES + 1);
    const asksBeforeRelease = rig.asks.length;

    port.releaseHotDoc("room-only");

    expect(rig.asks.length).toBe(asksBeforeRelease);

    port.unregisterBooks();
  });
});
