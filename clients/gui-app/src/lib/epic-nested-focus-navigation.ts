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
  const { epicId, tabId } = tab;
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

function isCurrentEpicTabRoute(
  pathname: string,
  epicId: string,
  tabId: string,
): boolean {
  const parts = pathname.split("/");
  if (parts.length !== 4) return false;
  const [_root, scope, routeEpicId, routeTabId] = parts;
  return scope === "epics" && routeEpicId === epicId && routeTabId === tabId;
}
