import type { AuthenticatedUser } from "@traycer/protocol/auth";
import {
  SANDBOX_FROZEN_RETENTION_DAYS,
  type SandboxCost,
} from "@traycer/protocol/host/sandbox-control";
import { creditBreakdown } from "@/lib/auth/traycer-subscription-content";

const MC_PER_CREDIT = 1000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Runway below which the first balance warning shows: two hours. */
export const SANDBOX_RUNWAY_WARNING_MINUTES = 120;
/** Runway below which the second, louder warning shows: thirty minutes. */
export const SANDBOX_RUNWAY_CRITICAL_MINUTES = 30;

/**
 * The balance sandboxes are charged against, in millicredits: the PERSONAL
 * subscription's remaining plan, bonus and bundle credits - the account the
 * control plane's gate and meter charge (`requireBillingSubscription` with a
 * personal context), whichever account the credits card is showing. `null`
 * when the user or their subscription has not loaded.
 */
export function sandboxBalanceMc(
  user: AuthenticatedUser | null,
): number | null {
  const subscription = user?.userSubscription ?? null;
  if (subscription === null) return null;
  const breakdown = creditBreakdown(subscription);
  const remaining = Math.max(
    0,
    breakdown.totalAvailable - breakdown.totalConsumed,
  );
  return Math.floor(remaining * MC_PER_CREDIT);
}

/**
 * The two-hour and thirty-minute warnings (core flows, flow 5): the live
 * balance divided by the awake burn across the user's sandboxes.
 *
 *  - `none`: nothing is burning, the balance is unknown, or it covers more
 *    than two hours.
 *  - `low`: under two hours at the current burn.
 *  - `critical`: under thirty minutes.
 */
export type SandboxRunwayWarning =
  | { readonly kind: "none" }
  | {
      readonly kind: "low" | "critical";
      /** Whole minutes the balance covers at the current burn. */
      readonly runwayMinutes: number;
    };

export function sandboxRunwayWarning(
  balanceMc: number | null,
  awakeBurnMcPerHour: number | null,
): SandboxRunwayWarning {
  if (balanceMc === null || awakeBurnMcPerHour === null) {
    return { kind: "none" };
  }
  const runwayMinutes = sandboxRunwayMinutes(balanceMc, awakeBurnMcPerHour);
  if (runwayMinutes === null) return { kind: "none" };
  if (runwayMinutes < SANDBOX_RUNWAY_CRITICAL_MINUTES) {
    return { kind: "critical", runwayMinutes };
  }
  if (runwayMinutes < SANDBOX_RUNWAY_WARNING_MINUTES) {
    return { kind: "low", runwayMinutes };
  }
  return { kind: "none" };
}

/** "1 h 40 min", "25 min", "under a minute". */
export function formatRunway(minutes: number): string {
  if (minutes < 1) return "under a minute";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} min`;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/**
 * Whole minutes the balance covers at the burn, or `null` when there is no
 * burn to divide by (nothing is awake).
 */
export function sandboxRunwayMinutes(
  balanceMc: number,
  awakeBurnMcPerHour: number,
): number | null {
  return awakeBurnMcPerHour <= 0
    ? null
    : Math.floor((balanceMc / awakeBurnMcPerHour) * 60);
}

/**
 * The day a frozen sandbox is destroyed, from when it froze. The control
 * plane's day-30 job destroys it {@link SANDBOX_FROZEN_RETENTION_DAYS} days
 * after `frozenAt`.
 */
export function frozenDestroyAt(frozenAt: number): number {
  return frozenAt + SANDBOX_FROZEN_RETENTION_DAYS * MS_PER_DAY;
}

/**
 * What one sandbox was charged since local midnight: the ledger's segments
 * clipped to today, each prorated by the share of it that falls after
 * midnight. Settled and pending charges alike, which is what "today" means
 * to the user.
 */
export function sandboxCostTodayMc(cost: SandboxCost, now: number): number {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const start = midnight.getTime();
  let total = 0;
  for (const segment of cost.segments) {
    if (segment.toAt <= start) continue;
    const span = segment.toAt - segment.fromAt;
    if (span <= 0 || segment.fromAt >= start) {
      total += segment.millicredits;
      continue;
    }
    total += (segment.millicredits * (segment.toAt - start)) / span;
  }
  return Math.round(total);
}
