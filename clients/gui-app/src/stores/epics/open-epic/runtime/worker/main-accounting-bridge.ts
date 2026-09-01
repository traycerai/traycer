/**
 * The main-thread half of the accounting seam.
 *
 * The worker reports its bytes as pushes; this turns them back into calls on
 * the real, process-backed {@link EpicRuntimeAccountingPort}, so T5's books see
 * a worker-resident runtime exactly as they see an in-process one. Everything
 * about identity - the runtime token, the book key, the four holder-id families
 * - stays where it already was, inside the process-backed port. Nothing about
 * it crosses the boundary, which is what keeps the one process-wide minter's
 * monopoly a matter of construction rather than discipline.
 *
 * **The interesting direction is inbound.** The accountant asks
 * {@link EpicRuntimeAccountingSource}'s four questions SYNCHRONOUSLY, mid
 * reconcile, and the runtime that knows the answers is on another thread. This
 * module is what makes that possible without a synchronous main->worker call,
 * which cannot exist:
 *
 * - the three pure reads are answered from the snapshot every settlement
 *   carries, so the cache is never more than one push stale;
 * - `demoteColdestUnpinned` cannot be cached because it DOES something. It is
 *   deferred: answer `reclaimedBytes: 0` with the last known protected
 *   breakdown, dispatch the request, and let what was actually freed arrive as
 *   the settlements that follow.
 *
 * That zero is ambiguous on its own - it is the same answer a tier gives when
 * everything it holds is pinned - and the accountant does NOT read the
 * protected breakdown to tell the two apart. It reads a flag the evicting tier
 * raises for itself, so this bridge raises it (`noteHotDocEvictionDeferred`)
 * from inside the `evict` closure. Without that, every deferred eviction was
 * counted as a REFUSED one and `evictionsDeferred` stayed zero forever. The
 * breakdown is still carried rather than defaulted to empty because it is the
 * honest last-known value, not because it encodes the distinction.
 *
 * `bytesReclaimed` accrues nothing for this plane: the bytes arrive later, as
 * settlements, and attributing them back to the eviction that caused them is a
 * separate design. Out of scope here, and stated so it is not read as an
 * oversight.
 */
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
  /**
   * Feed one worker->main event. Returns `true` if it was an accounting event
   * and was consumed, so the caller's switch can stay exhaustive without this
   * module knowing about the rest of the vocabulary.
   */
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

  return {
    handle(event): boolean {
      switch (event.kind) {
        case "accounting/books": {
          if (event.registered) {
            cache = event.snapshot ?? NO_SNAPSHOT;
            registered = true;
            options.port.registerBooks({
              materializedRoomIds: () => cache.materializedRoomIds,
              measureRootBytes: () => cache.rootBytes,
              projectionCounts: () =>
                narrowProjectionCounts(cache.projectionCounts),
              demoteColdestUnpinned: (overBytes): HotDocEvictionOutcome => {
                // BEFORE the dispatch and INSIDE this closure, both required:
                // `reconcile` clears the flag immediately before calling
                // `evict`, so a call made anywhere earlier is erased, and this
                // zero return is the only thing that would otherwise be read as
                // a refusal.
                options.port.noteHotDocEvictionDeferred();
                options.dispatchDemote(overBytes);
                // Zero freed HERE, with what the tier last refused to give up.
                // The eviction is real and is happening on the other thread;
                // its bytes arrive as settlements and the next reconcile sees
                // them.
                //
                // `deferredBytes` says the same thing to the BOOK, which the
                // side-channel flag above cannot reach: the flag is raised on
                // the accountant, and `HotDocBudgetBook.evict` loops over every
                // epic's tier reading only this outcome. It saw a zero, left
                // its running total untouched, and asked the next epic for the
                // same full overage - so a 1 MiB overage with five open epics
                // dispatched five demotions of 1 MiB each.
                return {
                  deferredBytes: overBytes,
                  reclaimedBytes: 0,
                  protectedBytesByKind: cache.protectedBytesByKind,
                };
              },
            });
            return true;
          }
          // Cache cleared BEFORE deregistering, so a reconcile that reaches
          // the source between these two lines reads emptiness rather than a
          // dead runtime's numbers.
          cache = NO_SNAPSHOT;
          if (registered) {
            registered = false;
            options.port.unregisterBooks();
          }
          return true;
        }
        case "accounting/settle": {
          // Cache FIRST. The settle below can drive a reconcile, and a
          // reconcile reading the pre-settlement snapshot would evict against
          // facts the runtime has already superseded.
          cache = event.snapshot;
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
 * The snapshot's counts, narrowed.
 *
 * They cross as `unknown` because their shape belongs to
 * `epic-replica-budget` and a copy of it in the protocol would rot against the
 * original. Building the result as a literal means a field added to
 * {@link EpicReplicaProjectionCounts} fails to compile HERE, which is the
 * anti-rot property a cast would have thrown away.
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
