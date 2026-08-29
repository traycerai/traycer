/**
 * The optimistic metadata overlay's retained state: what this client has
 * stamped, which plane each chain rides, and when a landed entry stops winning.
 *
 * Re-homed from the open-epic closure - three collections and eight closures.
 * The pure applier (`pending-metadata-overlay.ts`) never moved; it was already
 * a projector INPUT with no store coupling. What moved is the mutable half that
 * lived beside a websocket, together with the timer that bounds it, which now
 * arrives through the injected environment instead of `window`.
 *
 * The map is the projector's INPUT, folded into the published slices at
 * projection time. Keeping it out of the published projection is what stops
 * every mutation costing two publishes - one for the pending map and one for
 * the projection it forces - with a frame between them where the row is
 * neither old nor new.
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
 * How long a LANDED metadata mutation may keep patching the display while its
 * own echo is still missing from the authoritative slices. One full
 * record-poll interval (20s, `HOST_METHOD_POLL_TABLE`) plus refetch slack:
 * past this, `authoritative === baseline` is more plausibly a peer's write
 * back to the old value than a stale slice, and the row wins.
 */
const LANDED_MUTATION_TTL_MS = 30_000;

export interface MetadataOverlaySources {
  readonly environment: RuntimeEnvironment;
  /**
   * Re-publish the projection so a change to the overlay is visible. The doc
   * has not moved, so this is a pure re-projection - the same call the
   * chat-record channel makes when new rows land. A no-op while nothing is
   * attached.
   */
  readonly republish: () => void;
  readonly isProjectorAttached: () => boolean;
  /**
   * Whether this open cycle has a fresh root snapshot. The dead sweep's gate
   * for doc-backed chains; see {@link MetadataOverlayStore.collectDead}.
   */
  readonly hasFreshRootSnapshotForOpenCycle: () => boolean;
  /**
   * Whether the record plane CURRENTLY serves `nodeId` to this viewer, using
   * the same owner selection the record tables' publish seams use. The raw
   * tables deliberately retain every identity's rows - a collaborator may hold
   * the SAME `chatId` - and a row the projector never served cannot be
   * provenance for a mutation the user made against the visible one. Testing
   * bare-id membership here shipped once and misclassified a doc-only legacy
   * chat as registry-backed off a collaborator's invisible same-id row.
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
  /**
   * Turn an ambiguous entry back into an ordinary pending overlay before the
   * user's explicit retry. Its existing timer may remain armed: while this
   * entry is unlanded the chain rule re-arms instead of expiring it.
   */
  markUnknownOutcomeRetrying(requestId: string): boolean;
  retire(requestId: string, outcome: "landed" | "failed"): boolean;
  /**
   * The AUTHORITATIVE value a new mutation should record as its baseline.
   *
   * The projection is OVERLAID - the projector folds the overlay in - so the
   * currently displayed value is not authoritative whenever something is
   * already in flight for this node. When a chain exists, its first element
   * already captured the authoritative value and the host has not moved (if it
   * had, that chain would have been dropped at projection time), so reusing
   * that baseline is both correct and the only reading available here. With no
   * chain, nothing is overlaid and the projected value IS authoritative.
   */
  baselineFor<Value extends PendingMetadataValue>(
    kind: PendingMetadataMutation["kind"],
    nodeId: string | null,
    projected: Value,
  ): Value;
  /** Record the last-stamped rename for a node. See {@link isLatestRenameStamp}. */
  recordRenameStamp(nodeId: string, requestId: string): void;
  /**
   * Whether `requestId` is the LAST-STAMPED rename for its node - the guard the
   * persisted canvas-tab snapshot writes on.
   *
   * Deliberately answered from a stamp TOMBSTONE rather than the live chain: a
   * successful rename's own echo can reach the replica before its RPC settles,
   * and the dead sweep then removes the chain as an off-anchor move - a
   * chain-membership answer would refuse the only persisted-tab write of a
   * rename that SUCCEEDED. The tombstone survives the sweep, so the only acks
   * it refuses are ones a newer stamp genuinely superseded.
   */
  isLatestRenameStamp(nodeId: string, requestId: string): boolean;
  /** The projector's `onDeadMutations` sink. */
  collectDead(outcomes: readonly DeadPendingMutation[]): void;
  /**
   * Drop landed entries when the transport detaches but the replica is
   * retained. Their sweep runs inside full projections, and a detached
   * projector never projects again, so a landed stamp would sit in the map for
   * the life of the retained handle waiting for an echo the closed stream
   * cannot deliver. Un-landed entries stay - their RPC promise still owns a
   * terminal retire.
   */
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

  /**
   * Metadata mutations stamped by this client and not yet answered, keyed by
   * client request id.
   *
   * A `Map` because order is semantic: two renames of one row must apply in
   * the order the user made them.
   */
  const pending = new Map<string, PendingMetadataMutation>();
  /** Ambiguous sends temporarily use the landed chain's echo/TTL machinery. */
  const unknownOutcomeRequestIds = new Set<string>();
  /** One active landed/ambiguous expiry per request id. */
  const landedExpiryByRequestId = new Map<string, RuntimeTimer>();

  /**
   * The last-stamped rename request per node, SURVIVING the chain: the dead
   * sweep deletes a chain whose row moved off-anchor, and a successful
   * rename's own echo arriving before its RPC settles is exactly such a move.
   * The persisted-tab snapshot guard has to tell "an older rename of ours
   * acked after a newer one" (skip the write) from "our only rename's echo
   * beat its ack" (write) - chain membership cannot, because the chain is gone
   * in both. Entries are overwritten per node and cleared at dispose; request
   * ids are never reused, so a stale tombstone can only ever refuse a write,
   * never misattribute one.
   */
  const latestRenameStampByNode = new Map<string, string>();

  /**
   * Mutations OBSERVED to target a record-plane row, by client request id.
   *
   * Membership is decided by {@link markRegistryBacked} while the evidence
   * exists - a record row for the node that the OWNER SELECTION would actually
   * serve to this viewer - and is STICKY: a registry row disappearing is itself
   * a record-plane judgment (that plane keeps moving through a root reconnect),
   * so it must not downgrade the chain back to doc authority at exactly the
   * moment the dead sweep needs to honor the disappearance.
   *
   * The fact is CHAIN-WIDE and stored chain-wide: one marked member marks every
   * current sibling AND every sibling stamped later (the marking pass
   * propagates), so a mutation begun after the record row disappeared - against
   * the doc fallback the union still serves - carries its chain's provenance
   * itself rather than borrowing it from an older sibling that a
   * partially-processed dead batch might already have deleted. Request ids are
   * never reused, so an id left behind by a deleted entry can never mislabel a
   * future chain - the deletes at the map's removal sites are hygiene, not
   * correctness.
   */
  const registryBackedRequestIds = new Set<string>();

  const chainKeyOf = (kind: string, nodeId: string): string =>
    `${kind}\u001f${nodeId}`;

  /**
   * Capture record-plane provenance for every retained mutation whose CHAIN
   * the record plane serves to this viewer. Runs at stamp time and from both
   * record publish seams - the ONE writer each raw table has - so a row already
   * present at begin and a row arriving mid-flight both mark the chain while
   * the row is still there to prove it.
   *
   * Two passes because the fact is chain-wide: a chain counts as
   * registry-backed if ANY member is already marked (stickiness surviving the
   * row's disappearance) or the node currently has a visible record row, and
   * then EVERY member is marked - including one stamped after the row
   * disappeared, which inherits the chain's provenance here at its own stamp.
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

  /**
   * Whether a mutation's CHAIN is served by the RECORD plane. Registry rows
   * live in the record tables - state fed by the poll and delta channels, never
   * cleared by a root reconnect - so their authority does not ride the root doc
   * snapshot the way artifact rows and the epic title do. The dead sweep's
   * snapshot gate reads this to decide which plane's judgment it may trust
   * while the replacement doc is still unseeded.
   *
   * Chain-level, not entry-level: the sweep reports whole chains, and one
   * member observed against a record row is provenance for all of them - a
   * split verdict would delete half a chain and hand `resolvePendingChain` a
   * remainder whose baseline no longer means anything.
   */
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
   * Arm (or re-arm) the bounded landed-entry expiry. See the landed arm of
   * {@link retire} for why landed entries expire at all; the CHAIN-SCOPED half
   * lives here, in two rules.
   *
   * While any member of the entry's chain is still un-settled, the timer
   * re-arms: an INTERIOR landed entry is a causal anchor for every later
   * pending member (`resolvePendingChain` anchors a pending chain on baseline
   * plus every landed target), so expiring it would strip the anchor set and
   * the next projection would read the landed value's own echo as off-anchor
   * supersession - terminally killing a chain whose RPC is alive and retryable.
   *
   * Once the whole chain is landed, expiry is owned by the chain's TAIL - the
   * last-STAMPED member, whose target is what the all-landed chain displays -
   * and the tail deletes the ENTIRE chain atomically. Per-entry deletion is
   * wrong here: ACKs settle out of order, so a later-stamped member's timer can
   * fire before an earlier one's, and deleting just that member would re-expose
   * the previous landed target - the display walking BACKWARD through the
   * chain's history as timers fire. A non-tail timer re-arms instead; if the
   * tail is ever retired away (a failed RPC), the next re-armed timer to find
   * itself the tail takes over, at most one TTL later. A sibling's failure or
   * landing never needs to reschedule anything for the same reason.
   */
  function scheduleLandedExpiry(requestId: string): RuntimeTimer {
    landedExpiryByRequestId.get(requestId)?.cancel();
    let timer: RuntimeTimer;
    timer = environment.scheduler.schedule(LANDED_MUTATION_TTL_MS, () => {
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
      const isTail = chainRequestIds[chainRequestIds.length - 1] === requestId;
      if (chainHasUnsettled || !isTail) {
        scheduleLandedExpiry(requestId);
        return;
      }
      for (const id of chainRequestIds) {
        landedExpiryByRequestId.get(id)?.cancel();
        landedExpiryByRequestId.delete(id);
        onReconciled(id, "superseded", "landed-overlay-ttl");
        // Reconciliation may synchronously resolve the queue, whose terminal
        // callback calls `retire` and arms a fresh timer before control returns
        // here. This sweep is already deleting the entry, so cancel that
        // re-entrant timer too.
        landedExpiryByRequestId.get(id)?.cancel();
        landedExpiryByRequestId.delete(id);
        pending.delete(id);
        registryBackedRequestIds.delete(id);
        unknownOutcomeRequestIds.delete(id);
      }
      republish();
    });
    landedExpiryByRequestId.set(requestId, timer);
    return timer;
  }

  return {
    overlay: () => pending,

    markRegistryBacked,

    stamp(mutation) {
      pending.set(mutation.requestId, mutation);
      // Provenance is captured while the record row exists - a node the record
      // plane serves right now marks its chain registry-backed for the dead
      // sweep's plane-aware gate, stickily.
      markRegistryBacked();
      republish();
      return mutation.requestId;
    },

    markUnknownOutcome(requestId) {
      const entry = pending.get(requestId);
      if (entry === undefined || entry.landed) return false;
      // This is NOT an ACK. The target becomes a provisional causal anchor so
      // an authoritative value equal to it can close the ambiguous command,
      // while the same retained 30s bound prevents a stale overlay from
      // outranking the row indefinitely when no echo arrives.
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
     * `"failed"` is the simple half: the patch is layered over the
     * authoritative value, so deleting the entry reveals whatever the host
     * actually has. Nothing is written back - see the module doc on
     * `pending-metadata-overlay.ts`, and do not reintroduce a restore path.
     * Only TERMINAL failures; a retryable transport error must leave the row
     * pending, or the title flaps for the length of the retry.
     *
     * `"landed"` does NOT delete: the ack is causal proof the host holds this
     * value, which the row-wins rule needs to tell our own echo from a peer's
     * write, and which keeps the display honest while the record slice is still
     * stale (deleting here would snap a successful rename back to the old title
     * until the refetch landed). The projection's dead sweep forgets the entry
     * once the row catches up or a peer overwrites it.
     */
    retire(requestId, outcome) {
      const entry = pending.get(requestId);
      if (entry === undefined) return false;
      unknownOutcomeRequestIds.delete(requestId);
      // A landed outcome is only worth KEEPING while the projector can still
      // observe the echo that sweeps it. Detached (a retained buffer), the
      // display is frozen and no projection will ever run again - a kept entry
      // would just sit in the map for the handle's life, so delete on both
      // outcomes there.
      if (outcome === "failed" || !isProjectorAttached()) {
        landedExpiryByRequestId.get(requestId)?.cancel();
        landedExpiryByRequestId.delete(requestId);
        pending.delete(requestId);
        registryBackedRequestIds.delete(requestId);
      } else {
        pending.set(requestId, { ...entry, landed: true });
        // The bounded half of the landed contract. The ack proves the host HELD
        // this value, but value equality is the only reconciliation the sweep
        // has, and it cannot tell "the slice has not caught up to our write
        // yet" from "a peer moved the row BACK to the baseline value after our
        // write" - both read as authoritative === baseline. Unbounded, the
        // wrong guess hides the peer's write for the rest of the session. So a
        // landed entry outranks a baseline-valued row only while our own echo
        // could still plausibly be in flight - one full record-poll interval
        // (20s) plus refetch slack - and past that the row wins. If the slice
        // was merely stale (a run of failed polls), the brief regression is
        // honest and the next successful poll re-serves our value anyway.
        // Expiry is CHAIN-SCOPED (see `scheduleLandedExpiry`).
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
     * The dead sweep: a full projection proved these chains finished (row
     * caught up to the acked value, or a peer overwrote it). Deletion only - NO
     * republish - a dead chain already displays the authoritative value, and a
     * republish here would recurse into the projection that reported it.
     *
     * Gated on the open cycle's root snapshot, because a projection can run
     * against a replica that holds no authority yet: a fresh-snapshot request
     * swaps in a brand-new EMPTY `Y.Doc` and the projector full-projects it
     * before the replacement snapshot lands, and record ingests can force full
     * projections inside that same window. Against that state every doc-backed
     * row reads as deleted and the epic title as "", so honoring the report
     * would terminally retire chains whose RPCs are alive and retryable. While
     * the flag is down the report is ignored; the snapshot's own full
     * projection re-runs the sweep against real state the moment it lands, and
     * the landed-entry TTL bounds the map meanwhile.
     *
     * The gate is PLANE-AWARE: it protects only chains whose authority rides
     * the doc (artifact rows, the epic title, a doc-only legacy chat). A
     * registry-backed chat or terminal agent is judged against record rows the
     * reconnect never touched, and its record plane keeps moving through the
     * window - suppressing ITS death lets a supersession verdict (row moved
     * off-anchor) sit retained until a later record revisits the chain's
     * baseline value, where the stale intent would resurrect. A deadness
     * computed entirely from live registry state is honored regardless of the
     * flag. Which plane a chain rides is the STICKY, owner-selected provenance
     * above, not a bare-id scan of the raw tables.
     *
     * Classification runs to completion BEFORE any deletion: the plane lookup
     * is chain-level, so deleting one member (and its provenance mark)
     * mid-batch would change a later sibling's verdict - honoring half a chain
     * and suppressing the rest, leaving a remainder whose baseline no longer
     * means anything.
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
