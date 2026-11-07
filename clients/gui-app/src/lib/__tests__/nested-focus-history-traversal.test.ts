/**
 * The traversal observer's policy, against a REAL `createMemoryHistory`.
 *
 * Every case here exists because of something the installed
 * `@tanstack/history` actually does, not because of what a traversal sounds
 * like it should mean. The destination-level consequences - which artifact
 * ends up focused on the canvas - are pinned in
 * `components/epic-canvas/__tests__/route-focus-opens-requested-artifact.test.tsx`
 * through the real route hook; this file pins the decision the observer makes.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryHistory } from "@tanstack/react-router";
import { observeNestedFocusTraversals } from "@/lib/nested-focus-history-traversal";
import {
  lastExplicitNestedFocusIntentSeq,
  lastReturnedToNestedFocusRequestSeq,
  resetNestedFocusNavigationIntentsForTests,
} from "@/lib/nested-focus-navigation-intent";

const EPIC_ID = "epic-traversal";
const TAB_ID = "tab-traversal";

/** The pending request's own entry: an artifact asked for, no tile named. */
const REQUEST = `/epics/${EPIC_ID}/${TAB_ID}?focusArtifactId=a1&focusedAt=2800`;
/** A destination naming a tile, under the SAME request key. */
const TILE_Y = `${REQUEST}&focusPaneId=pane-1&focusTileInstanceId=inst-y`;
const TILE_Z = `${REQUEST}&focusPaneId=pane-1&focusTileInstanceId=inst-z`;

/**
 * Whether the tab's signals currently say the person has turned AWAY from a
 * waiting request - the ordering route sync reads, not the raw stamp. A return
 * does not erase the earlier choice; it outranks it, because both are stamped
 * from one sequence and the higher stamp is what happened last.
 */
function claimsTheRequestWasLeft(): boolean {
  const chose = lastExplicitNestedFocusIntentSeq(EPIC_ID, TAB_ID);
  return (
    chose > 0 && chose > lastReturnedToNestedFocusRequestSeq(EPIC_ID, TAB_ID)
  );
}

afterEach(resetNestedFocusNavigationIntentsForTests);

describe("observeNestedFocusTraversals", () => {
  it("claims the person's choice when a traversal lands on a named tile", () => {
    const history = createMemoryHistory({ initialEntries: [REQUEST, TILE_Y] });
    observeNestedFocusTraversals(history);

    history.back();
    history.forward();

    expect(claimsTheRequestWasLeft()).toBe(true);
  });

  // A traversal ACTION is not proof that anything committed. Memory history
  // clamps (`index = Math.max(index - 1, 0)`) and `createHistory` still calls
  // `handleIndexChange` → `notify({type:"BACK"})` with the location
  // unchanged, so all three of these notify while standing still. Claiming a
  // choice here would cancel the artifact the route is opening because a step
  // did NOT happen - which is why the observer reads entry identity and not
  // the action alone.
  it("claims nothing when a traversal notifies without moving", () => {
    const history = createMemoryHistory({ initialEntries: [TILE_Y] });
    observeNestedFocusTraversals(history);

    history.back();
    history.forward();
    history.go(0);

    expect(claimsTheRequestWasLeft()).toBe(false);
  });

  // `replaceNestedFocusRoute` writes the route on every tile focus, including
  // the automatic commit that SERVES a pending request. If a write counted as
  // a traversal the request would retire itself the instant it was answered.
  it("claims nothing when the app WRITES an entry naming a tile", () => {
    const history = createMemoryHistory({ initialEntries: [REQUEST] });
    observeNestedFocusTraversals(history);

    history.replace(TILE_Y);
    history.push(TILE_Z);

    expect(claimsTheRequestWasLeft()).toBe(false);
  });

  // The sequence that abstention alone does not fix. Retirement is
  // `lastIntentSeq > baseline.lastIntentSeq` against a baseline captured when
  // the request's key first arrived and never recut, so a stamp left by the
  // first Back outlives it: without RESTORING on the return, the person's own
  // Back permanently cancels the artifact they asked for.
  it("restores the request when a traversal returns to its own entry", () => {
    const history = createMemoryHistory({ initialEntries: [REQUEST] });
    observeNestedFocusTraversals(history);
    history.push(TILE_Y);
    history.push(TILE_Z);

    history.back();
    expect(claimsTheRequestWasLeft()).toBe(true);

    history.back();

    expect(claimsTheRequestWasLeft()).toBe(false);
  });
});
