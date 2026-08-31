/**
 * {@link EpicRuntimeAccountingPort} over T5's process-wide books.
 *
 * **This module is the one that reaches the singleton, and that is the point.**
 * It lives on MAIN and is constructed by whoever composes a runtime, so the
 * import of `process-memory-accountant` — a module-scoped `let processRuntime`
 * that a second thread would COPY rather than share — moves off the runtime's
 * value-import graph and onto main's. The worker-graph ratchet
 * (`worker/__tests__/worker-graph-singletons.test.ts`) is what holds that line.
 *
 * All identity composition lives here: the runtime token, the book key and the
 * four holder-id families are how the accountant names holders, and the runtime
 * has no business knowing them.
 *
 * **The token is minted from the ONE process accountant's sequence**
 * (`memory.nextRuntimeToken()`), not from a second sequence kept "for
 * workers". Both arms — the in-process store and the worker composition —
 * construct this port on main, so both draw from that single minter. It
 * matters at exactly one moment: the merge window, where an old and a new
 * runtime for the same `(hostId, epicId)` are both alive. Two independent
 * sequences would each mint `"1"`, both books would register under an
 * identical `bookKey`, the second `attach` would overwrite the first, and the
 * old runtime's teardown would then deregister the NEW one.
 */
import {
  BUDGET_PLANE_IDS,
  type EvictionOutcome,
} from "@traycer-clients/shared/replica-runtime";
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

/**
 * The eviction answer for a runtime that has not registered its books.
 *
 * Zero freed AND nothing protected, which is the honest pair: there is no tier
 * here, so nothing was reclaimed and nothing is holding bytes down. Contrast
 * the flip's deferred proxy, which reports zero freed with the tier's LAST
 * KNOWN protected breakdown — same `reclaimedBytes`, entirely different claim.
 */
const NOTHING_TO_EVICT: EvictionOutcome = {
  reclaimedBytes: 0,
  protectedBytesByKind: [],
};

export function createProcessBackedAccountingPort(
  identity: EpicRuntimeAccountingIdentity,
): EpicRuntimeAccountingPort {
  const { hostId, epicId, environment } = identity;
  const memory = ensureProcessMemoryRuntime(environment);
  const runtimeToken = memory.nextRuntimeToken();
  const bookKey = epicReplicaBookKey(hostId, epicId, runtimeToken);

  // Null until `registerBooks`, and null again after `unregisterBooks`. The
  // books hold these closures, so a callback arriving after deregistration is
  // a real ordering (an in-flight reconcile), not a defect - it must answer
  // emptily rather than throw.
  let source: EpicRuntimeAccountingSource | null = null;

  // Every artifact room this runtime currently holds a hot-docs charge for.
  //
  // The hot-docs plane charges PER ROOM, and unlike `epicReplicas` - whose
  // `release` derives every holder id it owns from `bookKey` - a hot-doc
  // holder id is only recoverable from the room id that built it. Nothing else
  // remembers those, and `materializedIds()` cannot stand in: `unregisterBooks`
  // drops `source` before it detaches, deliberately, so by then the tier
  // answers emptily. So the port keeps the list itself.
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
      // Source first: the detaches below can be reached from a reconcile that
      // is already walking the books, and an unregistered source answering
      // emptily is safer than one answering from a runtime mid-teardown.
      source = null;
      memory.hotDocs.detach(bookKey);
      // The counterpart of `epicReplicas.release` below, and needed for the
      // same reason: `detach` removes the TIER - the thing eviction walks -
      // while the accountant keeps every charge this runtime made. A worker
      // fatal or a spawner disposal reaches here after event routing is
      // already unsubscribed, so the per-room releases never arrive on their
      // own. Without this, those bytes stay charged to a plane that no longer
      // has a tier able to evict them: permanent phantom usage that pushes
      // live documents out of a budget the dead runtime is still occupying.
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

    // ── Reporting ─────────────────────────────────────────────────────────
    //
    // Which of these reconcile is preserved EXACTLY from the pre-4e call
    // sites, and the asymmetry is deliberate rather than an oversight:
    // a settle is a new floor and can put a plane over its limit, while a
    // provisional charge is an increment the tier will settle shortly and a
    // release only ever frees. The command overlay does not reconcile because
    // it is republished on every queue change and reconciling there would walk
    // the plane on every keystroke-driven write.

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
    },

    noteHotDocEvictionDeferred(): void {
      memory.accountant.noteEvictionDeferred(BUDGET_PLANE_IDS.hotDocs);
    },
  };
}
