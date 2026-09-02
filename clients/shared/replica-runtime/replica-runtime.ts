/**
 * The composition root: the object the extraction cuts the 3,600-line closure
 * into.
 *
 * Today the same function body owns the replica state, the transport, the
 * projection writes, the leases, the record tables and the UI signals, with the
 * ordering invariants between them recorded in comments rather than in types.
 * This interface is the shape those `let`s move into - one owner per concern,
 * with the sequencing that used to be implicit made into method calls.
 *
 * It is deliberately thin. It does not project, decode, or evict; it holds the
 * pieces that do and orders them. Anything richer here would recreate the
 * closure with a different indentation.
 */
import type {
  AdapterDetachReason,
  AdapterSelection,
  LaneAdapter,
} from "./adapter";
import type { FreshnessReport } from "./freshness";
import type { MemoryAccountant } from "./memory-accountant";
import type { PlaneId, Replica, ReplicaResetCause } from "./replica";
import type { RuntimeEnvironment } from "./runtime-environment";

/**
 * A replica plus the adapters feeding it, registered as one unit.
 *
 * Paired at registration because their lifetimes are coupled in one direction
 * only: replacing the replica retires its adapters, but detaching an adapter
 * leaves the replica standing. That asymmetry is `detachTransport()` - keep the
 * replica, drop the socket - and it has to be expressible or a host re-point
 * destroys unsynced state.
 */
export interface PlaneRegistration<TEvent, TProjection> {
  readonly planeId: PlaneId;
  readonly replica: Replica<TEvent, TProjection>;
  readonly adapters: readonly LaneAdapter<TEvent>[];
}

export interface ReplicaRuntime {
  readonly environment: RuntimeEnvironment;
  readonly accountant: MemoryAccountant;

  /**
   * Add a plane. Its adapters are attached immediately unless the runtime's
   * transport is currently detached, in which case they attach on the next
   * {@link attachTransport}.
   */
  registerPlane<TEvent, TProjection>(
    registration: PlaneRegistration<TEvent, TProjection>,
  ): void;

  /**
   * Install the adapter set a connection's negotiated manifest selected.
   *
   * A selection whose fingerprint differs from the installed one is a REPLICA
   * REPLACEMENT, not a reconfiguration: every affected plane is reset with
   * `"manifest-changed"` and reseeded through the new adapters. Silently
   * swapping adapters under a live replica would splice a legacy whole-epic
   * snapshot into a lane-fed one.
   */
  attachTransport(selection: AdapterSelection): void;

  /**
   * Detach every adapter while keeping every replica.
   *
   * The retained-dirty-buffer path: a session preserved across a host re-point
   * must stop dialling - a retained handle that keeps its stream client reports
   * dial evidence for a host this window has left, straight into the host
   * selection authority's death detection - while its unsynced edits stay
   * addressable.
   */
  detachTransport(reason: AdapterDetachReason): void;

  /**
   * Reset one plane. Used for a targeted degrade (resume-too-old on one lane)
   * that must not disturb its siblings, and for a locally requested reseed of a
   * single plane.
   *
   * Takes the provenance-carrying cause rather than an authority reason,
   * because this is the route a client-initiated fresh-snapshot request travels
   * - a recovery affordance reaches a replica through the runtime, not around
   * it.
   */
  replacePlane(planeId: PlaneId, cause: ReplicaResetCause): void;

  /**
   * Reset every plane as one unit.
   *
   * Migration is the case this exists for: the state lane holds its snapshot,
   * the control lane reports progress, and both resume from the post-migration
   * epoch. Sequencing it here rather than letting each plane react
   * independently is what stops one lane resuming into the old epoch while its
   * sibling is still migrating.
   */
  replaceAll(cause: ReplicaResetCause): void;

  /**
   * Per-class freshness, never collapsed into one verdict. See `freshness.ts`
   * for why an aggregate boolean is forbidden.
   */
  freshness(): FreshnessReport;

  /** Terminal. Detaches transport, disposes every plane, releases every budget. */
  dispose(): void;
}
