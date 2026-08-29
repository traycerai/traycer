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
 * `"required"` and reclaims nothing from it. Cold-room bytes and projection
 * slices ride the same holder so the floor is attributed honestly rather
 * than vanishing from the snapshot.
 */
export interface EpicReplicaBudgetSession {
  readonly epicId: string;
  measure(): number;
  projectionCounts(): EpicReplicaProjectionCounts;
}

export interface EpicReplicaBudgetBook {
  attach(session: EpicReplicaBudgetSession): void;
  detach(epicId: string): void;
  settleRoot(accountant: MemoryAccountant, epicId: string, bytes: number): void;
  settleColdRooms(
    accountant: MemoryAccountant,
    epicId: string,
    bytes: number,
  ): void;
  settleColdRoom(
    accountant: MemoryAccountant,
    epicId: string,
    artifactRoomId: string,
    bytes: number,
  ): void;
  settleCommandOverlay(
    accountant: MemoryAccountant,
    epicId: string,
    bytes: number,
  ): void;
  release(accountant: MemoryAccountant, epicId: string): void;
  evict(overBytes: number): EvictionOutcome;
  projectionRowCounts(): EpicReplicaProjectionCounts;
}

export function epicRootHolderId(epicId: string): BudgetHolderId {
  return `${epicId}:root`;
}

export function epicCommandOverlayHolderId(epicId: string): BudgetHolderId {
  return `${epicId}:command-overlay`;
}

export function epicColdRoomsHolderId(epicId: string): BudgetHolderId {
  return `${epicId}:cold-rooms`;
}

export function epicColdRoomHolderId(
  epicId: string,
  artifactRoomId: string,
): BudgetHolderId {
  return `${epicId}:cold:${artifactRoomId}`;
}

export function createEpicReplicaBudgetBook(): EpicReplicaBudgetBook {
  const sessions = new Map<string, EpicReplicaBudgetSession>();
  const coldRoomsByEpic = new Map<string, Set<string>>();

  return {
    attach(session: EpicReplicaBudgetSession): void {
      sessions.set(session.epicId, session);
    },

    detach(epicId: string): void {
      sessions.delete(epicId);
    },

    settleRoot(
      accountant: MemoryAccountant,
      epicId: string,
      bytes: number,
    ): void {
      accountant.settle(
        BUDGET_PLANE_IDS.epicReplicas,
        epicRootHolderId(epicId),
        bytes,
      );
    },

    settleColdRooms(
      accountant: MemoryAccountant,
      epicId: string,
      bytes: number,
    ): void {
      accountant.settle(
        BUDGET_PLANE_IDS.epicReplicas,
        epicColdRoomsHolderId(epicId),
        bytes,
      );
    },

    settleColdRoom(
      accountant: MemoryAccountant,
      epicId: string,
      artifactRoomId: string,
      bytes: number,
    ): void {
      const holderId = epicColdRoomHolderId(epicId, artifactRoomId);
      if (bytes === 0) {
        accountant.release(BUDGET_PLANE_IDS.epicReplicas, holderId);
        coldRoomsByEpic.get(epicId)?.delete(artifactRoomId);
        return;
      }
      let rooms = coldRoomsByEpic.get(epicId);
      if (rooms === undefined) {
        rooms = new Set();
        coldRoomsByEpic.set(epicId, rooms);
      }
      rooms.add(artifactRoomId);
      accountant.settle(BUDGET_PLANE_IDS.epicReplicas, holderId, bytes);
    },

    settleCommandOverlay(
      accountant: MemoryAccountant,
      epicId: string,
      bytes: number,
    ): void {
      accountant.settle(
        BUDGET_PLANE_IDS.epicReplicas,
        epicCommandOverlayHolderId(epicId),
        bytes,
      );
    },

    release(accountant: MemoryAccountant, epicId: string): void {
      accountant.release(
        BUDGET_PLANE_IDS.epicReplicas,
        epicRootHolderId(epicId),
      );
      accountant.release(
        BUDGET_PLANE_IDS.epicReplicas,
        epicColdRoomsHolderId(epicId),
      );
      accountant.release(
        BUDGET_PLANE_IDS.epicReplicas,
        epicCommandOverlayHolderId(epicId),
      );
      const coldRooms = coldRoomsByEpic.get(epicId);
      if (coldRooms !== undefined) {
        for (const artifactRoomId of coldRooms) {
          accountant.release(
            BUDGET_PLANE_IDS.epicReplicas,
            epicColdRoomHolderId(epicId, artifactRoomId),
          );
        }
        coldRoomsByEpic.delete(epicId);
      }
    },

    evict(overBytes: number): EvictionOutcome {
      // Honesty constraint: the root replica is not evictable while @1 is
      // the wire. Reclaiming zero is the legal answer; the accountant
      // latches `"over-protected"` and stops.
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
