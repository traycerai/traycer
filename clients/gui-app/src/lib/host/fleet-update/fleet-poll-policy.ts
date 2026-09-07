import type { FleetUpdateView } from "@/lib/host/fleet-update/fleet-update-view";
import { warrantsFastPoll } from "@/lib/host/fleet-update/fleet-update-view";

/**
 * The bounds fleet observation runs under (plan §6), kept in one pure module so they can be asserted directly rather than inferred from a running scheduler.
 */

/** Most remote reads in flight at once, across the whole fleet. */
export const FLEET_MAX_CONCURRENT_READS = 4;

/**
 * Idle cadence.
 * Long on purpose: an idle host's update state changes when a person or a reconciler acts, not continuously, and this poll exists to keep a badge honest rather than to detect an edge promptly.
 */
export const FLEET_IDLE_POLL_MS = 60_000;

/**
 * Active cadence, and the ONLY thing that earns it is a genuinely running operation on that host - see {@link warrantsFastPoll}, which refuses it for parked, terminal and qualified views.
 */
export const FLEET_ACTIVE_POLL_MS = 2_000;

/** How long an observation is presented as current before it projects `unknown`. */
export const FLEET_FRESHNESS_SLACK_FACTOR = 2.5;

/** The cadence this host has earned, in ms. */
export function fleetPollDelayMs(view: FleetUpdateView): number {
  return warrantsFastPoll(view) ? FLEET_ACTIVE_POLL_MS : FLEET_IDLE_POLL_MS;
}

/**
 * When an observation taken at `observedAtMs` stops being presentable as current, given the cadence the host was on when it was taken.
 */
export function fleetFreshUntilMs(
  observedAtMs: number,
  pollDelayMs: number,
): number {
  return observedAtMs + pollDelayMs * FLEET_FRESHNESS_SLACK_FACTOR;
}
