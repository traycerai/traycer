import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAppRouter } from "@/router";
import {
  lastExplicitNestedFocusIntentSeq,
  resetNestedFocusNavigationIntentsForTests,
} from "@/lib/nested-focus-navigation-intent";

describe("createAppRouter", () => {
  it("boots from the desktop initial route without relying on the URL hash", () => {
    const router = createAppRouter("/epics/epic-a", null);

    expect(router.state.location.pathname).toBe("/epics/epic-a");
  });

  // T156: pins that `createAppRouter` actually wires
  // `observeNestedFocusTraversals` onto the live `router.history`, rather than
  // asserting the source merely contains the call. `createAppRouter` is cheap
  // to construct directly (as the case above already does, with no
  // `RouterProvider` mount) - with no Electron/mobile context and a non-null
  // `initialRoute`, `createAppHistory` hands back a real `createMemoryHistory`
  // instance, so a genuine `history.back()` here exercises the exact
  // `history.subscribe` wiring `createAppRouter` installs, with nothing about
  // the observer itself re-implemented in the test.
  describe("nested-focus traversal observer wiring", () => {
    beforeEach(() => {
      resetNestedFocusNavigationIntentsForTests();
    });

    afterEach(() => {
      resetNestedFocusNavigationIntentsForTests();
    });

    it("marks a traversal landing on a nested focus target through the router's own history", () => {
      const tileHref =
        "/epics/epic-wiring/tab-wiring?focusPaneId=pane-1&focusTileInstanceId=tile-1";
      const router = createAppRouter(tileHref, null);
      router.history.push("/epics/epic-wiring/tab-wiring");
      const before = lastExplicitNestedFocusIntentSeq(
        "epic-wiring",
        "tab-wiring",
      );

      router.history.back();

      expect(
        lastExplicitNestedFocusIntentSeq("epic-wiring", "tab-wiring"),
      ).toBeGreaterThan(before);
    });
  });
});
