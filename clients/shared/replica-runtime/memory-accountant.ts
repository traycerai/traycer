/**
 * A process-wide memory accountant. There is no such thing today, anywhere.
 *
 * What exists instead is a set of uncoordinated per-plane constants: 8 MiB per
 * chat transcript window multiplied by an unbounded number of leased sessions,
 * a hot artifact-room cap of 32, a live-epic cap of 5. Each is defensible on
 * its own and none of them knows the others exist, so the renderer's actual
 * ceiling is a product nobody computed.
 *
 * Two rules govern this interface, and both are lessons already paid for:
 *
 * 1. **Budgets are SOFT, with protected regions.** A hard ceiling reproduces
 *    the hydrate/evict/refetch livelock the chat plane discovered: the server
 *    always serves the first requested row whatever it costs, so a single
 *    visible row larger than the whole budget is a legal response. Evict it as
 *    "over budget" and its gap is still on screen, the planner re-requests it,
 *    and the client hydrates, evicts and refetches that one row forever while
 *    it never renders once. Protecting what the reader is looking at bounds the
 *    overage by one viewport and ends when they scroll away.
 * 2. **Reclaiming zero bytes is a legal, non-exceptional answer.** It means
 *    everything left is protected. The accountant must record it and stop -
 *    retrying is the livelock with an extra step.
 */
import type { RuntimeEnvironment } from "./runtime-environment";

/** Which budget a charge belongs to: `"epic-replicas"`, `"chat-windows"`, … */
export type BudgetPlaneId = string;

/**
 * What is being charged inside a plane - one transcript window, one
 * materialised doc, one replica's record tables.
 *
 * Charges are per holder rather than a single running total so eviction can be
 * targeted and so a leak is attributable. A plane with one aggregate number can
 * tell you it is over budget and nothing about why.
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
   *
   * The honest terminal state, and the one a caller must NOT respond to by
   * asking again. Surface it, telemeter it, and let the protection expire on
   * its own (the reader scrolls away, the lease is released, the required row
   * stops being required).
   */
  | "over-protected";

/**
 * Why a region cannot be evicted. Supplied by the plane, which is the only
 * component that knows; the accountant only needs to know that it exists so it
 * can report `"over-protected"` honestly rather than reporting a failure.
 */
export type ProtectedRegionKind =
  /** Where a live turn happens and where every snapshot re-seats content. */
  | "tail"
  /** On screen right now. */
  | "visible"
  /** Unconditionally re-planned, so evicting it re-requests it immediately. */
  | "required"
  /** Held by a lease - an editor is bound to it, by reference. */
  | "leased";

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

/**
 * Registered by each plane. The accountant calls it when the plane is over its
 * soft limit and asks for a specific number of bytes back.
 *
 * The plane decides WHAT to drop and applies its own protection rules - the
 * accountant never names a holder to evict, because "coldest" means something
 * different for a span-based transcript window than for an LRU of materialised
 * docs.
 *
 * Synchronous by contract. An async eviction hook would let a second budget
 * check run against state the first one is still mutating, which is how a
 * double eviction of the same span becomes possible.
 */
export type BudgetEvictionHook = (overBytes: number) => EvictionOutcome;

export interface PlaneBudgetSpec {
  readonly planeId: BudgetPlaneId;
  /**
   * SOFT. Crossing it triggers {@link evict}; it never causes a rejection, and
   * nothing in the runtime may refuse to hydrate because of it.
   */
  readonly softLimitBytes: number;
  /**
   * Fraction of {@link softLimitBytes} at which pressure becomes `"near"`.
   * Planes use it to stop growing eagerly (drop a prefetch, shrink a read-ahead)
   * before anything has to be thrown away.
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
  /** Bytes the plane has SETTLED - measured, authoritative. */
  readonly settledBytes: number;
  /**
   * Bytes charged provisionally and not yet settled.
   *
   * Deferred settling exists because measuring is expensive relative to
   * appending: a live turn appends continuously, and re-measuring per append
   * would dominate the cost of the append itself. The plane charges an estimate
   * and settles the real figure at a boundary. The consequence, which the
   * accountant must not paper over: a window carrying a turn's worth of
   * deferred growth reads as under budget until it settles, so anything that
   * makes an eviction decision settles FIRST.
   */
  readonly provisionalBytes: number;
  readonly holderCount: number;
  readonly pressure: BudgetPressure;
  /** Cumulative, for eviction-effectiveness telemetry. */
  readonly evictionsRequested: number;
  readonly bytesReclaimed: number;
  /** Times an eviction returned zero because everything left was protected. */
  readonly evictionsRefused: number;
}

/**
 * Point-in-time telemetry. The exit criteria for putting a plane under the
 * accountant are stated in these terms - docs resident, bytes decoded,
 * projection row counts, eviction effectiveness, per-plane budget pressure -
 * so the snapshot is part of the contract rather than a debugging afterthought.
 */
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
   * Record the measured size of a holder. REPLACES the holder's total - both
   * its provisional and its previous settled figure - rather than adding to it,
   * because the argument is the answer to "how big is this now", not "how much
   * did it grow".
   */
  settle(planeId: BudgetPlaneId, holderId: BudgetHolderId, bytes: number): void;

  /** Forget a holder entirely (it was evicted, demoted, or disposed). */
  release(planeId: BudgetPlaneId, holderId: BudgetHolderId): void;

  /**
   * Settle-then-check, running the plane's eviction hook if it is over.
   *
   * Explicit rather than automatic on every charge: a plane knows where its
   * consistent boundaries are, and evicting in the middle of applying a frame
   * can drop a span the rest of that frame is about to reference.
   */
  reconcile(planeId: BudgetPlaneId): BudgetPressure;

  pressure(planeId: BudgetPlaneId): BudgetPressure;

  snapshot(): AccountantSnapshot;
}

export interface MemoryAccountantOptions {
  readonly environment: RuntimeEnvironment;
  /**
   * Total across all planes, for telemetry and for a future global arbitration
   * pass. Deliberately NOT enforced here: the per-plane soft limits are what
   * govern, and a global hard ceiling would reintroduce the livelock at a level
   * where no plane can see which protection is blocking it.
   */
  readonly observedCeilingBytes: number;
}
