import type { NavigateOptions } from "@tanstack/react-router";

/**
 * Marks a router commit as SAME-TAB BOOKKEEPING: a replace that only records
 * view state (tile-focus search params) onto the route its issuing tab was
 * already showing, never a navigation the user asked for.
 *
 * The mark exists because a bookkeeping replace can land LATE. It is issued
 * `void navigate(...)` from an effect, so the user can activate another tab
 * while it is still in flight; it then commits carrying no activation
 * envelope, and the navigation controller used to read it as an external
 * navigation back to the epic — re-activating the tab the user just left and
 * silently swallowing the activation they just made (the staging 2026-08-31
 * "Start Page click does nothing" defect). The mark rides in history state,
 * exactly like the controller's own activation envelopes, so the controller
 * can tell "this tab recording its own view state" from "the user went
 * somewhere".
 *
 * Stepping BACK onto a marked entry is unaffected: the controller classifies
 * history steps before it looks at the mark, so a marked entry reached
 * through the user's own history still resolves as user intent.
 */
const ROUTE_BOOKKEEPING_KEY = "__traycerRouteBookkeeping";

export function applyRouteBookkeeping(
  options: NavigateOptions,
): NavigateOptions {
  return {
    ...options,
    state: (previous) => ({
      ...previous,
      [ROUTE_BOOKKEEPING_KEY]: true,
    }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isRouteBookkeepingState(state: unknown): boolean {
  return isRecord(state) && state[ROUTE_BOOKKEEPING_KEY] === true;
}
