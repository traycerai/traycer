import {
  type RouterHistory,
  type UseNavigateResult,
} from "@tanstack/react-router";
import {
  areNestedFocusTargetsEqual,
  buildNestedFocusSearchPatch,
  parseNestedFocusTargetFromSearch,
  type NestedFocusTarget,
} from "@/lib/epic-nested-focus-route";
import { getHistoryController } from "@/lib/persistent-history";
import { requestNestedRoutePrimaryEditorFocus } from "@/lib/nested-route-dom-focus";
import {
  beginNestedFocusNavigation,
  markExplicitNestedFocusIntent,
} from "@/lib/nested-focus-navigation-intent";

export interface NestedFocusLocation {
  readonly pathname: string;
  readonly search: Readonly<Record<string, unknown>>;
}

export interface NestedFocusNavigationRouter {
  readonly history: RouterHistory;
  readonly navigate: UseNavigateResult<string>;
  readonly getLocation: () => NestedFocusLocation;
}

export type PrepareNestedFocusTarget = () => NestedFocusTarget | null;

export type NavigateNestedFocus = (
  epicId: string,
  tabId: string,
  prepare: PrepareNestedFocusTarget,
) => NestedFocusTarget | null;

export function navigateNestedFocus(
  router: NestedFocusNavigationRouter,
  tab: { readonly epicId: string; readonly tabId: string },
  prepare: PrepareNestedFocusTarget,
): NestedFocusTarget | null {
  return navigateNestedFocusWithDomRestore(router, tab, prepare, false);
}

export function navigateNestedFocusToPrimaryEditor(
  router: NestedFocusNavigationRouter,
  tab: { readonly epicId: string; readonly tabId: string },
  prepare: PrepareNestedFocusTarget,
): NestedFocusTarget | null {
  return navigateNestedFocusWithDomRestore(router, tab, prepare, true);
}

function navigateNestedFocusWithDomRestore(
  router: NestedFocusNavigationRouter,
  tab: { readonly epicId: string; readonly tabId: string },
  prepare: PrepareNestedFocusTarget,
  restorePrimaryEditor: boolean,
): NestedFocusTarget | null {
  const { epicId, tabId } = tab;
  // Recorded BEFORE the target is prepared, so every early return below still
  // stamps the gesture: closing the last tile prepares `null`, re-selecting
  // the already-focused tile prepares an equal target, and a window with no
  // history controller prepares one it never commits. The person acted in all
  // three, which is the only thing this stamp is about.
  //
  // Not every commit through here IS a person, though - a host push surfacing
  // an agent's or a page's tab comes through the same door. Such a caller wraps
  // its commit in `withoutHumanNestedFocusIntent`, and this call then records
  // nothing.
  markExplicitNestedFocusIntent(epicId, tabId);
  const target = prepare();
  if (target === null) {
    return null;
  }
  const controller = getHistoryController(router.history);
  if (controller === null) {
    return target;
  }

  const location = router.getLocation();
  if (!isCurrentEpicTabRoute(location.pathname, epicId, tabId)) {
    return target;
  }

  const currentTarget = parseNestedFocusTargetFromSearch(location.search);
  if (areNestedFocusTargetsEqual(currentTarget, target)) {
    return target;
  }

  if (restorePrimaryEditor) {
    requestNestedRoutePrimaryEditorFocus(epicId, tabId, target);
  }
  beginNestedFocusNavigation(epicId, tabId, target);

  void router.navigate({
    to: "/epics/$epicId/$tabId",
    params: { epicId, tabId },
    search: (prev) => ({
      ...prev,
      focusedAt: prev.focusedAt,
      focusArtifactId: prev.focusArtifactId,
      focusThreadId: prev.focusThreadId,
      migrationSource: prev.migrationSource,
      ...buildNestedFocusSearchPatch(target),
    }),
    replace: false,
  });

  return target;
}

/**
 * A background epic surface must not yank the router to its own route, so a
 * focus-param write is gated on the router already being on this epic tab.
 * Exported because `use-epic-route-synchronization` gates the same write.
 */
export function isCurrentEpicTabRoute(
  pathname: string,
  epicId: string,
  tabId: string,
): boolean {
  const parts = pathname.split("/");
  if (parts.length !== 4) return false;
  const [_root, scope, routeEpicId, routeTabId] = parts;
  return scope === "epics" && routeEpicId === epicId && routeTabId === tabId;
}
