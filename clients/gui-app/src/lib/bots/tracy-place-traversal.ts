import type { HistoryLocation, RouterHistory } from "@tanstack/react-router";
import { hrefPathname, isTracyPath } from "@/lib/routes";

/**
 * The identity of the entry a location sits on: `__TSR_key` is minted per
 * entry, which tells two entries sharing an href apart. Index plus href is
 * the fallback for a state older than the key.
 */
export function historyEntryIdentity(location: {
  readonly href: string;
  readonly state: HistoryLocation["state"];
}): string {
  const { state } = location;
  const key = state.__TSR_key ?? state.key ?? null;
  if (key !== null && key.length > 0) return `key:${key}`;
  return `index:${String(state.__TSR_index)}|${location.href}`;
}

/**
 * The Tracy entry the person last STEPPED onto (back, forward, or the entry
 * the app started on), not yet taken by the surface's route. A place is put
 * back only from such an entry: every other arrival is the app writing one,
 * and there the surface's own stores say where it is.
 */
let steppedOnto: string | null = null;

/**
 * Whether `identity` is the Tracy entry the person stepped onto. Taken once:
 * the same entry reached again by an app write is no step.
 */
export function takeTracyPlaceStep(identity: string): boolean {
  if (steppedOnto !== identity) return false;
  steppedOnto = null;
  return true;
}

/**
 * Observes every committed history traversal for the life of the router and
 * remembers a landing on a Tracy entry. Read off what happened, as
 * `observeNestedFocusTraversals` does and for its reasons: a traversal action
 * that did not move the entry (a clamped or refused step) is no landing, and a
 * write (`PUSH`, `REPLACE`) never is. The entry the history starts on counts
 * as one: a restart, or a pasted link, lands the surface where the entry says.
 *
 * Returns the unsubscribe, for a router that is torn down.
 */
export function observeTracyPlaceTraversals(
  history: RouterHistory,
): () => void {
  let lastIdentity = historyEntryIdentity(history.location);
  steppedOnto = isTracyPath(hrefPathname(history.location.href))
    ? lastIdentity
    : null;
  return history.subscribe(({ location, action }) => {
    const identity = historyEntryIdentity(location);
    const moved = identity !== lastIdentity;
    lastIdentity = identity;
    if (!moved) return;
    const traversed =
      action.type === "BACK" ||
      action.type === "FORWARD" ||
      action.type === "GO";
    steppedOnto =
      traversed && isTracyPath(hrefPathname(location.href)) ? identity : null;
  });
}
