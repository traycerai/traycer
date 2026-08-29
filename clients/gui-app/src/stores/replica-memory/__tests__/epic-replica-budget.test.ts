/**
 * Epic-replicas plane: host-scoped + runtime-token keys so a cross-host
 * re-point's loser cannot release the winner; the hook reports the root as
 * `required` and reclaims nothing.
 */
import { describe, expect, it, vi } from "vitest";
import type { RuntimeEnvironment } from "@traycer-clients/shared/replica-runtime";
import {
  BUDGET_PLANE_IDS,
  createMemoryAccountant,
} from "@traycer-clients/shared/replica-runtime";
import {
  createEpicReplicaBudgetBook,
  epicColdRoomHolderId,
  epicCommandOverlayHolderId,
  epicReplicaBookKey,
  epicRootHolderId,
} from "@/stores/replica-memory/epic-replica-budget";

function fakeEnvironment(): RuntimeEnvironment {
  return {
    clock: { now: () => 0 },
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

describe("epic replica holder identity", () => {
  it("scopes book keys and holders by host and runtime token", () => {
    expect(epicReplicaBookKey("h1", "e", "t1")).not.toBe(
      epicReplicaBookKey("h2", "e", "t1"),
    );
    expect(epicReplicaBookKey("h1", "e", "t1")).not.toBe(
      epicReplicaBookKey("h1", "e", "t2"),
    );
    expect(epicRootHolderId("h1", "e", "t1")).not.toBe(
      epicRootHolderId("h2", "e", "t1"),
    );
    expect(epicCommandOverlayHolderId("h1", "e", "t1")).not.toBe(
      epicCommandOverlayHolderId("h1", "e", "t2"),
    );
    expect(epicColdRoomHolderId("h1", "e", "t1", "room")).not.toBe(
      epicColdRoomHolderId("h1", "e", "t2", "room"),
    );
  });
});

describe("createEpicReplicaBudgetBook", () => {
  it("reports the resident root as required and reclaims nothing", () => {
    const book = createEpicReplicaBudgetBook();
    book.attach({
      key: epicReplicaBookKey("h", "e", "t"),
      measure: () => 400,
      projectionCounts: () => ({
        artifacts: 3,
        chats: 1,
        tuiAgents: 0,
        deletedArtifacts: 0,
        roleClaims: 2,
        treeNodes: 4,
      }),
    });
    const outcome = book.evict(1_000);
    expect(outcome.reclaimedBytes).toBe(0);
    expect(outcome.protectedBytesByKind).toEqual([
      { kind: "required", bytes: 400 },
    ]);
    expect(book.projectionRowCounts().artifacts).toBe(3);
    expect(book.projectionRowCounts().treeNodes).toBe(4);
  });

  it("settleColdRoom(0) releases the holder so a later settle can re-add it", () => {
    const accountant = createMemoryAccountant({
      environment: fakeEnvironment(),
      observedCeilingBytes: 10_000,
    });
    accountant.register({
      planeId: BUDGET_PLANE_IDS.epicReplicas,
      softLimitBytes: 10_000,
      nearThresholdRatio: 0.8,
      evict: () => ({ reclaimedBytes: 0, protectedBytesByKind: [] }),
    });
    const book = createEpicReplicaBudgetBook();
    const key = epicReplicaBookKey("h", "e", "t");
    const holderId = epicColdRoomHolderId("h", "e", "t", "room-1");
    book.settleColdRoom(accountant, key, holderId, 80);
    expect(
      accountant
        .snapshot()
        .planes.find((plane) => plane.planeId === BUDGET_PLANE_IDS.epicReplicas)
        ?.settledBytes,
    ).toBe(80);
    book.settleColdRoom(accountant, key, holderId, 0);
    expect(
      accountant
        .snapshot()
        .planes.find((plane) => plane.planeId === BUDGET_PLANE_IDS.epicReplicas)
        ?.holderCount,
    ).toBe(0);
    book.settleColdRoom(accountant, key, holderId, 40);
    expect(
      accountant
        .snapshot()
        .planes.find((plane) => plane.planeId === BUDGET_PLANE_IDS.epicReplicas)
        ?.settledBytes,
    ).toBe(40);
  });

  it("the loser of a replaceMounted-shaped re-point does not release the winner", () => {
    const accountant = createMemoryAccountant({
      environment: fakeEnvironment(),
      observedCeilingBytes: 10_000,
    });
    accountant.register({
      planeId: BUDGET_PLANE_IDS.epicReplicas,
      softLimitBytes: 10_000,
      nearThresholdRatio: 0.8,
      evict: () => ({ reclaimedBytes: 0, protectedBytesByKind: [] }),
    });
    const book = createEpicReplicaBudgetBook();
    const loserKey = epicReplicaBookKey("host-a", "epic-1", "token-a");
    const winnerKey = epicReplicaBookKey("host-b", "epic-1", "token-b");
    book.attach({
      key: loserKey,
      measure: () => 100,
      projectionCounts: () => ({
        artifacts: 0,
        chats: 0,
        tuiAgents: 0,
        deletedArtifacts: 0,
        roleClaims: 0,
        treeNodes: 0,
      }),
    });
    book.settleRoot(
      accountant,
      epicRootHolderId("host-a", "epic-1", "token-a"),
      100,
    );
    book.attach({
      key: winnerKey,
      measure: () => 200,
      projectionCounts: () => ({
        artifacts: 1,
        chats: 0,
        tuiAgents: 0,
        deletedArtifacts: 0,
        roleClaims: 0,
        treeNodes: 0,
      }),
    });
    book.settleRoot(
      accountant,
      epicRootHolderId("host-b", "epic-1", "token-b"),
      200,
    );
    book.detach(loserKey);
    book.release(accountant, loserKey, [
      epicRootHolderId("host-a", "epic-1", "token-a"),
      epicCommandOverlayHolderId("host-a", "epic-1", "token-a"),
    ]);
    const usage = accountant
      .snapshot()
      .planes.find((plane) => plane.planeId === BUDGET_PLANE_IDS.epicReplicas);
    expect(usage?.settledBytes).toBe(200);
    expect(usage?.holderCount).toBe(1);
    expect(book.projectionRowCounts().artifacts).toBe(1);
  });
});
