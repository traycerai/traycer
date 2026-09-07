/** The main-thread half of the accounting seam. */
import type {
  RuntimeAccountingSnapshot,
  WorkerToMainEvent,
} from "@traycer-clients/shared/replica-runtime/worker/bridge-protocol";
import type { EpicReplicaProjectionCounts } from "@/stores/replica-memory/epic-replica-budget";
import type {
  EpicRuntimeAccountingPort,
  HotDocEvictionOutcome,
} from "../epic-runtime-accounting-port";

const EMPTY_PROJECTION_COUNTS: EpicReplicaProjectionCounts = {
  artifacts: 0,
  chats: 0,
  tuiAgents: 0,
  deletedArtifacts: 0,
  roleClaims: 0,
  treeNodes: 0,
};

const NO_SNAPSHOT: RuntimeAccountingSnapshot = {
  materializedRoomIds: [],
  rootBytes: 0,
  protectedBytesByKind: [],
  projectionCounts: null,
};

export interface MainAccountingBridge {
  /** Feed one worker->main event. */
  handle(event: WorkerToMainEvent): boolean;
  /** Deregister the books, for a worker that died without saying so. */
  dispose(): void;
}

export function createMainAccountingBridge(options: {
  readonly port: EpicRuntimeAccountingPort;
  /** Sends `accounting/demote` to the worker. */
  readonly dispatchDemote: (overBytes: number) => void;
}): MainAccountingBridge {
  let cache: RuntimeAccountingSnapshot = NO_SNAPSHOT;
  let registered = false;
  /** A demote was dispatched and this runtime has reported NOTHING since. */
  let demoteUnanswered = false;

  return {
    handle(event): boolean {
      switch (event.kind) {
        case "accounting/books": {
          // Both arms.
          demoteUnanswered = false;
          if (event.registered) {
            cache = event.snapshot ?? NO_SNAPSHOT;
            registered = true;
            options.port.registerBooks({
              materializedRoomIds: () => cache.materializedRoomIds,
              measureRootBytes: () => cache.rootBytes,
              projectionCounts: () =>
                narrowProjectionCounts(cache.projectionCounts),
              demoteColdestUnpinned: (overBytes): HotDocEvictionOutcome => {
                // A REFUSAL, not a deferral - see {@link demoteUnanswered}.
                if (demoteUnanswered) {
                  return {
                    deferredBytes: 0,
                    reclaimedBytes: 0,
                    protectedBytesByKind: cache.protectedBytesByKind,
                  };
                }
                demoteUnanswered = true;
                // BEFORE the dispatch and INSIDE this closure, both required: `reconcile` clears the flag
                // immediately before calling `evict`, so a call made anywhere earlier is erased, and this zero
                options.port.noteHotDocEvictionDeferred();
                options.dispatchDemote(overBytes);
                // The eviction is real and is happening on the other thread; its bytes arrive as settlements and
                // the next reconcile sees them.
                return {
                  deferredBytes: overBytes,
                  reclaimedBytes: 0,
                  protectedBytesByKind: cache.protectedBytesByKind,
                };
              },
            });
            return true;
          }
          // Cache cleared BEFORE deregistering, so a reconcile that reaches the source between these two
          // lines reads emptiness rather than a dead runtime's numbers.
          cache = NO_SNAPSHOT;
          if (registered) {
            registered = false;
            options.port.unregisterBooks();
          }
          return true;
        }
        case "accounting/settle": {
          // Cache FIRST. The settle below can drive a reconcile, and a reconcile reading the pre-settlement
          // snapshot would evict against facts the runtime has already superseded.
          cache = event.snapshot;
          // Re-armed here for the same reason and in the same window: the settle below can drive the
          // reconcile that asks this tier again, and it must see a runtime that has answered.
          demoteUnanswered = false;
          const settlement = event.settlement;
          switch (settlement.kind) {
            case "root":
              options.port.settleRootBytes(settlement.bytes);
              return true;
            case "cold-room":
              options.port.settleColdRoomBytes(
                settlement.artifactRoomId,
                settlement.bytes,
              );
              return true;
            case "command-overlay":
              options.port.settleCommandOverlayBytes(settlement.bytes);
              return true;
            case "hot-doc":
              options.port.settleHotDocBytes(
                settlement.artifactRoomId,
                settlement.bytes,
              );
              return true;
            case "hot-doc-provisional":
              options.port.chargeHotDocProvisional(
                settlement.artifactRoomId,
                settlement.bytes,
              );
              return true;
            case "hot-doc-release":
              options.port.releaseHotDoc(settlement.artifactRoomId);
              return true;
          }
        }
      }
      return false;
    },

    dispose(): void {
      cache = NO_SNAPSHOT;
      if (!registered) return;
      registered = false;
      options.port.unregisterBooks();
    },
  };
}

/**
 * The snapshot's counts, narrowed. They cross as `unknown` because their shape belongs to
 * `epic-replica-budget` and a copy of it in the protocol would rot against the original.
 */
function narrowProjectionCounts(value: unknown): EpicReplicaProjectionCounts {
  if (typeof value !== "object" || value === null) {
    return EMPTY_PROJECTION_COUNTS;
  }
  return {
    artifacts: readCount(value, "artifacts"),
    chats: readCount(value, "chats"),
    tuiAgents: readCount(value, "tuiAgents"),
    deletedArtifacts: readCount(value, "deletedArtifacts"),
    roleClaims: readCount(value, "roleClaims"),
    treeNodes: readCount(value, "treeNodes"),
  };
}

function readCount(value: object, key: string): number {
  const read: unknown = Reflect.get(value, key);
  return typeof read === "number" && Number.isFinite(read) ? read : 0;
}
