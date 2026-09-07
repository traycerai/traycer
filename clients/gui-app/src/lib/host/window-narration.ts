import type {
  HostLeaseSnapshot,
  SelectionIncompatibility,
} from "@traycer-clients/shared/host-selection/selection-authority-contract";
import type { ClientCompatibilityRequirement } from "@traycer/protocol/framework/index";
import {
  describeVersionSkew,
  type VersionSkewCopy,
} from "@/lib/host/version-skew-copy";

/**
 * Window-scope narrator: "nothing can serve this window" and "nothing has served it yet".
 * Pure function of authority inputs; everything else is narrated at the surface or tile.
 */

/**
 * `cold-start` exists because empty-fleet alone cannot drive it: `connecting` is usable, so first launch names a host.
 */
export type WindowNarrationCause = "no-usable-host" | "cold-start";

/**
 * `update-host` carries the lease's `SelectionIncompatibility` intact so the card can name versions.
 */
export type WindowNarrationVariant =
  | { readonly kind: "offline" }
  | { readonly kind: "plan-restricted" }
  | {
      readonly kind: "update-host";
      readonly hostId: string;
      /**
       * Required: `false` means not the machine whose lifecycle this window can act on.
       * Do not default; the two arms share a shape and a skipped field bound Update host to a remote.
       */
      readonly isTargetHost: boolean;
      readonly detail: SelectionIncompatibility;
    }
  | {
      /**
       * This app is the outdated leg; the host named the epoch. Distinct from `update-host` because every action is the opposite.
       */
      readonly kind: "update-client";
      readonly hostId: string;
      readonly isTargetHost: boolean;
      readonly requirement: ClientCompatibilityRequirement;
    };

export type WindowNarrationState =
  | { readonly kind: "silent" }
  | {
      readonly kind: "narrating";
      readonly cause: WindowNarrationCause;
      readonly variant: WindowNarrationVariant;
    };

export interface WindowNarrationInput {
  /**
   * Gate on every arm. `false` is the detached default; `true` with a null host is real empty.
   */
  readonly attached: boolean;
  readonly effectiveHostId: string | null;
  /** Preferred, or the local host when preferred is null (M5), or null. */
  readonly targetHostId: string | null;
  readonly leases: readonly HostLeaseSnapshot[];
  /**
   * Per-window latch: after one serve, later not-ready blips are the tile's story unless the fleet is empty.
   */
  readonly hasBeenServed: boolean;
  /**
   * Gates the pre-serve empty grace: a shell with no local lifecycle must not promise a boot it cannot do.
   */
  readonly localHostExpected: boolean;
  /**
   * This machine's host id. `localHostExpected` cannot stand in: it stays true on a desktop targeting a remote.
   */
  readonly localHostId: string | null;
}

/**
 * `degraded` counts as serving (the host answered). `connecting` and `restarting-expected` do not.
 */
export function isServingLease(lease: HostLeaseSnapshot | null): boolean {
  if (lease === null) return false;
  return lease.status === "ready" || lease.status === "degraded";
}

export function findLease(
  leases: readonly HostLeaseSnapshot[],
  hostId: string | null,
): HostLeaseSnapshot | null {
  if (hostId === null) return null;
  return leases.find((lease) => lease.hostId === hostId) ?? null;
}

/**
 * Empty lease list is `offline`, never `plan-restricted` (vacuous every-of-nothing).
 * Target incompatibility wins first; mixed fleet prefers a recoverable incompatible host over a plan-restricted target.
 */
export function deriveNoHostVariant(
  leases: readonly HostLeaseSnapshot[],
  targetHostId: string | null,
): WindowNarrationVariant {
  const target = findLease(leases, targetHostId);
  if (target !== null && target.dead?.reason === "incompatible") {
    return incompatibleVariant(target.hostId, target.dead.detail, true);
  }
  const allPlanRestricted =
    leases.length > 0 &&
    leases.every((lease) => lease.dead?.reason === "plan-restricted");
  if (allPlanRestricted) {
    return { kind: "plan-restricted" };
  }
  for (const lease of leases) {
    if (lease.dead?.reason === "incompatible") {
      return incompatibleVariant(lease.hostId, lease.dead.detail, false);
    }
  }
  return { kind: "offline" };
}

/**
 * Structured epoch requirement wins whenever the host supplied one.
 */
function incompatibleVariant(
  hostId: string,
  detail: SelectionIncompatibility,
  isTargetHost: boolean,
): WindowNarrationVariant {
  if (detail.clientCompatibility !== null) {
    return {
      kind: "update-client",
      hostId,
      isTargetHost,
      requirement: detail.clientCompatibility,
    };
  }
  return { kind: "update-host", hostId, isTargetHost, detail };
}

/**
 * Takes client version as an argument rather than reading the app manifest.
 */
export function hostUpdateSkew(
  detail: SelectionIncompatibility,
  clientAppVersion: string | null,
): VersionSkewCopy {
  return describeVersionSkew({
    hostAppVersion: detail.hostVersion,
    clientAppVersion,
    guidance: null,
  });
}

export function hostUpdateActionApplies(
  detail: SelectionIncompatibility,
  clientAppVersion: string | null,
): boolean {
  return (
    hostUpdateSkew(detail, clientAppVersion).direction !== "client-outdated"
  );
}

/**
 * Visibility is derived; nothing in the tree may hold this open.
 */
export function deriveWindowNarration(
  input: WindowNarrationInput,
): WindowNarrationState {
  if (!input.attached) return { kind: "silent" };
  if (input.effectiveHostId === null) {
    // Before first serve, a fleet with no dead lease is a start in progress, not a no-host verdict.
    // Local restarting grace only when the target is this machine and the scan would have said `offline`.
    const targetLease = findLease(input.leases, input.targetHostId);
    const noHostVariant = deriveNoHostVariant(input.leases, input.targetHostId);
    const localTargetRestarting =
      input.targetHostId !== null &&
      input.targetHostId === input.localHostId &&
      targetLease?.status === "restarting-expected";
    if (
      !input.hasBeenServed &&
      input.localHostExpected &&
      noHostVariant.kind === "offline" &&
      (localTargetRestarting ||
        input.leases.every((lease) => lease.status !== "dead"))
    ) {
      return {
        kind: "narrating",
        cause: "cold-start",
        variant: { kind: "offline" },
      };
    }
    return {
      kind: "narrating",
      cause: "no-usable-host",
      variant: noHostVariant,
    };
  }
  if (input.hasBeenServed) return { kind: "silent" };
  if (isServingLease(findLease(input.leases, input.effectiveHostId))) {
    return { kind: "silent" };
  }
  // Cold start is always the `offline` variant, never the fleet scan: a host can serve, it just has not finished coming up.
  return {
    kind: "narrating",
    cause: "cold-start",
    variant: { kind: "offline" },
  };
}
