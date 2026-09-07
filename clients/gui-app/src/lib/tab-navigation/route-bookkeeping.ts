import type { NavigateOptions } from "@tanstack/react-router";

/**
 * Marks a router commit as SAME-TAB BOOKKEEPING: a replace that only records view state (tile-focus search params) onto the route its issuing tab was already showing, never a navigation the user asked for.
 */
const ROUTE_BOOKKEEPING_KEY = "__traycerRouteBookkeeping";

/**
 * Composes any `state` the caller already set rather than replacing it, so marking a navigation never silently drops what it was carrying.
 * The mark is applied last: it is the one part of the resulting state this helper owns.
 */
export function applyRouteBookkeeping(
  options: NavigateOptions,
): NavigateOptions {
  const callerState = options.state;
  return {
    ...options,
    state: (previous) => {
      const carried =
        typeof callerState === "function" ? callerState(previous) : callerState;
      // `previous` stays the base so the router's own required entry fields survive; the caller's state overlays it, and the mark - the one part this helper owns - is applied last.
      return {
        ...previous,
        ...(isRecord(carried) ? carried : {}),
        [ROUTE_BOOKKEEPING_KEY]: true,
      };
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isRouteBookkeepingState(state: unknown): boolean {
  return isRecord(state) && state[ROUTE_BOOKKEEPING_KEY] === true;
}
