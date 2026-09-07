/** The composition root: the object the extraction cuts the 3,600-line closure into. */
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
 * That asymmetry is `detachTransport()` - keep the replica, drop the socket - and it has to be expressible or a host re-point destroys unsynced state.
 */
export interface PlaneRegistration<TEvent, TProjection> {
  readonly planeId: PlaneId;
  readonly replica: Replica<TEvent, TProjection>;
  readonly adapters: readonly LaneAdapter<TEvent>[];
}

export interface ReplicaRuntime {
  readonly environment: RuntimeEnvironment;
  readonly accountant: MemoryAccountant;

  /** Add a plane. */
  registerPlane<TEvent, TProjection>(
    registration: PlaneRegistration<TEvent, TProjection>,
  ): void;

  /**
   * Install the adapter set a connection's negotiated manifest selected.
   * A selection whose fingerprint differs from the installed one is a replica replacement, not a reconfiguration: every affected plane is reset with `"manifest-changed"` and reseeded through the new adapters.
   */
  attachTransport(selection: AdapterSelection): void;

  /** Detach every adapter while keeping every replica. */
  detachTransport(reason: AdapterDetachReason): void;

  /**
   * Reset one plane.
   * Used for a targeted degrade (resume-too-old on one lane) that must not disturb its siblings, and for a locally requested reseed of a single plane.
   */
  replacePlane(planeId: PlaneId, cause: ReplicaResetCause): void;

  /**
   * Reset every plane as one unit.
   * Sequencing it here rather than letting each plane react independently is what stops one lane resuming into the old epoch while its sibling is still migrating.
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
