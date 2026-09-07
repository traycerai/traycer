/** {@link EpicRuntimeAccountingPort} that PUSHES, for the runtime inside the worker. */
import type {
  RuntimeAccountingSettlement,
  RuntimeAccountingSnapshot,
  WorkerToMainEvent,
} from "@traycer-clients/shared/replica-runtime/worker/bridge-protocol";
import type { ProtectedBytes } from "@traycer-clients/shared/replica-runtime/memory-accountant";
import type {
  EpicRuntimeAccountingPort,
  EpicRuntimeAccountingSource,
} from "../epic-runtime-accounting-port";

export interface WorkerAccountingPortHandle {
  readonly port: EpicRuntimeAccountingPort;
  /** Serve one deferred `accounting/demote`. */
  demote(overBytes: number): void;
}

export function createWorkerAccountingPort(
  emit: (event: WorkerToMainEvent) => void,
): WorkerAccountingPortHandle {
  let source: EpicRuntimeAccountingSource | null = null;
  let lastProtectedBytesByKind: readonly ProtectedBytes[] = [];

  function snapshot(): RuntimeAccountingSnapshot {
    const live = source;
    if (live === null) {
      return {
        materializedRoomIds: [],
        rootBytes: 0,
        protectedBytesByKind: [],
        projectionCounts: null,
      };
    }
    return {
      materializedRoomIds: live.materializedRoomIds(),
      rootBytes: live.measureRootBytes(),
      protectedBytesByKind: lastProtectedBytesByKind,
      projectionCounts: live.projectionCounts(),
    };
  }

  function settle(settlement: RuntimeAccountingSettlement): void {
    emit({ kind: "accounting/settle", settlement, snapshot: snapshot() });
  }

  return {
    demote(overBytes): void {
      const live = source;
      if (live === null) return;
      const outcome = live.demoteColdestUnpinned(overBytes);
      // Recorded even when nothing was freed - ESPECIALLY then. A zero-reclaim eviction with a non-empty
      // breakdown is "everything here is pinned", and that is the fact main cannot otherwise learn.
      lastProtectedBytesByKind = outcome.protectedBytesByKind;
      // No settlement is emitted here.
    },

    port: {
      registerBooks(next): void {
        source = next;
        emit({
          kind: "accounting/books",
          registered: true,
          snapshot: snapshot(),
        });
      },

      unregisterBooks(): void {
        // Source first, matching the process-backed port: the deregistration main performs on receipt can
        // race a reconcile that is already walking the books, and an unregistered source answering emptily
        source = null;
        lastProtectedBytesByKind = [];
        emit({ kind: "accounting/books", registered: false, snapshot: null });
      },

      settleRootBytes(bytes): void {
        settle({ kind: "root", bytes });
      },
      settleColdRoomBytes(artifactRoomId, bytes): void {
        settle({ kind: "cold-room", artifactRoomId, bytes });
      },
      settleCommandOverlayBytes(bytes): void {
        settle({ kind: "command-overlay", bytes });
      },
      settleHotDocBytes(artifactRoomId, bytes): void {
        settle({ kind: "hot-doc", artifactRoomId, bytes });
      },
      chargeHotDocProvisional(artifactRoomId, bytes): void {
        settle({ kind: "hot-doc-provisional", artifactRoomId, bytes });
      },
      releaseHotDoc(artifactRoomId): void {
        settle({ kind: "hot-doc-release", artifactRoomId });
      },
      noteHotDocEvictionDeferred(): void {
        // Deliberately nothing.
      },
    },
  };
}
