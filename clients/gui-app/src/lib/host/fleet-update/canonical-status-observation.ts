import type { ResponseOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { observationFromStatus } from "@/lib/host/fleet-update/borrowed-status-read";
import type {
  FleetUpdateWireObservation,
  FleetUpdateSource,
} from "@/lib/host/fleet-update/fleet-update-view";

/**
 * Turning a CANONICAL `host.status` query into an observation — freshness
 * included, rather than assumed.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE DEFECT THIS MODULE EXISTS TO MAKE UNREPEATABLE
 *
 * The selected-host Overview used to build its observation like this:
 *
 *     freshUntilMs: Number.POSITIVE_INFINITY,
 *     nowMs: statusQuery.dataUpdatedAt,
 *     connected: true,
 *
 * — with a comment explaining that freshness was judged elsewhere, by the
 * page's own live-source helpers. It was not. Those helpers demoted the BUSY
 * snapshot; nothing applied them to the update projection, so the two
 * projections read the same retained response and disagreed about it.
 *
 * The consequence was not cosmetic. A host that reported an active
 * `downloading` attempt and then went unreachable kept that reading forever:
 * TanStack retains the last successful response, an infinite freshness deadline
 * can never expire, and `nowMs` taken from `dataUpdatedAt` cannot outrun a
 * deadline derived from the same instant. The view stayed `downloading`,
 * `holdsLifecycleGate` stayed true, an open restart confirmation closed itself,
 * and the Doctor card's bridge restart stayed refused — indefinitely, on a host
 * whose only route back was the restart being blocked.
 *
 * That is the third instance of one class in this epic, after the parked-attempt
 * gate and Ticket 05's TOCTOU: **a fact consumed outside the conditions that
 * keep it true.** A correct predicate evaluated against a reading nobody is
 * still refreshing is not a guarantee, and the fix is never a second opinion
 * about the reading — it is to carry the conditions with the fact.
 *
 * So freshness is not asserted here, it is DERIVED, and the same derivation
 * serves the local banner, the selected Overview and the fleet's coalesced
 * reads. One function, three legs, no per-surface staleness rule to drift.
 * ────────────────────────────────────────────────────────────────────────────
 */

/**
 * The read-health facts a TanStack query already knows about itself.
 *
 * Structurally identical to what the Overview's busy snapshot consumes, and
 * that is the point: the busy chip and the update card now demote on exactly
 * the same evidence instead of on two different theories about one response.
 */
export interface CanonicalReadHealth {
  readonly isError: boolean;
  readonly fetchStatus: "fetching" | "paused" | "idle";
  readonly isStale: boolean;
  /**
   * Whether this client has any route to the host at all. `false` collapses
   * every other signal — a retained response from a host we cannot address is
   * a memory, not a reading.
   */
  readonly hasLiveSource: boolean;
}

/**
 * A deadline that has already passed for every finite clock.
 *
 * Demotion is expressed as an EXPIRED observation rather than as a second
 * `unknown` branch so that exactly one place in the codebase decides what a
 * stale reading looks like — `projectFleetUpdateView`'s stale arm, which also
 * retains the last-known phase. A parallel "if unhealthy return unknown" here
 * would answer the same question in a second voice and would drop the retained
 * phase that the offline state is required to show.
 */
const EXPIRED_FRESH_UNTIL_MS = Number.NEGATIVE_INFINITY;

/**
 * The same observation, marked as something we can no longer present as current.
 *
 * Exported because the fleet hook reaches the same conclusion by a different
 * route — it inspects a shared cache ENTRY, which has no observer-relative
 * staleness verdict to consult, only an error or paused status. Expiring rather
 * than DISCARDING such an entry is what keeps the picker row and the Overview
 * telling the same story about one host: discarding it leaves the row with a
 * bare `unknown` and no retained phase, while the Overview — reading the same
 * response through {@link observationFromCanonicalRead} — still says "last seen
 * downloading". Two surfaces disagreeing about one attempt is the exact
 * outcome this feature's single-projection design exists to prevent.
 */
export function expiredObservation(
  observation: FleetUpdateWireObservation,
): FleetUpdateWireObservation {
  return { ...observation, freshUntilMs: EXPIRED_FRESH_UNTIL_MS };
}

/**
 * Whether this read may be presented as CURRENT.
 *
 * `fetching` is deliberately live regardless of `isStale`: a request in flight
 * is the definition of still looking, and demoting during the refetch window
 * would blink the banner to "last known" on every poll. Everything else that
 * means we have stopped looking — no route, a failed read, a fetch paused
 * because the client is offline, or data that has aged past its own staleness
 * window without a fetch replacing it — demotes.
 */
export function canonicalReadIsLive(health: CanonicalReadHealth): boolean {
  if (!health.hasLiveSource) return false;
  if (health.isError) return false;
  if (health.fetchStatus === "paused") return false;
  if (health.fetchStatus === "fetching") return true;
  return !health.isStale;
}

/**
 * Stamps a canonical `host.status` response into an observation whose freshness
 * reflects the query that produced it.
 *
 * An unhealthy read still yields an observation — carrying its phase, attempt
 * id and target — but one that is already expired, so it projects the qualified
 * `unknown` that fails every lifecycle gate open and still lets a surface say
 * "last seen downloading v1.2.3".
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
