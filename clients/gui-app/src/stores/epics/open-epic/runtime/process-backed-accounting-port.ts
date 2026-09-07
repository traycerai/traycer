/** {@link EpicRuntimeAccountingPort} over T5's process-wide books. */
import { BUDGET_PLANE_IDS } from "@traycer-clients/shared/replica-runtime";
import { ensureProcessMemoryRuntime } from "@/stores/replica-memory/process-memory-accountant";
import { hotDocHolderId } from "@/stores/replica-memory/hot-doc-budget";
import {
  epicColdRoomHolderId,
  epicCommandOverlayHolderId,
  epicReplicaBookKey,
  epicRootHolderId,
} from "@/stores/replica-memory/epic-replica-budget";
import type {
  EpicRuntimeAccountingIdentity,
  EpicRuntimeAccountingPort,
  EpicRuntimeAccountingSource,
} from "./epic-runtime-accounting-port";
import type { HotDocEvictionOutcome } from "./epic-runtime-accounting-port";

/** The eviction answer for a runtime that has not registered its books. */
const NOTHING_TO_EVICT: HotDocEvictionOutcome = {
  reclaimedBytes: 0,
  // A REFUSAL, not a deferral - there is no source to dispatch to, so nothing
  // is coming later and the book must go on to the next epic's tier.
  deferredBytes: 0,
  protectedBytesByKind: [],
};

export function createProcessBackedAccountingPort(
  identity: EpicRuntimeAccountingIdentity,
): EpicRuntimeAccountingPort {
  const { hostId, epicId, environment } = identity;
  const memory = ensureProcessMemoryRuntime(environment);
  const runtimeToken = memory.nextRuntimeToken();
  const bookKey = epicReplicaBookKey(hostId, epicId, runtimeToken);

  // Null until `registerBooks`, and null again after `unregisterBooks`.
  let source: EpicRuntimeAccountingSource | null = null;

  // Every artifact room this runtime currently holds a hot-docs charge for.
  const chargedHotRooms = new Set<string>();

  return {
    registerBooks(next): void {
      source = next;
      memory.hotDocs.attach({
        key: bookKey,
        materializedIds: () => source?.materializedRoomIds() ?? [],
        demoteColdestUnpinned: (overBytes) =>
          source?.demoteColdestUnpinned(overBytes) ?? NOTHING_TO_EVICT,
      });
      memory.epicReplicas.attach({
        key: bookKey,
        measure: () => source?.measureRootBytes() ?? 0,
        projectionCounts: () =>
          source?.projectionCounts() ?? {
            artifacts: 0,
            chats: 0,
            tuiAgents: 0,
            deletedArtifacts: 0,
            roleClaims: 0,
            treeNodes: 0,
          },
      });
    },

    unregisterBooks(): void {
      // Source first: the detaches below can be reached from a reconcile that is already walking the
      // books, and an unregistered source answering emptily is safer than one answering from a runtime
      source = null;
      memory.hotDocs.detach(bookKey);
      // The counterpart of `epicReplicas.release` below, and needed for the same reason: `detach`
      // removes the TIER - the thing eviction walks - while the accountant keeps every charge this
      for (const artifactRoomId of chargedHotRooms) {
        memory.hotDocs.release(
          memory.accountant,
          hotDocHolderId(hostId, epicId, runtimeToken, artifactRoomId),
        );
      }
      chargedHotRooms.clear();
      memory.epicReplicas.detach(bookKey);
      memory.epicReplicas.release(memory.accountant, bookKey);
    },


    settleRootBytes(bytes): void {
      memory.epicReplicas.settleRoot(
        memory.accountant,
        epicRootHolderId(hostId, epicId, runtimeToken),
        bytes,
      );
      memory.accountant.reconcile(BUDGET_PLANE_IDS.epicReplicas);
    },

    settleColdRoomBytes(artifactRoomId, bytes): void {
      memory.epicReplicas.settleColdRoom(
        memory.accountant,
        bookKey,
        epicColdRoomHolderId(hostId, epicId, runtimeToken, artifactRoomId),
        bytes,
      );
      memory.accountant.reconcile(BUDGET_PLANE_IDS.epicReplicas);
    },

    settleCommandOverlayBytes(bytes): void {
      memory.epicReplicas.settleCommandOverlay(
        memory.accountant,
        epicCommandOverlayHolderId(hostId, epicId, runtimeToken),
        bytes,
      );
    },

    settleHotDocBytes(artifactRoomId, bytes): void {
      chargedHotRooms.add(artifactRoomId);
      memory.hotDocs.settle(
        memory.accountant,
        hotDocHolderId(hostId, epicId, runtimeToken, artifactRoomId),
        bytes,
      );
      memory.accountant.reconcile(BUDGET_PLANE_IDS.hotDocs);
    },

    chargeHotDocProvisional(artifactRoomId, bytes): void {
      chargedHotRooms.add(artifactRoomId);
      memory.hotDocs.chargeProvisional(
        memory.accountant,
        hotDocHolderId(hostId, epicId, runtimeToken, artifactRoomId),
        bytes,
      );
    },

    releaseHotDoc(artifactRoomId): void {
      chargedHotRooms.delete(artifactRoomId);
      memory.hotDocs.release(
        memory.accountant,
        hotDocHolderId(hostId, epicId, runtimeToken, artifactRoomId),
      );
      // RECONCILED, symmetrically with `settleHotDocBytes` above, because a release is how a
      // WORKER-resident tier reports what an eviction freed.
      memory.accountant.reconcile(BUDGET_PLANE_IDS.hotDocs);
    },

    noteHotDocEvictionDeferred(): void {
      memory.accountant.noteEvictionDeferred(BUDGET_PLANE_IDS.hotDocs);
    },
  };
}
