/**
 * {@link EpicRuntimeAccountingPort} that PUSHES, for the runtime inside the
 * worker.
 *
 * The counterpart of `process-backed-accounting-port.ts`, which is the same
 * interface backed by T5's books directly. That module reaches a module-scoped
 * `let processRuntime`, and a worker importing it would get a second COPY of
 * the accountant rather than a second reference to one - so the worker gets
 * this instead, and the books stay on main where there is exactly one set.
 *
 * The interface survives the crossing unchanged because every reporting member
 * returns `void`. That was the design constraint 4e was built to satisfy, and
 * this module is where it pays: six members, six fire-and-forget pushes, no
 * shape change.
 *
 * **The inbound direction is the hard half, and it is not symmetric.** Main's
 * accountant asks four questions SYNCHRONOUSLY during a reconcile. Three are
 * pure reads, answered on main from the snapshot every settlement carries.
 * The fourth - `demoteColdestUnpinned` - performs work, so it cannot be
 * answered from a cache at all: main defers it, and {@link demote} below is
 * where the deferred request lands. What it frees comes back as ordinary
 * settlements, and main's next reconcile sees them.
 */
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
  /**
   * Serve one deferred `accounting/demote`.
   *
   * A no-op before `registerBooks` and after `unregisterBooks`, deliberately:
   * a reconcile already in flight when the runtime tears down would otherwise
   * reach a source mid-disposal, and "nothing to evict" is the honest answer
   * from a runtime that no longer holds anything.
   */
  demote(overBytes: number): void;
}

export function createWorkerAccountingPort(
  emit: (event: WorkerToMainEvent) => void,
): WorkerAccountingPortHandle {
  let source: EpicRuntimeAccountingSource | null = null;
  // What the LAST eviction refused to give up. Empty before the first one,
  // which is the honest "nothing known yet" rather than a claim that nothing
  // is pinned - the two read identically here and are distinguished on main by
  // whether a demote has been dispatched at all.
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
      // Recorded even when nothing was freed - ESPECIALLY then. A zero-reclaim
      // eviction with a non-empty breakdown is "everything here is pinned",
      // and that is the fact main cannot otherwise learn.
      lastProtectedBytesByKind = outcome.protectedBytesByKind;
      // No settlement is emitted here. What the eviction actually freed
      // travels as the tier's own settles, which carry the refreshed snapshot
      // with them; emitting a second report of the same bytes would double
      // count against a plane that has already been told.
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
        // Source first, matching the process-backed port: the deregistration
        // main performs on receipt can race a reconcile that is already
        // walking the books, and an unregistered source answering emptily is
        // safer than one answering from a runtime mid-teardown.
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
        // Deliberately nothing. The deferring tier is the MAIN-side bridge,
        // which holds the process-backed port directly; a worker-resident
        // runtime never dispatches a demote to itself, so there is no deferral
        // here to report.
      },
    },
  };
}
