/**
 * The identity body tier: one live `Y.Doc` + `Awareness` per OPEN markdown file.
 *
 * A reduced copy of `open-epic/runtime/artifact-room-tier.ts`. What is kept
 * is everything a co-edited body needs to be correct - the origin filter that
 * stops host applies echoing back out, the doc-guid guard on every inbound
 * frame, the dirty watermark that says whether the host has seen every local
 * byte, the queue that retains edits the lane cannot carry yet, and the hot-doc
 * budget charge. What is dropped is the hot/cold machinery: an identity holds
 * a handful of small markdown files, a body exists here only while an editor
 * leases it, and on the last release the doc is destroyed rather than encoded
 * cold. That is a memory decision the epic tier could not make because canvas
 * tiles come and go by the dozen; an identity surface shows one body at a time.
 *
 * ## Addressed by PATH
 *
 * The body lane's `docId` is the identity-root-relative path (see
 * `identity-file-lane-adapter.ts`), and the tier is keyed on the same string.
 * A file deleted and recreated at one path arrives as a `doc` frame naming a
 * new guid, and the replace rule below discards what is held for it - so the
 * path can be reused as a key without splicing two documents' histories.
 */
import * as Y from "yjs";
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
} from "y-protocols/awareness";
import type {
  BudgetHolderId,
  DocSeedMode,
  DocUnavailableCode,
  SendOutcome,
} from "@traycer-clients/shared/replica-runtime";
import { sessionKeyOf } from "@traycer-clients/shared/replica-runtime";
import type { AgentIdentityFileSeedOffer } from "@traycer/protocol/host/agent-identity/file-subscribe";
import {
  decodeBase64,
  encodeDocStateVectorBase64,
  isNonTrivialYUpdate,
  latestHostCoversDirtyWatermark,
} from "@/stores/epics/open-epic/runtime/dirty-watermark";
import {
  AWAITING_SEED_AVAILABILITY,
  READY_AVAILABILITY,
  type IdentityFileBodyAvailability,
} from "./types";

/** Host-originated applies carry this origin so the outbound observer skips them. */
const BIN_STREAM_ORIGIN = Symbol("open-identity/body-stream");
/** Remote awareness frames carry this origin so the outbound observer skips them. */
const BIN_AWARENESS_REMOTE_ORIGIN = "identity-body-stream-remote";

/** Collapse the retained queue once it outgrows either threshold - see below. */
const PENDING_COLLAPSE_BYTES = 256 * 1024;
const PENDING_COLLAPSE_ENTRIES = 64;
/** Re-measure the doc for the budget once this much has grown since the last settle. */
const HOT_DOC_RESETTLE_BYTES = 64 * 1024;

export interface IdentityBodyEntry {
  readonly doc: Y.Doc;
  readonly awareness: Awareness;
  readonly docUpdateHandler: (update: Uint8Array, origin: unknown) => void;
  readonly awarenessUpdateHandler: (
    changes: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => void;
  /** The authority's doc identity, learned from the seed. `null` until then. */
  docGuid: string | null;
  /**
   * Local edits the lane could not carry when they were made. The only
   * outbound path for those bytes, so nothing here is ever discarded - only
   * merged, which `Y.mergeUpdates` does losslessly.
   */
  readonly pendingUpdates: Uint8Array[];
  pendingBytesSinceCollapse: number;
  dirtyWatermarkStateVectorBase64: string | null;
  latestHostStateVectorBase64: string | null;
  hotBytesSinceSettle: number;
  availability: IdentityFileBodyAvailability;
}

/** What the tier sends up its lane. The lanes module maps these onto the adapter. */
export type IdentityBodyOutbound =
  | {
      readonly kind: "update";
      readonly path: string;
      readonly update: Uint8Array;
    }
  | {
      readonly kind: "awareness";
      readonly path: string;
      readonly frame: Uint8Array;
    };

/** The hot-doc budget, narrowed to what this tier calls. */
export interface IdentityBodyBudgetSink {
  settle(holderId: BudgetHolderId, bytes: number): void;
  chargeProvisional(holderId: BudgetHolderId, bytes: number): void;
  release(holderId: BudgetHolderId): void;
}

export interface IdentityBodyTierSources {
  readonly hostId: string;
  readonly identityId: string;
  /** Distinguishes two runtimes for one identity in one process (a reopen). */
  readonly runtimeToken: string;
  readonly send: (request: IdentityBodyOutbound) => SendOutcome;
  /** Whether local edits may go out right now - the lane is open and writable. */
  readonly canSendBodyWrites: () => boolean;
  /** Something observable changed for one path. */
  readonly onChanged: (path: string) => void;
  readonly isDisposed: () => boolean;
  readonly budget: IdentityBodyBudgetSink | null;
}

export interface IdentityBodyTier {
  /**
   * Materialize (or keep) the body for `path`. Idempotent; the doc survives
   * until {@link release} takes its last lease.
   */
  acquire(path: string): void;
  release(path: string): void;
  /** The held doc, or `null` when nothing is held or no seed has landed. */
  doc(path: string): Y.Doc | null;
  awareness(path: string): Awareness | null;
  availability(path: string): IdentityFileBodyAvailability;
  /** Whether local bytes exist the host has not acknowledged. */
  isDirty(path: string): boolean;
  /**
   * Whether local edits are RETAINED for `path` because no lane could carry
   * them yet. Distinct from {@link isDirty}: sent-but-unacked bytes are dirty
   * and safe; these have never left the process.
   */
  hasPendingBytes(path: string): boolean;
  /** What this client holds for `path`, for the lane's seed offer. */
  seedOffer(path: string): AgentIdentityFileSeedOffer | null;
  applySnapshot(input: {
    readonly path: string;
    readonly docGuid: string;
    readonly update: Uint8Array;
    readonly hostStateVectorBase64: string | null;
    readonly seed: DocSeedMode;
  }): void;
  applyUpdate(path: string, docGuid: string, update: Uint8Array): void;
  applyCoverage(
    path: string,
    docGuid: string,
    coverageStateVectorBase64: string,
  ): void;
  applyAwareness(path: string, frame: Uint8Array): void;
  markReady(path: string): void;
  markUnavailable(
    path: string,
    code: DocUnavailableCode,
    terminal: boolean,
    reason: string,
  ): void;
  /**
   * Ship whatever is queued for every held body, once the lane can carry it.
   * Called by the lanes on every open/reconnect edge.
   */
  flushPending(): void;
  /** Bodies with a live doc, for assertions and the budget's resident count. */
  materializedPaths(): readonly string[];
  /** Bytes charged for one path, for the budget's protected-bytes report. */
  chargedBytes(path: string): number;
  dispose(): void;
}

/** The unavailable code as the wire's identity-file vocabulary spells it. */
function availabilityCodeOf(
  code: DocUnavailableCode,
): Extract<IdentityFileBodyAvailability, { kind: "unavailable" }>["code"] {
  switch (code) {
    case "stale-authority-epoch":
      return "stale-authority-epoch";
    case "file-not-found":
    case "artifact-not-found":
      return "file-not-found";
    case "not-a-fragment":
      return "not-a-fragment";
    case "body-unavailable":
      return "body-unavailable";
  }
}

export function identityBodyHolderId(
  hostId: string,
  identityId: string,
  runtimeToken: string,
  path: string,
): BudgetHolderId {
  return sessionKeyOf([hostId, identityId, runtimeToken, path]);
}

export function createIdentityBodyTier(
  sources: IdentityBodyTierSources,
): IdentityBodyTier {
  const {
    hostId,
    identityId,
    runtimeToken,
    send,
    canSendBodyWrites,
    onChanged,
    isDisposed,
    budget,
  } = sources;

  const entries = new Map<string, IdentityBodyEntry>();
  const leases = new Map<string, number>();
  /** Availability reported for a path that has no entry yet (unavailable before seed). */
  const unleasedAvailability = new Map<string, IdentityFileBodyAvailability>();
  const lastSettledBytes = new Map<string, number>();
  let disposed = false;

  function holderOf(path: string): BudgetHolderId {
    return identityBodyHolderId(hostId, identityId, runtimeToken, path);
  }

  function settleHot(path: string, entry: IdentityBodyEntry): void {
    const bytes = Y.encodeStateAsUpdate(entry.doc).byteLength;
    lastSettledBytes.set(path, bytes);
    entry.hotBytesSinceSettle = 0;
    budget?.settle(holderOf(path), bytes);
  }

  function noteGrowth(
    path: string,
    entry: IdentityBodyEntry,
    delta: number,
  ): void {
    entry.hotBytesSinceSettle += delta;
    if (entry.hotBytesSinceSettle > HOT_DOC_RESETTLE_BYTES) {
      settleHot(path, entry);
      return;
    }
    budget?.chargeProvisional(holderOf(path), delta);
  }

  function pushPending(entry: IdentityBodyEntry, update: Uint8Array): void {
    entry.pendingUpdates.push(update);
    entry.pendingBytesSinceCollapse += update.byteLength;
    if (entry.pendingUpdates.length < 2) return;
    if (
      entry.pendingBytesSinceCollapse <= PENDING_COLLAPSE_BYTES &&
      entry.pendingUpdates.length <= PENDING_COLLAPSE_ENTRIES
    ) {
      return;
    }
    const merged = Y.mergeUpdates(entry.pendingUpdates);
    entry.pendingUpdates.length = 0;
    entry.pendingUpdates.push(merged);
    entry.pendingBytesSinceCollapse = 0;
  }

  /**
   * `true` only when the lane took the bytes. `queued` from the lanes means
   * "no lane or not seeded yet" and `dropped` means the lane refused; for a
   * body edit both mean the same thing to this tier - retain the bytes, which
   * every caller does on `false`. Losing a user's edit is not an option.
   */
  function trySendUpdate(path: string, update: Uint8Array): boolean {
    if (!canSendBodyWrites()) return false;
    return send({ kind: "update", path, update }).kind === "sent";
  }

  function createEntry(path: string): IdentityBodyEntry {
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    const docUpdateHandler = (update: Uint8Array, origin: unknown): void => {
      // Host-originated applies must not be echoed; locally-originated edits
      // become outbound `applyUpdate` frames.
      if (origin === BIN_STREAM_ORIGIN) return;
      const entry = entries.get(path);
      if (entry === undefined) return;
      entry.dirtyWatermarkStateVectorBase64 = encodeDocStateVectorBase64(doc);
      // Measured BEFORE the send: a transferring consumer may detach the view.
      const updateBytes = update.byteLength;
      // COPIED, because Yjs hands the same array to every observer.
      const outbound = update.slice();
      if (!trySendUpdate(path, outbound)) pushPending(entry, update);
      noteGrowth(path, entry, updateBytes);
      onChanged(path);
    };
    const awarenessUpdateHandler = (
      changes: { added: number[]; updated: number[]; removed: number[] },
      origin: unknown,
    ): void => {
      if (origin === BIN_AWARENESS_REMOTE_ORIGIN) return;
      if (!canSendBodyWrites()) return;
      const touched = changes.added
        .concat(changes.updated)
        .concat(changes.removed);
      if (touched.length === 0) return;
      send({
        kind: "awareness",
        path,
        frame: encodeAwarenessUpdate(awareness, touched),
      });
    };
    doc.on("update", docUpdateHandler);
    awareness.on("update", awarenessUpdateHandler);
    const carried = unleasedAvailability.get(path);
    unleasedAvailability.delete(path);
    const entry: IdentityBodyEntry = {
      doc,
      awareness,
      docUpdateHandler,
      awarenessUpdateHandler,
      docGuid: null,
      pendingUpdates: [],
      pendingBytesSinceCollapse: 0,
      dirtyWatermarkStateVectorBase64: null,
      latestHostStateVectorBase64: null,
      hotBytesSinceSettle: 0,
      availability: carried ?? AWAITING_SEED_AVAILABILITY,
    };
    entries.set(path, entry);
    return entry;
  }

  function destroyEntry(path: string): void {
    const entry = entries.get(path);
    if (entry === undefined) return;
    entry.doc.off("update", entry.docUpdateHandler);
    entry.awareness.off("update", entry.awarenessUpdateHandler);
    entry.awareness.destroy();
    entry.doc.destroy();
    entries.delete(path);
    lastSettledBytes.delete(path);
    budget?.release(holderOf(path));
  }

  /**
   * Whether an INCREMENTAL frame describes a document this path no longer is.
   * A delayed frame from the generation a reseed superseded; applying it would
   * splice two histories that share no ancestor. Dropped, never merged.
   */
  function namesASupersededDoc(
    entry: IdentityBodyEntry,
    guid: string,
  ): boolean {
    return entry.docGuid !== null && entry.docGuid !== guid;
  }

  /**
   * Ship the local replica's divergence from a just-applied host snapshot, or
   * retain it for a later flush. Copied from the epic tier's
   * `reconcileAfterSnapshot`: with no watermark the reconcile is the WHOLE
   * replica (idempotent in Yjs, and the fail-closed direction).
   */
  function reconcileAfterSnapshot(
    path: string,
    entry: IdentityBodyEntry,
  ): void {
    const host = entry.latestHostStateVectorBase64;
    const reconcile =
      host === null
        ? Y.encodeStateAsUpdate(entry.doc)
        : Y.encodeStateAsUpdate(entry.doc, decodeBase64(host));
    if (!isNonTrivialYUpdate(reconcile)) {
      entry.pendingUpdates.length = 0;
      entry.pendingBytesSinceCollapse = 0;
      return;
    }
    // The merged replica subsumes every queued frame: retain ONE reconcile in
    // place of the queue, and ship it if the lane will take it.
    entry.pendingUpdates.length = 0;
    entry.pendingBytesSinceCollapse = 0;
    if (!trySendUpdate(path, reconcile)) {
      entry.pendingUpdates.push(reconcile);
      entry.pendingBytesSinceCollapse = 0;
    }
  }

  /**
   * A body nobody leases any more whose retained edits have all gone out has
   * nothing left to protect: drop it, and say so, so the store can give up the
   * lane it kept open for the flush.
   *
   * Two callers, and which one fires depends on what the disconnect did to
   * the body lane. In production one transport carries both lanes, so a drop
   * closes the body lane too; on reconnect the lane re-dials, the host
   * reseeds, and the retained bytes ride the reconcile in `applySnapshot` -
   * that is the call below it. `flushPending`'s call is the other branch: the
   * index lane reported open while the body lane's client was still up, so
   * the queue ships as-is. The store's fake-transport tests exercise THAT
   * branch (their file clients outlive an index-lane close); the reseed
   * branch is covered only by reading.
   */
  function dropIfUnleasedAndFlushed(path: string): void {
    const entry = entries.get(path);
    if (entry === undefined) return;
    if (leases.has(path)) return;
    if (entry.pendingUpdates.length > 0) return;
    destroyEntry(path);
    onChanged(path);
  }

  function recomputeDirty(entry: IdentityBodyEntry): void {
    if (
      latestHostCoversDirtyWatermark(
        entry.latestHostStateVectorBase64,
        entry.dirtyWatermarkStateVectorBase64,
      )
    ) {
      entry.dirtyWatermarkStateVectorBase64 = null;
    }
  }

  return {
    acquire(path): void {
      if (disposed || isDisposed()) return;
      leases.set(path, (leases.get(path) ?? 0) + 1);
      if (!entries.has(path)) createEntry(path);
    },

    release(path): void {
      const held = leases.get(path);
      if (held === undefined) return;
      if (held > 1) {
        leases.set(path, held - 1);
        return;
      }
      leases.delete(path);
      const entry = entries.get(path);
      // A body with unsent local bytes stays until they go out: destroying it
      // would encode away the only copy of a user's edit. `flushPending` on
      // the next open edge ships them and the body is then dropped lazily by
      // the next release, or by dispose.
      if (entry !== undefined && entry.pendingUpdates.length > 0) return;
      destroyEntry(path);
      onChanged(path);
    },

    doc(path): Y.Doc | null {
      const entry = entries.get(path);
      if (entry === undefined || entry.docGuid === null) return null;
      return entry.doc;
    },

    awareness(path): Awareness | null {
      return entries.get(path)?.awareness ?? null;
    },

    availability(path): IdentityFileBodyAvailability {
      const entry = entries.get(path);
      if (entry !== undefined) return entry.availability;
      return unleasedAvailability.get(path) ?? AWAITING_SEED_AVAILABILITY;
    },

    isDirty(path): boolean {
      const entry = entries.get(path);
      if (entry === undefined) return false;
      return (
        entry.dirtyWatermarkStateVectorBase64 !== null ||
        entry.pendingUpdates.length > 0
      );
    },

    hasPendingBytes(path): boolean {
      const entry = entries.get(path);
      return entry !== undefined && entry.pendingUpdates.length > 0;
    },

    seedOffer(path): AgentIdentityFileSeedOffer | null {
      const entry = entries.get(path);
      if (entry === undefined || entry.docGuid === null) return null;
      return {
        knownDocGuid: entry.docGuid,
        stateVectorBase64: encodeDocStateVectorBase64(entry.doc),
      };
    },

    applySnapshot(input): void {
      let entry = entries.get(input.path);
      // A seed for a body nobody leases any more: nothing to install into,
      // and materializing one on the host's say-so would strand a live doc.
      if (entry === undefined) return;
      if (namesASupersededDoc(entry, input.docGuid)) {
        // A DIFFERENT document at this path (deleted and recreated): what is
        // held is no longer a valid basis, and merging would splice two
        // histories. Rebuild under the same leases so a mounted editor rebinds
        // to the fresh doc. A full seed of the SAME guid falls through: Yjs
        // applies it idempotently over what is held, and rebuilding there
        // would throw away unsent local edits.
        const availability = entry.availability;
        destroyEntry(input.path);
        entry = createEntry(input.path);
        entry.availability = availability;
      }
      entry.docGuid = input.docGuid;
      Y.applyUpdate(entry.doc, input.update, BIN_STREAM_ORIGIN);
      if (input.hostStateVectorBase64 !== null) {
        entry.latestHostStateVectorBase64 = input.hostStateVectorBase64;
      }
      recomputeDirty(entry);
      reconcileAfterSnapshot(input.path, entry);
      entry.availability = READY_AVAILABILITY;
      settleHot(input.path, entry);
      onChanged(input.path);
      // The reconcile above may have been the flush a released body was
      // waiting for (see `release`).
      dropIfUnleasedAndFlushed(input.path);
    },

    applyUpdate(path, docGuid, update): void {
      const entry = entries.get(path);
      if (entry === undefined) return;
      if (namesASupersededDoc(entry, docGuid)) return;
      if (entry.docGuid === null) return;
      Y.applyUpdate(entry.doc, update, BIN_STREAM_ORIGIN);
      noteGrowth(path, entry, update.byteLength);
      onChanged(path);
    },

    applyCoverage(path, docGuid, coverageStateVectorBase64): void {
      const entry = entries.get(path);
      if (entry === undefined) return;
      if (namesASupersededDoc(entry, docGuid)) return;
      entry.latestHostStateVectorBase64 = coverageStateVectorBase64;
      const wasDirty = entry.dirtyWatermarkStateVectorBase64 !== null;
      recomputeDirty(entry);
      if (wasDirty && entry.dirtyWatermarkStateVectorBase64 === null) {
        onChanged(path);
      }
    },

    applyAwareness(path, frame): void {
      const entry = entries.get(path);
      if (entry === undefined) return;
      applyAwarenessUpdate(entry.awareness, frame, BIN_AWARENESS_REMOTE_ORIGIN);
    },

    markReady(path): void {
      const entry = entries.get(path);
      if (entry === undefined) {
        unleasedAvailability.delete(path);
        return;
      }
      // Ready with no seed yet is still "awaiting seed" to the surface; the
      // snapshot flips it. What `ready` DOES clear is a prior retrying/unavailable
      // mark, so a recovered body stops showing the banner.
      if (entry.availability.kind !== "ready") {
        entry.availability =
          entry.docGuid === null
            ? AWAITING_SEED_AVAILABILITY
            : READY_AVAILABILITY;
        onChanged(path);
      }
    },

    markUnavailable(path, code, terminal, reason): void {
      const availability: IdentityFileBodyAvailability = terminal
        ? { kind: "unavailable", code: availabilityCodeOf(code), reason }
        : { kind: "retrying", reason };
      const entry = entries.get(path);
      if (entry === undefined) {
        unleasedAvailability.set(path, availability);
        onChanged(path);
        return;
      }
      entry.availability = availability;
      onChanged(path);
    },

    flushPending(): void {
      if (!canSendBodyWrites()) return;
      for (const [path, entry] of entries) {
        if (entry.pendingUpdates.length === 0) continue;
        if (entry.docGuid === null) continue;
        const merged = Y.mergeUpdates(entry.pendingUpdates);
        if (!trySendUpdate(path, merged)) continue;
        entry.pendingUpdates.length = 0;
        entry.pendingBytesSinceCollapse = 0;
        // The lease may already be gone - see `release`.
        dropIfUnleasedAndFlushed(path);
      }
    },

    materializedPaths: () => Array.from(entries.keys()),

    chargedBytes(path): number {
      const entry = entries.get(path);
      return (
        (lastSettledBytes.get(path) ?? 0) + (entry?.hotBytesSinceSettle ?? 0)
      );
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const path of Array.from(entries.keys())) destroyEntry(path);
      leases.clear();
      unleasedAvailability.clear();
    },
  };
}
