import type {
  BudgetHolderId,
  EvictionOutcome,
  MemoryAccountant,
} from "@traycer-clients/shared/replica-runtime";
import { BUDGET_PLANE_IDS } from "@traycer-clients/shared/replica-runtime";

/**
 * Projection-row telemetry for one epic replica. These counts are the
 * exit-criteria row totals, not a second budget — charging the projected
 * JSON on top of the root Y.Doc would double-count the same rows. The six
 * whole-set *chat* snapshot slices (queue / approvals / interviews /
 * background / commands) live on the chat-windows plane.
 */
export interface EpicReplicaProjectionCounts {
  readonly artifacts: number;
  readonly chats: number;
  readonly tuiAgents: number;
  readonly deletedArtifacts: number;
  readonly roleClaims: number;
  readonly treeNodes: number;
}

/**
 * One live epic's replica as the epic-replicas plane sees it.
 *
 * While `@1` is the wire the root Y.Doc must stay resident (it is the only
 * record source). The eviction hook therefore reports the root as
 * `"required"` and reclaims nothing from it.
 */
export interface EpicReplicaBudgetSession {
  readonly key: string;
  measure(): number;
  projectionCounts(): EpicReplicaProjectionCounts;
}

export interface EpicReplicaBudgetBook {
  attach(session: EpicReplicaBudgetSession): void;
  detach(key: string): void;
  settleRoot(
    accountant: MemoryAccountant,
    holderId: BudgetHolderId,
    bytes: number,
  ): void;
  settleColdRoom(
    accountant: MemoryAccountant,
    bookKey: string,
    holderId: BudgetHolderId,
    bytes: number,
  ): void;
  settleCommandOverlay(
    accountant: MemoryAccountant,
    holderId: BudgetHolderId,
    bytes: number,
  ): void;
  release(
    accountant: MemoryAccountant,
    bookKey: string,
    holderIds: readonly BudgetHolderId[],
  ): void;
  evict(overBytes: number): EvictionOutcome;
  projectionRowCounts(): EpicReplicaProjectionCounts;
}

export function epicReplicaBookKey(
  hostId: string,
  epicId: string,
  runtimeToken: string,
): string {
  return `${hostId}:${epicId}:${runtimeToken}`;
}

export function epicRootHolderId(
  hostId: string,
  epicId: string,
  runtimeToken: string,
): BudgetHolderId {
  return `${hostId}:${epicId}:${runtimeToken}:root`;
}

export function epicCommandOverlayHolderId(
  hostId: string,
  epicId: string,
  runtimeToken: string,
): BudgetHolderId {
  return `${hostId}:${epicId}:${runtimeToken}:command-overlay`;
}

export function epicColdRoomHolderId(
  hostId: string,
  epicId: string,
  runtimeToken: string,
  artifactRoomId: string,
): BudgetHolderId {
  return `${hostId}:${epicId}:${runtimeToken}:cold:${artifactRoomId}`;
}

export function createEpicReplicaBudgetBook(): EpicReplicaBudgetBook {
  const sessions = new Map<string, EpicReplicaBudgetSession>();
  const coldRoomsByKey = new Map<string, Set<BudgetHolderId>>();

  return {
    attach(session: EpicReplicaBudgetSession): void {
      sessions.set(session.key, session);
    },

    detach(key: string): void {
      sessions.delete(key);
    },

    settleRoot(
      accountant: MemoryAccountant,
      holderId: BudgetHolderId,
      bytes: number,
    ): void {
      accountant.settle(BUDGET_PLANE_IDS.epicReplicas, holderId, bytes);
    },

    settleColdRoom(
      accountant: MemoryAccountant,
      bookKey: string,
      holderId: BudgetHolderId,
      bytes: number,
    ): void {
      if (bytes === 0) {
        accountant.release(BUDGET_PLANE_IDS.epicReplicas, holderId);
        coldRoomsByKey.get(bookKey)?.delete(holderId);
        return;
      }
      let rooms = coldRoomsByKey.get(bookKey);
      if (rooms === undefined) {
        rooms = new Set();
        coldRoomsByKey.set(bookKey, rooms);
      }
      rooms.add(holderId);
      accountant.settle(BUDGET_PLANE_IDS.epicReplicas, holderId, bytes);
    },

    settleCommandOverlay(
      accountant: MemoryAccountant,
      holderId: BudgetHolderId,
      bytes: number,
    ): void {
      accountant.settle(BUDGET_PLANE_IDS.epicReplicas, holderId, bytes);
    },

    release(
      accountant: MemoryAccountant,
      bookKey: string,
      holderIds: readonly BudgetHolderId[],
    ): void {
      for (const holderId of holderIds) {
        accountant.release(BUDGET_PLANE_IDS.epicReplicas, holderId);
      }
      const coldRooms = coldRoomsByKey.get(bookKey);
      if (coldRooms !== undefined) {
        for (const holderId of coldRooms) {
          accountant.release(BUDGET_PLANE_IDS.epicReplicas, holderId);
        }
        coldRoomsByKey.delete(bookKey);
      }
    },

    evict(overBytes: number): EvictionOutcome {
      void overBytes;
      let protectedBytes = 0;
      for (const session of sessions.values()) {
        protectedBytes += session.measure();
      }
      return {
        reclaimedBytes: 0,
        protectedBytesByKind:
          protectedBytes > 0
            ? [{ kind: "required", bytes: protectedBytes }]
            : [],
      };
    },

    projectionRowCounts(): EpicReplicaProjectionCounts {
      const totals = {
        artifacts: 0,
        chats: 0,
        tuiAgents: 0,
        deletedArtifacts: 0,
        roleClaims: 0,
        treeNodes: 0,
      };
      for (const session of sessions.values()) {
        const counts = session.projectionCounts();
        totals.artifacts += counts.artifacts;
        totals.chats += counts.chats;
        totals.tuiAgents += counts.tuiAgents;
        totals.deletedArtifacts += counts.deletedArtifacts;
        totals.roleClaims += counts.roleClaims;
        totals.treeNodes += counts.treeNodes;
      }
      return totals;
    },
  };
}
