import { describe, expect, it, vi } from "vitest";
import type { RuntimeEnvironment } from "@traycer-clients/shared/replica-runtime";
import { BUDGET_PLANE_IDS } from "@traycer-clients/shared/replica-runtime";
import { createProcessMemoryRuntime } from "@/stores/replica-memory/process-memory-accountant";
import { hotDocHolderId } from "@/stores/replica-memory/hot-doc-budget";
import { HOT_DOCS_SOFT_LIMIT_BYTES } from "@/stores/replica-memory/budget-limits";
import {
  collectReplicaMemoryTelemetry,
  pressureOfPlane,
  replicaMemoryPillInputOf,
} from "@/stores/replica-memory/memory-telemetry";

function fakeEnvironment(): RuntimeEnvironment {
  return {
    clock: { now: () => 12 },
    scheduler: {
      schedule() {
        return { cancel(): void {} };
      },
      scheduleMicrotask(): void {},
    },
    logger: {
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };
}

describe("collectReplicaMemoryTelemetry", () => {
  it("surfaces docsResident, projection rows, and pill input from a real runtime", () => {
    const runtime = createProcessMemoryRuntime(fakeEnvironment());
    runtime.hotDocs.attach({
      key: "host:epic:rt",
      materializedIds: () => ["room-a", "room-b"],
      demoteColdestUnpinned: () => ({
        reclaimedBytes: 0,
        protectedBytesByKind: [],
      }),
    });
    runtime.epicReplicas.attach({
      key: "host:epic:rt",
      measure: () => 0,
      projectionCounts: () => ({
        artifacts: 4,
        chats: 2,
        tuiAgents: 1,
        deletedArtifacts: 0,
        roleClaims: 3,
        treeNodes: 5,
      }),
    });
    const telemetry = collectReplicaMemoryTelemetry(runtime);
    expect(telemetry.docsResident).toBe(2);
    expect(telemetry.projectionRowCounts).toEqual({
      artifacts: 4,
      chats: 2,
      tuiAgents: 1,
      deletedArtifacts: 0,
      roleClaims: 3,
      treeNodes: 5,
    });
    expect(telemetry.accountant.takenAtMs).toBe(12);
    expect(pressureOfPlane(telemetry, BUDGET_PLANE_IDS.hotDocs)).toBe("under");
    const pill = replicaMemoryPillInputOf(telemetry);
    expect(pill.observedCeilingBytes).toBe(runtime.observedCeilingBytes);
    expect(pill.totalChargedBytes).toBe(telemetry.accountant.totalChargedBytes);
    expect(pill.pressureByPlane[BUDGET_PLANE_IDS.chatWindows]).toBe("under");
  });

  it("pressureOfPlane is under when the plane is absent from the snapshot", () => {
    const runtime = createProcessMemoryRuntime(fakeEnvironment());
    const telemetry = collectReplicaMemoryTelemetry(runtime);
    expect(pressureOfPlane(telemetry, "canvas")).toBe("under");
  });

  it("THE REDDENING ONE - evictionEffectiveness sums a plane's DEFERRED evictions, not just requested/reclaimed/refused", () => {
    const runtime = createProcessMemoryRuntime(fakeEnvironment());
    // A tier that defers rather than declines - it reports the deferral to
    // the accountant itself, mirroring what a fixed `createMainAccountingBridge`
    // does from inside `demoteColdestUnpinned`.
    runtime.hotDocs.attach({
      key: "host:epic:rt",
      materializedIds: () => [],
      demoteColdestUnpinned: () => {
        runtime.accountant.noteEvictionDeferred(BUDGET_PLANE_IDS.hotDocs);
        return {
          reclaimedBytes: 0,
          protectedBytesByKind: [{ kind: "leased", bytes: 4_096 }],
        };
      },
    });
    runtime.hotDocs.settle(
      runtime.accountant,
      hotDocHolderId("host-1", "epic-1", "token-1", "room-1"),
      HOT_DOCS_SOFT_LIMIT_BYTES * 2,
    );
    runtime.accountant.reconcile(BUDGET_PLANE_IDS.hotDocs);

    const telemetry = collectReplicaMemoryTelemetry(runtime);
    // Without this field a memory-pressure affordance cannot tell a deferred
    // eviction from one that never happened - the counter can be correct in
    // the accountant and still have no way to reach a reader.
    expect(telemetry.evictionEffectiveness.evictionsDeferred).toBe(1);
    // Asserted beside the field that already existed, so this pin cannot pass
    // by `evictionsDeferred` silently aliasing `evictionsRefused`.
    expect(telemetry.evictionEffectiveness.evictionsRefused).toBe(0);
  });
});
