/**
 * A process-wide memory accountant.
 * Evict it as "over budget" and its gap is still on screen, the planner re-requests it, and the client hydrates, evicts and refetches that one row forever while it never renders once.
 */
import type { RuntimeEnvironment } from "./runtime-environment";

export type BudgetPlaneId = string;

/**
 * What is being charged inside a plane - one transcript window, one materialised doc, one replica's record tables.
 * Charges are per holder rather than a single running total so eviction can be targeted and so a leak is attributable.
 */
export type BudgetHolderId = string;

export type BudgetPressure =
  /** Comfortably inside the budget. */
  | "under"
  /** Inside, but close enough that the plane should stop growing eagerly. */
  | "near"
  /** Over, with evictable bytes remaining. */
  | "over"
  /**
   * Over, and everything left is protected.
   * The honest terminal state, and the one a caller must not respond to by asking again.
   */
  | "over-protected";

  /**
   * Why a region cannot be evicted.
   * Supplied by the plane, which is the only component that knows; the accountant only needs to know that it exists so it can report `"over-protected"` honestly rather than reporting a failure.
   */
export type ProtectedRegionKind =
  /** Where a live turn happens and where every snapshot re-seats content. */
  | "tail"
  /** On screen right now. */
  | "visible"
  /** Unconditionally re-planned, so evicting it re-requests it immediately. */
  | "required"
  /** Held by a lease - an editor is bound to it, by reference. */
  | "leased"
  /**
   * The only copy.
   * The pre-windowed whole-transcript residency uses this: reclaiming it would drop the session's only messages/events.
   */
  | "sole-copy";

export interface ProtectedBytes {
  readonly kind: ProtectedRegionKind;
  readonly bytes: number;
}

export interface EvictionOutcome {
  readonly reclaimedBytes: number;
  /**
   * What is still charged and cannot be dropped, with why. Empty when the plane
   * simply had nothing more to give.
   */
  readonly protectedBytesByKind: readonly ProtectedBytes[];
}

export type BudgetEvictionHook = (overBytes: number) => EvictionOutcome;

export interface PlaneBudgetSpec {
  readonly planeId: BudgetPlaneId;
  /**
   * soft. Crossing it triggers {@link evict}; it never causes a rejection, and
   * nothing in the runtime may refuse to hydrate because of it.
   */
  readonly softLimitBytes: number;
  /**
   * Fraction of {@link softLimitBytes} at which pressure becomes `"near"`.
   * Planes use it to stop growing eagerly (drop a prefetch, shrink a read-ahead) before anything has to be thrown away.
   */
  readonly nearThresholdRatio: number;
  readonly evict: BudgetEvictionHook;
}

export interface BudgetRegistration {
  readonly planeId: BudgetPlaneId;
  /** Unregisters the plane and forgets every charge against it. */
  release(): void;
}

export interface PlaneUsage {
  readonly planeId: BudgetPlaneId;
  readonly softLimitBytes: number;
  /** Bytes the plane has settled - measured, authoritative. */
  readonly settledBytes: number;
  /**
   * Bytes charged provisionally and not yet settled.
   * The consequence, which the accountant must not paper over: a window carrying a turn's worth of deferred growth reads as under budget until it settles, so anything that makes an eviction decision settles first.
   */
  readonly provisionalBytes: number;
  readonly holderCount: number;
  readonly pressure: BudgetPressure;
  /** Cumulative, for eviction-effectiveness telemetry. */
  readonly evictionsRequested: number;
  readonly bytesReclaimed: number;
  /**
   * Times an eviction returned zero because everything left was protected and nothing was dispatched to free it later.
   */
  readonly evictionsRefused: number;
  /**
   * Times an eviction returned zero because the freeing was dispatched rather than declined - the plane's tier is off-thread and its settles arrive on their own schedule.
   * Mutually exclusive with {@link evictionsRefused}: one breach increments exactly one of the two, never both.
   */
  readonly evictionsDeferred: number;
  /**
   * Why the last reconcile could not reclaim more, empty when the plane is under its limit or simply had nothing more to give.
   */
  readonly protectedBytesByKind: readonly ProtectedBytes[];
}

export interface AccountantSnapshot {
  readonly takenAtMs: number;
  readonly planes: readonly PlaneUsage[];
  readonly totalChargedBytes: number;
}

export interface MemoryAccountant {
  register(spec: PlaneBudgetSpec): BudgetRegistration;

  /**
   * Charge an estimate. Cheap, called on the hot path, superseded by
   * {@link settle}.
   */
  chargeProvisional(
    planeId: BudgetPlaneId,
    holderId: BudgetHolderId,
    bytes: number,
  ): void;

  /**
   * Record the measured size of a holder.
   * Replaces the holder's total - both its provisional and its previous settled figure - rather than adding to it, because the argument is the answer to "how big is this now", not "how much did it grow".
   */
  settle(planeId: BudgetPlaneId, holderId: BudgetHolderId, bytes: number): void;

  /** Forget a holder entirely (it was evicted, demoted, or disposed). */
  release(planeId: BudgetPlaneId, holderId: BudgetHolderId): void;

  /** Settle-then-check; not automatic on every charge, because evicting mid-frame can drop a span the rest of that frame is about to reference. */
  /** Declare from inside a plane's `evict` that freeing was dispatched rather than declined. A member, not a field on `EvictionOutcome` (~30 construction sites). */
  noteEvictionDeferred(planeId: BudgetPlaneId): void;

  reconcile(planeId: BudgetPlaneId): BudgetPressure;

  pressure(planeId: BudgetPlaneId): BudgetPressure;

  snapshot(): AccountantSnapshot;
}

export interface MemoryAccountantOptions {
  readonly environment: RuntimeEnvironment;
  /** Total across all planes, for telemetry and for a future global arbitration pass. */
  readonly observedCeilingBytes: number;
}

/**
 * The three planes Phase 1 puts under the accountant.
 * `BudgetPlaneId` stays a plain string so a later plane (canvas, comm-graph) can register without a seam change; these constants are the names the known planes actually use.
 */
export const BUDGET_PLANE_IDS = {
  epicReplicas: "epic-replicas",
  chatWindows: "chat-windows",
  hotDocs: "hot-docs",
} as const;

export type KnownBudgetPlaneId =
  (typeof BUDGET_PLANE_IDS)[keyof typeof BUDGET_PLANE_IDS];

interface HolderCharge {
  settled: number;
  provisional: number;
}

interface PlaneState {
  readonly spec: PlaneBudgetSpec;
  readonly holders: Map<BudgetHolderId, HolderCharge>;
  evictionsRequested: number;
  bytesReclaimed: number;
  evictionsRefused: number;
  evictionsDeferred: number;
  /**
   * Set by {@link MemoryAccountant.noteEvictionDeferred} during the plane's own `evict` call, and consumed by the reconcile that made it.
   */
  deferredInFlight: boolean;
  /**
   * Set when a reconcile asked the plane to evict and the plane could not get back under the soft limit.
   */
  protectedLatch: boolean;
  /**
   * True while this plane's eviction hook is on the stack.
   * Process-wide: one session's publish must not re-enter `evict` through another session's settle.
   */
  reconciling: boolean;
  lastProtectedBytesByKind: readonly ProtectedBytes[];
}

function holderChargedBytes(holder: HolderCharge): number {
  return holder.settled + holder.provisional;
}

function planeChargedBytes(plane: PlaneState): number {
  let total = 0;
  for (const holder of plane.holders.values()) {
    total += holderChargedBytes(holder);
  }
  return total;
}

function pressureOf(plane: PlaneState): BudgetPressure {
  const charged = planeChargedBytes(plane);
  const near = plane.spec.softLimitBytes * plane.spec.nearThresholdRatio;
  if (charged <= near) return "under";
  if (charged <= plane.spec.softLimitBytes) return "near";
  if (plane.protectedLatch) return "over-protected";
  return "over";
}

function requireFiniteNonNegative(bytes: number, verb: string): void {
  if (!Number.isFinite(bytes) || bytes < 0) {
    throw new Error(
      `memory accountant: ${verb} bytes must be a finite non-negative number`,
    );
  }
}

function requireRegistered(
  planes: ReadonlyMap<BudgetPlaneId, PlaneState>,
  planeId: BudgetPlaneId,
): PlaneState {
  const plane = planes.get(planeId);
  if (plane === undefined) {
    throw new Error(
      `memory accountant: plane ${JSON.stringify(planeId)} is not registered`,
    );
  }
  return plane;
}

function usageOf(plane: PlaneState): PlaneUsage {
  return {
    planeId: plane.spec.planeId,
    softLimitBytes: plane.spec.softLimitBytes,
    settledBytes: [...plane.holders.values()].reduce(
      (sum, holder) => sum + holder.settled,
      0,
    ),
    provisionalBytes: [...plane.holders.values()].reduce(
      (sum, holder) => sum + holder.provisional,
      0,
    ),
    holderCount: plane.holders.size,
    pressure: pressureOf(plane),
    evictionsRequested: plane.evictionsRequested,
    bytesReclaimed: plane.bytesReclaimed,
    evictionsRefused: plane.evictionsRefused,
    evictionsDeferred: plane.evictionsDeferred,
    protectedBytesByKind: plane.lastProtectedBytesByKind,
  };
}

/**
 * Process-wide memory accountant.
 * Eviction is never automatic on charge: {@link MemoryAccountant.reconcile} is the settle-then-check boundary, and reclaiming nothing is a legal answer.
 */
export function createMemoryAccountant(
  options: MemoryAccountantOptions,
): MemoryAccountant {
  const { environment, observedCeilingBytes } = options;
  requireFiniteNonNegative(observedCeilingBytes, "observedCeiling");

  const planes = new Map<BudgetPlaneId, PlaneState>();

  const snapshot = (): AccountantSnapshot => {
    const usages = [...planes.values()].map(usageOf);
    return {
      takenAtMs: environment.clock.now(),
      planes: usages,
      totalChargedBytes: usages.reduce(
        (sum, usage) => sum + usage.settledBytes + usage.provisionalBytes,
        0,
      ),
    };
  };

  return {
    register(spec: PlaneBudgetSpec): BudgetRegistration {
      if (planes.has(spec.planeId)) {
        throw new Error(
          `memory accountant: plane ${JSON.stringify(spec.planeId)} is already registered`,
        );
      }
      requireFiniteNonNegative(spec.softLimitBytes, "softLimit");
      if (
        !Number.isFinite(spec.nearThresholdRatio) ||
        spec.nearThresholdRatio <= 0 ||
        spec.nearThresholdRatio > 1
      ) {
        throw new Error(
          "memory accountant: nearThresholdRatio must be in (0, 1]",
        );
      }
      planes.set(spec.planeId, {
        spec,
        holders: new Map(),
        evictionsRequested: 0,
        bytesReclaimed: 0,
        evictionsRefused: 0,
        evictionsDeferred: 0,
        deferredInFlight: false,
        protectedLatch: false,
        reconciling: false,
        lastProtectedBytesByKind: [],
      });
      return {
        planeId: spec.planeId,
        release(): void {
          planes.delete(spec.planeId);
        },
      };
    },

    chargeProvisional(
      planeId: BudgetPlaneId,
      holderId: BudgetHolderId,
      bytes: number,
    ): void {
      requireFiniteNonNegative(bytes, "chargeProvisional");
      const plane = requireRegistered(planes, planeId);
      const held = plane.holders.get(holderId);
      if (held === undefined) {
        plane.holders.set(holderId, { settled: 0, provisional: bytes });
      } else {
        held.provisional += bytes;
      }
      plane.protectedLatch = false;
    },

    settle(
      planeId: BudgetPlaneId,
      holderId: BudgetHolderId,
      bytes: number,
    ): void {
      requireFiniteNonNegative(bytes, "settle");
      const plane = requireRegistered(planes, planeId);
      plane.holders.set(holderId, { settled: bytes, provisional: 0 });
      plane.protectedLatch = false;
    },

    release(planeId: BudgetPlaneId, holderId: BudgetHolderId): void {
      const plane = planes.get(planeId);
      if (plane === undefined) return;
      plane.holders.delete(holderId);
      plane.protectedLatch = false;
    },

    noteEvictionDeferred(planeId: BudgetPlaneId): void {
      const plane = planes.get(planeId);
      if (plane === undefined) return;
      plane.deferredInFlight = true;
    },

    reconcile(planeId: BudgetPlaneId): BudgetPressure {
      const plane = requireRegistered(planes, planeId);
      if (plane.reconciling) return pressureOf(plane);
      if (plane.protectedLatch) return "over-protected";
      const charged = planeChargedBytes(plane);
      if (charged <= plane.spec.softLimitBytes) {
        plane.lastProtectedBytesByKind = [];
        return pressureOf(plane);
      }

      plane.reconciling = true;
      try {
        plane.evictionsRequested += 1;
        // Reset immediately before the call whose duration is the flag's whole
        // life; a tier that dispatches sets it from inside `evict`.
        plane.deferredInFlight = false;
        const outcome = plane.spec.evict(charged - plane.spec.softLimitBytes);
        plane.bytesReclaimed += outcome.reclaimedBytes;
        plane.lastProtectedBytesByKind = outcome.protectedBytesByKind;
        const stillOver = planeChargedBytes(plane) > plane.spec.softLimitBytes;
        if (stillOver) {
          plane.protectedLatch = true;
          if (outcome.reclaimedBytes === 0) {
            // Exactly one of the two, never both: freeing that was dispatched is not freeing that was declined, and a telemetry reader cannot tell them apart after the fact.
            if (plane.deferredInFlight) plane.evictionsDeferred += 1;
            else plane.evictionsRefused += 1;
          }
        }
        return pressureOf(plane);
      } finally {
        plane.reconciling = false;
      }
    },

    pressure(planeId: BudgetPlaneId): BudgetPressure {
      return pressureOf(requireRegistered(planes, planeId));
    },

    snapshot,
  };
}
