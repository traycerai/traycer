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

/**
 * Who asked for a nested-focus commit.
 *
 * Required at every call, with no default, and that is the whole point of it.
 * This boundary is shared: a click, a keypress, a drag, a host push surfacing
 * an agent's browser tab, and a shell closing its own tile on exit all commit
 * through it, and from inside it they are indistinguishable. The route's
 * pending artifact focus reads a commit as the person turning away from a
 * request it is still waiting on, so getting this wrong silently discards the
 * artifact somebody just clicked.
 *
 * A default would have to be `"user"`, since that is the common case - which is
 * exactly backwards, because the automatic callers are the ones nobody
 * remembers, and each would inherit a human's authority. Making it required
 * turns "who asked?" into a question the compiler puts to every call site.
 *
 * Classify the INVOCATION, not the closure. One `onClose` callback can be
 * wired to a Close button and to an exit effect at once, and the same bound
 * navigator serves both a menu item and a lifecycle teardown; the actor is a
 * property of the call, not of the function that was handed around.
 */
export type NestedFocusProvenance =
  /** A person did this: a click, a key, a drag, a menu item, or a gesture
   * whose completion they are waiting on. */
  | "user"
  /** Nobody did this: a host push, a session ending, a tile tearing itself
   * down, any effect reacting to state rather than to a person. */
  | "automatic";

export type NavigateNestedFocus = (
  epicId: string,
  tabId: string,
  prepare: PrepareNestedFocusTarget,
  provenance: NestedFocusProvenance,
) => NestedFocusTarget | null;

export function navigateNestedFocus(
  router: NestedFocusNavigationRouter,
  tab: { readonly epicId: string; readonly tabId: string },
  prepare: PrepareNestedFocusTarget,
  provenance: NestedFocusProvenance,
): NestedFocusTarget | null {
  return navigateNestedFocusWithDomRestore(router, tab, prepare, {
    restorePrimaryEditor: false,
    provenance,
  });
}

export function navigateNestedFocusToPrimaryEditor(
  router: NestedFocusNavigationRouter,
  tab: { readonly epicId: string; readonly tabId: string },
  prepare: PrepareNestedFocusTarget,
  provenance: NestedFocusProvenance,
): NestedFocusTarget | null {
  return navigateNestedFocusWithDomRestore(router, tab, prepare, {
    restorePrimaryEditor: true,
    provenance,
  });
}

function navigateNestedFocusWithDomRestore(
  router: NestedFocusNavigationRouter,
  tab: { readonly epicId: string; readonly tabId: string },
  prepare: PrepareNestedFocusTarget,
  options: {
    readonly restorePrimaryEditor: boolean;
    readonly provenance: NestedFocusProvenance;
  },
): NestedFocusTarget | null {
  const { restorePrimaryEditor, provenance } = options;
  const { epicId, tabId } = tab;
  // Recorded BEFORE the target is prepared, so every early return below still
  // stamps the gesture: closing the last tile prepares `null`, re-selecting
  // the already-focused tile prepares an equal target, and a window with no
  // history controller prepares one it never commits. The person acted in all
  // three, which is the only thing this stamp is about.
  //
  // Gated on what the CALLER declared, because not every commit through here is
  // a person: see {@link NestedFocusProvenance}.
  if (provenance === "user") {
    markExplicitNestedFocusIntent(epicId, tabId);
  }
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
