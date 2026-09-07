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
    // Counted as a DELTA against whatever else this process has attached: the accountant is a
    // module-scoped singleton by design, so an absolute expectation here would depend on suite order.
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

    // Two, not zero.
    expect(memory.hotDocs.docsResident()).toBe(baseline + 2);

    incoming.unregisterBooks();
    expect(memory.hotDocs.docsResident()).toBe(baseline);
  });
});

/** A tier that RECORDS what it was asked to free, standing in for the worker proxy. */
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
 * A hot-doc RELEASE has to re-drive the accountant, because on the worker path it is the only
 * thing main hears about an eviction.
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

    // The room that gets released is charged AT the limit, and the one that survives is charged past
    // it on its own.
    port.settleHotDocBytes("room-a", HOT_DOCS_SOFT_LIMIT_BYTES);
    port.settleHotDocBytes("room-b", HOT_DOCS_SOFT_LIMIT_BYTES + 1);

    // Whatever the settles themselves provoked is setup, not the observable.
    const asksBeforeRelease = rig.asks.length;
    expect(asksBeforeRelease).toBeGreaterThan(0);

    port.releaseHotDoc("room-a");

    // Still over (one full soft limit remains charged), and the tier has been asked again. Without the
    // reconcile this stays flat: the latch is cleared by the release and nothing looks at the plane.
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

    // One charge over the limit, released entirely. The control that keeps the fix from reading as
    // "reconcile on every release" - a reconcile under the limit must be a no-op, not an eviction.
    port.settleHotDocBytes("room-only", HOT_DOCS_SOFT_LIMIT_BYTES + 1);
    const asksBeforeRelease = rig.asks.length;

    port.releaseHotDoc("room-only");

    expect(rig.asks.length).toBe(asksBeforeRelease);

    port.unregisterBooks();
  });
});
