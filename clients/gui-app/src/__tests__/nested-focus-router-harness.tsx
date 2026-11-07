import type { ReactElement } from "react";
import {
  Outlet,
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { render, type RenderResult } from "@testing-library/react";
import { createPersistentMemoryHistory } from "@/lib/persistent-history";
import { observeNestedFocusTraversals } from "@/lib/nested-focus-history-traversal";
import { normalizeEpicFocusSearch } from "@/routes/epic-route-search";

/**
 * Mounts `ui` as the `/epics/$epicId/$tabId` route of a REAL TanStack router
 * backed by a persistent (branded) memory history - the desktop gate
 * `useEpicNestedFocusNavigation` checks via `getHistoryController` - so a
 * genuine opener interaction inside `ui` actually writes `focusPaneId` /
 * `focusTileInstanceId` into `router.state.location.search`, not just into a
 * mocked spy's call args. Read those fields off the returned `router` after
 * firing the interaction.
 *
 * The traversal observer is installed here for the same reason: `createRouter`
 * is the raw constructor, so a fixture built from it carries none of what
 * `createAppRouter` wires onto a real app's history, and a history step inside
 * `ui` would be observed by nothing. Installed in the same position as
 * production - on the router's history, before `<RouterProvider>` mounts and
 * subscribes the router's own loader - so the subscriber ORDER a step depends
 * on is the real one. (`src/__tests__/router.test.ts` is what pins that
 * `createAppRouter` itself still does this; this is the fixture matching it,
 * not a substitute for it.)
 */
export function renderNestedFocusFixture(
  epicId: string,
  tabId: string,
  ui: ReactElement,
) {
  const history = createPersistentMemoryHistory(
    `/epics/${epicId}/${tabId}`,
    `nested-focus-fixture:${epicId}:${tabId}`,
  );
  const rootRoute = createRootRoute({ component: Outlet });
  const epicTabRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/epics/$epicId/$tabId",
    validateSearch: (search: Record<string, unknown>) =>
      normalizeEpicFocusSearch(search),
    component: () => ui,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([epicTabRoute]),
    history,
  });
  const unobserve = observeNestedFocusTraversals(router.history);
  const result: RenderResult = render(<RouterProvider router={router} />);
  return {
    router,
    ...result,
    unmount: () => {
      unobserve();
      result.unmount();
    },
  };
}
