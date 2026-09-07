/**
 * The optimistic metadata overlay's retained state: what this client has stamped, which plane each
 * chain rides, and when a landed entry stops winning.
 */
import type {
  RuntimeEnvironment,
  RuntimeTimer,
} from "@traycer-clients/shared/replica-runtime";
import type {
  DeadPendingMutation,
  PendingMetadataMutation,
  PendingMetadataOverlay,
  PendingMetadataValue,
} from "../pending-metadata-overlay";

/**
 * How long a LANDED metadata mutation may keep patching the display while its own echo is still
 * missing from the authoritative slices.
 */
const LANDED_MUTATION_TTL_MS = 30_000;

export interface MetadataOverlaySources {
  readonly environment: RuntimeEnvironment;
  /**
   * Re-publish the projection so a change to the overlay is visible. The doc has not moved, so this
   * is a pure re-projection - the same call the chat-record channel makes when new rows land.
   */
  readonly republish: () => void;
  readonly isProjectorAttached: () => boolean;
  /**
   * Whether this open cycle has a fresh root snapshot. The dead sweep's gate
   * for doc-backed chains; see {@link MetadataOverlayStore.collectDead}.
   */
  readonly hasFreshRootSnapshotForOpenCycle: () => boolean;
  /**
   * Whether the record plane CURRENTLY serves `nodeId` to this viewer, using the same owner
   * selection the record tables' publish seams use.
   */
  readonly recordPlaneServesNode: (nodeId: string) => boolean;
  readonly isDisposed: () => boolean;
  readonly onReconciled: (
    requestId: string,
    outcome: "echo" | "superseded",
    via: "authoritative-projection" | "landed-overlay-ttl",
  ) => void;
}

export interface MetadataOverlayStore {
  /** The map the projector folds in. Live reference, read at projection time. */
  overlay(): PendingMetadataOverlay;
  /** Capture provenance for every retained mutation the record plane backs. */
  markRegistryBacked(): void;
  /** Stamp a mutation, mark its chain's provenance, and republish. */
  stamp(mutation: PendingMetadataMutation): string;
  /** Keep an ambiguous post-send outcome until an echo or the bounded TTL. */
  markUnknownOutcome(requestId: string): boolean;
  /** Turn an ambiguous entry back into an ordinary pending overlay before the user's explicit retry. */
  markUnknownOutcomeRetrying(requestId: string): boolean;
  retire(requestId: string, outcome: "landed" | "failed"): boolean;
  /** The AUTHORITATIVE value a new mutation should record as its baseline. */
  baselineFor<Value extends PendingMetadataValue>(
    kind: PendingMetadataMutation["kind"],
    nodeId: string | null,
    projected: Value,
  ): Value;
  /** Record the last-stamped rename for a node. See {@link isLatestRenameStamp}. */
  recordRenameStamp(nodeId: string, requestId: string): void;
  /**
   * Whether `requestId` is the LAST-STAMPED rename for its node - the guard the persisted canvas-tab
   * snapshot writes on.
   */
  isLatestRenameStamp(nodeId: string, requestId: string): boolean;
  /** The projector's `onDeadMutations` sink. */
  collectDead(outcomes: readonly DeadPendingMutation[]): void;
  /** Drop landed entries when the transport detaches but the replica is retained. */
  dropLandedOnDetach(): void;
  clear(): void;
}

export function createMetadataOverlayStore(
  sources: MetadataOverlaySources,
): MetadataOverlayStore {
  const {
    environment,
    republish,
    isProjectorAttached,
    hasFreshRootSnapshotForOpenCycle,
    recordPlaneServesNode,
    isDisposed,
    onReconciled,
  } = sources;

  /** Metadata mutations stamped by this client and not yet answered, keyed by client request id. */
  const pending = new Map<string, PendingMetadataMutation>();
  /** Ambiguous sends temporarily use the landed chain's echo/TTL machinery. */
  const unknownOutcomeRequestIds = new Set<string>();
  /** One active landed/ambiguous expiry per request id. */
  const landedExpiryByRequestId = new Map<string, RuntimeTimer>();

  /**
   * The last-stamped rename request per node, SURVIVING the chain: the dead sweep deletes a chain
   * whose row moved off-anchor, and a successful rename's own echo arriving before its RPC settles
   */
  const latestRenameStampByNode = new Map<string, string>();

  /** Mutations OBSERVED to target a record-plane row, by client request id. */
  const registryBackedRequestIds = new Set<string>();

  const chainKeyOf = (kind: string, nodeId: string): string =>
    `${kind}\u001f${nodeId}`;

  /**
   * Capture record-plane provenance for every retained mutation whose CHAIN the record plane serves
   * to this viewer.
   */
  function markRegistryBacked(): void {
    if (pending.size === 0) return;
    const markedChains = new Set<string>();
    for (const mutation of pending.values()) {
      if (mutation.kind === "epic-title") continue;
      const key = chainKeyOf(mutation.kind, mutation.nodeId);
      if (markedChains.has(key)) continue;
      if (
        registryBackedRequestIds.has(mutation.requestId) ||
        recordPlaneServesNode(mutation.nodeId)
      ) {
        markedChains.add(key);
      }
    }
    if (markedChains.size === 0) return;
    for (const mutation of pending.values()) {
      if (mutation.kind === "epic-title") continue;
      if (markedChains.has(chainKeyOf(mutation.kind, mutation.nodeId))) {
        registryBackedRequestIds.add(mutation.requestId);
      }
    }
  }

  /** Whether a mutation's CHAIN is served by the RECORD plane. */
  function isRegistryBackedMutation(
    mutation: PendingMetadataMutation,
  ): boolean {
    if (mutation.kind === "epic-title") return false;
    for (const other of pending.values()) {
      if (other.kind !== mutation.kind) continue;
      if (other.nodeId !== mutation.nodeId) continue;
      if (registryBackedRequestIds.has(other.requestId)) return true;
    }
    return recordPlaneServesNode(mutation.nodeId);
  }

  /**
   * Arm (or re-arm) the bounded landed-entry expiry. See the landed arm of {@link retire} for why
   * landed entries expire at all; the CHAIN-SCOPED half lives here, in two rules.
   */
  function scheduleLandedExpiry(requestId: string): RuntimeTimer {
    landedExpiryByRequestId.get(requestId)?.cancel();
    const timer: RuntimeTimer = environment.scheduler.schedule(
      LANDED_MUTATION_TTL_MS,
      () => {
        if (landedExpiryByRequestId.get(requestId) !== timer) return;
        landedExpiryByRequestId.delete(requestId);
        if (isDisposed()) return;
        const entry = pending.get(requestId);
        if (entry === undefined) return;
        const nodeId = entry.kind === "epic-title" ? null : entry.nodeId;
        const chainRequestIds: string[] = [];
        let chainHasUnsettled = false;
        for (const [id, other] of pending) {
          if (other.kind !== entry.kind) continue;
          const otherId = other.kind === "epic-title" ? null : other.nodeId;
          if (otherId !== nodeId) continue;
          chainRequestIds.push(id);
          if (!other.landed) chainHasUnsettled = true;
        }
        const isTail =
          chainRequestIds[chainRequestIds.length - 1] === requestId;
        if (chainHasUnsettled || !isTail) {
          scheduleLandedExpiry(requestId);
          return;
        }
        for (const id of chainRequestIds) {
          landedExpiryByRequestId.get(id)?.cancel();
          landedExpiryByRequestId.delete(id);
          onReconciled(id, "superseded", "landed-overlay-ttl");
          // Reconciliation may synchronously resolve the queue, whose terminal callback calls `retire` and
          // arms a fresh timer before control returns here.
          landedExpiryByRequestId.get(id)?.cancel();
          landedExpiryByRequestId.delete(id);
          pending.delete(id);
          registryBackedRequestIds.delete(id);
          unknownOutcomeRequestIds.delete(id);
        }
        republish();
      },
    );
    landedExpiryByRequestId.set(requestId, timer);
    return timer;
  }

  return {
    overlay: () => pending,

    markRegistryBacked,

    stamp(mutation) {
      pending.set(mutation.requestId, mutation);
      // Provenance is captured while the record row exists - a node the record plane serves right now
      // marks its chain registry-backed for the dead sweep's plane-aware gate, stickily.
      markRegistryBacked();
      republish();
      return mutation.requestId;
    },

    markUnknownOutcome(requestId) {
      const entry = pending.get(requestId);
      if (entry === undefined || entry.landed) return false;
      // This is NOT an ACK.
      unknownOutcomeRequestIds.add(requestId);
      pending.set(requestId, { ...entry, landed: true });
      scheduleLandedExpiry(requestId);
      republish();
      return true;
    },

    markUnknownOutcomeRetrying(requestId) {
      const entry = pending.get(requestId);
      if (
        entry === undefined ||
        !entry.landed ||
        !unknownOutcomeRequestIds.delete(requestId)
      ) {
        return false;
      }
      landedExpiryByRequestId.get(requestId)?.cancel();
      landedExpiryByRequestId.delete(requestId);
      pending.set(requestId, { ...entry, landed: false });
      republish();
      return true;
    },

    /**
     * `"failed"` is the simple half: the patch is layered over the authoritative value, so deleting
     * the entry reveals whatever the host actually has.
     */
    retire(requestId, outcome) {
      const entry = pending.get(requestId);
      if (entry === undefined) return false;
      unknownOutcomeRequestIds.delete(requestId);
      // A landed outcome is only worth KEEPING while the projector can still observe the echo that
      // sweeps it.
      if (outcome === "failed" || !isProjectorAttached()) {
        landedExpiryByRequestId.get(requestId)?.cancel();
        landedExpiryByRequestId.delete(requestId);
        pending.delete(requestId);
        registryBackedRequestIds.delete(requestId);
      } else {
        pending.set(requestId, { ...entry, landed: true });
        // The bounded half of the landed contract.
        scheduleLandedExpiry(requestId);
      }
      republish();
      return true;
    },

    baselineFor<Value extends PendingMetadataValue>(
      kind: PendingMetadataMutation["kind"],
      nodeId: string | null,
      projected: Value,
    ): Value {
      for (const mutation of pending.values()) {
        if (mutation.kind !== kind) continue;
        const id = mutation.kind === "epic-title" ? null : mutation.nodeId;
        if (id !== nodeId) continue;
        return mutation.baseline as Value;
      }
      return projected;
    },

    recordRenameStamp(nodeId, requestId) {
      latestRenameStampByNode.set(nodeId, requestId);
    },

    isLatestRenameStamp: (nodeId, requestId) =>
      latestRenameStampByNode.get(nodeId) === requestId,

    /**
     * The dead sweep: a full projection proved these chains finished (row caught up to the acked
     * value, or a peer overwrote it).
     */
    collectDead(outcomes) {
      const honored: DeadPendingMutation[] = [];
      for (const outcome of outcomes) {
        const mutation = pending.get(outcome.requestId);
        if (mutation === undefined) continue;
        if (
          !hasFreshRootSnapshotForOpenCycle() &&
          !isRegistryBackedMutation(mutation)
        ) {
          continue;
        }
        honored.push(outcome);
      }
      for (const outcome of honored) {
        landedExpiryByRequestId.get(outcome.requestId)?.cancel();
        landedExpiryByRequestId.delete(outcome.requestId);
        onReconciled(
          outcome.requestId,
          outcome.outcome,
          "authoritative-projection",
        );
        // See the TTL sweep's matching post-callback cancellation above.
        landedExpiryByRequestId.get(outcome.requestId)?.cancel();
        landedExpiryByRequestId.delete(outcome.requestId);
        pending.delete(outcome.requestId);
        registryBackedRequestIds.delete(outcome.requestId);
        unknownOutcomeRequestIds.delete(outcome.requestId);
      }
    },

    dropLandedOnDetach() {
      for (const [requestId, entry] of pending) {
        if (entry.landed && !unknownOutcomeRequestIds.has(requestId)) {
          landedExpiryByRequestId.get(requestId)?.cancel();
          landedExpiryByRequestId.delete(requestId);
          pending.delete(requestId);
          registryBackedRequestIds.delete(requestId);
        }
      }
    },

    clear() {
      for (const timer of landedExpiryByRequestId.values()) timer.cancel();
      landedExpiryByRequestId.clear();
      pending.clear();
      registryBackedRequestIds.clear();
      unknownOutcomeRequestIds.clear();
      latestRenameStampByNode.clear();
    },
  };
}
