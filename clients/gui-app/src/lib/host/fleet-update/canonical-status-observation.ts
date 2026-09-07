import type { ResponseOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { observationFromStatus } from "@/lib/host/fleet-update/borrowed-status-read";
import type {
  FleetUpdateWireObservation,
  FleetUpdateSource,
} from "@/lib/host/fleet-update/fleet-update-view";

/**
 * Derive freshness with the `host.status` observation; never assert infinite freshness from `dataUpdatedAt`.
 * A retained downloading reading with an unexpiring deadline held lifecycle gates on an unreachable host.
 */

/** The read-health facts a TanStack query already knows about itself. */
export interface CanonicalReadHealth {
  readonly isError: boolean;
  readonly fetchStatus: "fetching" | "paused" | "idle";
  readonly isStale: boolean;
  /**
   * Whether this client has any route to the host at all.
   * `false` collapses every other signal - a retained response from a host we cannot address is a memory, not a reading.
   */
  readonly hasLiveSource: boolean;
}

/** A deadline that has already passed for every finite clock. */
const EXPIRED_FRESH_UNTIL_MS = Number.NEGATIVE_INFINITY;

/** The same observation, marked as something we can no longer present as current. */
export function expiredObservation(
  observation: FleetUpdateWireObservation,
): FleetUpdateWireObservation {
  return { ...observation, freshUntilMs: EXPIRED_FRESH_UNTIL_MS };
}

/** Whether this read may be presented as CURRENT. */
export function canonicalReadIsLive(health: CanonicalReadHealth): boolean {
  if (!health.hasLiveSource) return false;
  if (health.isError) return false;
  if (health.fetchStatus === "paused") return false;
  if (health.fetchStatus === "fetching") return true;
  return !health.isStale;
}

/**
 * Stamps a canonical `host.status` response into an observation whose freshness reflects the query that produced it.
 */
export function observationFromCanonicalRead(input: {
  readonly hostId: string;
  readonly status: ResponseOfMethod<HostRpcRegistry, "host.status">;
  readonly dataUpdatedAt: number;
  readonly health: CanonicalReadHealth;
  readonly source: FleetUpdateSource;
}): FleetUpdateWireObservation {
  const observation = observationFromStatus({
    hostId: input.hostId,
    status: input.status,
    nowMs: input.dataUpdatedAt,
    source: input.source,
  });
  if (canonicalReadIsLive(input.health)) return observation;
  return { ...observation, freshUntilMs: EXPIRED_FRESH_UNTIL_MS };
}
