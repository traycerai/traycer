import type { FleetUpdateView } from "@/lib/host/fleet-update/fleet-update-view";
import { warrantsFastPoll } from "@/lib/host/fleet-update/fleet-update-view";

/**
 * The bounds fleet observation runs under (plan §6), kept in one pure module so
 * they can be asserted directly rather than inferred from a running scheduler.
 *
 * Every number here is a cost paid on someone else's machine — a remote host
 * answering a poll it did not ask for — so each is stated with what it buys.
 */

/**
 * Most remote reads in flight at once, across the whole fleet.
 *
 * A directory can hold many hosts and a status read is cheap individually, so
 * the thing to bound is the burst: without a cap, opening Settings on a
 * twenty-host account would issue twenty concurrent relay round trips in one
 * frame. Four keeps a large fleet's first paint responsive without making the
 * queue itself the bottleneck.
 */
export const FLEET_MAX_CONCURRENT_READS = 4;

/**
 * Idle cadence. Long on purpose: an idle host's update state changes when a
 * person or a reconciler acts, not continuously, and this poll exists to keep a
 * badge honest rather than to detect an edge promptly.
 */
export const FLEET_IDLE_POLL_MS = 60_000;

/**
 * Active cadence, and the ONLY thing that earns it is a genuinely running
 * operation on that host — see {@link warrantsFastPoll}, which refuses it for
 * parked, terminal and qualified views.
 *
 * Two seconds is what makes a progress bar look live. Spending it on a host
 * that is merely parked would be a fleet-wide 30× cost increase for a number
 * that is not moving: `waiting-to-activate` can sit for a week by design.
 */
export const FLEET_ACTIVE_POLL_MS = 2_000;

/**
 * How long an observation is presented as current before it projects `unknown`.
 *
 * DERIVED from the cadence rather than written beside it, and that is
 * deliberate — ticket 04 shipped an inverted pair of hand-written timing
 * constants (an outer deadline shorter than the inner probe budget it
 * contained) and the fix there was the same move: make it one number so the
 * inversion cannot be reintroduced by editing one of two.
 *
 * The multiplier is the slack: a healthy poll refreshes at `delay`, so a
 * deadline at `delay` exactly would flicker between fresh and stale on every
 * tick. Allowing two missed polls plus a round trip means staleness signals a
 * genuinely stopped poll, which is what the qualified `unknown` is for.
 */
export const FLEET_FRESHNESS_SLACK_FACTOR = 2.5;

/** The cadence this host has earned, in ms. */
export function fleetPollDelayMs(view: FleetUpdateView): number {
  return warrantsFastPoll(view) ? FLEET_ACTIVE_POLL_MS : FLEET_IDLE_POLL_MS;
}

/**
 * When an observation taken at `observedAtMs` stops being presentable as
 * current, given the cadence the host was on when it was taken.
 *
 * Stamped at observation time rather than computed at render time so a view
 * cannot silently extend its own freshness by being re-rendered.
 */
export function fleetFreshUntilMs(
  observedAtMs: number,
  pollDelayMs: number,
): number {
  return observedAtMs + pollDelayMs * FLEET_FRESHNESS_SLACK_FACTOR;
}
