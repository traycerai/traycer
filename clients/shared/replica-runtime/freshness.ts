/**
 * How current each plane's data is, reported PER CLASS.
 *
 * The rule this file encodes: network affects freshness, never usability. A
 * client always renders from its replica, and the only thing a bad connection
 * changes is what the UI is allowed to CLAIM about what it is showing.
 *
 * The forbidden shape is one aggregate `synced: boolean`. It hides per-class
 * staleness (a live control lane with a three-minute-old record lane reads as
 * "synced") and it hides rejected writes, which is the one thing a green
 * indicator must never do. There is deliberately no function in this module
 * that folds a {@link FreshnessReport} into a single verdict; a surface that
 * wants one must state which classes it is asserting about.
 *
 * Aggregating WITHIN a class is fine and expected - the host folds per-room
 * dirtiness into one durability input, and that is one class's answer. The
 * prohibition is on blending classes.
 */
import type { LaneCursor } from "./lane-cursor";
import type { PlaneId, ReplicaDataClass } from "./replica";

/**
 * Whether the data behind a projection has been reconciled with the cloud, or
 * is only what this serving node already had.
 *
 * Seed-first serving is CONDITIONAL by nature: a node can only serve what it
 * has seen, so a first open on a host (fresh install, newly shared epic, new
 * device) has no seed and waits on the upstream sync. `"seed-only"` is
 * therefore a normal, common, renderable state - not an error - and it is what
 * gates privileged mutations and secret hydration, which must not run against
 * an unverified seed.
 */
export type SeedTrust = "seed-only" | "reconciled-with-cloud";

export type FreshnessStatus =
  /**
   * Nothing has been observed yet. Pre-snapshot silence means unknown, NEVER
   * clean and never stale - a UI that renders "unknown" as either is asserting
   * something no frame has said.
   */
  | "unknown"
  /** A live feed is attached and its watermark is advancing. */
  | "live"
  /** Last observation succeeded, but the feed is not currently attached. */
  | "stale"
  /**
   * The feed is attached but cannot serve normally - resume refused, permission
   * lost, migration in progress. Always accompanied by a
   * {@link ClassFreshness.degradedReason}.
   */
  | "degraded";

export interface ClassFreshness {
  readonly planeId: PlaneId;
  readonly dataClass: ReplicaDataClass;
  readonly status: FreshnessStatus;
  /** The highest cursor applied, or `null` before the first snapshot. */
  readonly watermark: LaneCursor | null;
  /** When the last frame was applied, read from the runtime's injected clock. */
  readonly observedAtMs: number | null;
  /**
   * `null` for classes with no seed concept (ephemera, and any plane fed by an
   * adapter that cannot distinguish the two). `null` is "not applicable", not
   * "assume reconciled" - a caller gating a privileged action must treat it the
   * same as `"seed-only"`.
   */
  readonly trust: SeedTrust | null;
  /** Non-null exactly when {@link status} is `"degraded"`. */
  readonly degradedReason: string | null;
}

/**
 * One entry per plane, never collapsed. Order is not significant; consumers key
 * by `planeId`.
 */
export type FreshnessReport = readonly ClassFreshness[];

/**
 * The starting value for a plane nothing has been observed for.
 *
 * A helper rather than a constant because `planeId` and `dataClass` vary, and
 * because getting the initial state wrong in the direction of "clean" is the
 * specific bug the `"unknown"` member exists to prevent.
 */
export function unknownFreshness(
  planeId: PlaneId,
  dataClass: ReplicaDataClass,
): ClassFreshness {
  return {
    planeId,
    dataClass,
    status: "unknown",
    watermark: null,
    observedAtMs: null,
    trust: null,
    degradedReason: null,
  };
}
