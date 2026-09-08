/**
 * `openTile` for callers that are not React components (decision C1).
 *
 * `useEpicTileNavigation` is the hook form and the one every component uses;
 * it delegates here. The non-React entry points - tab activation
 * (`lib/tab-navigation.ts`), drag-and-drop commits, the palette's opener
 * actions - already carry their own `navigateNested` seam, so they call this
 * directly rather than growing a hook they cannot use.
 */
import { isMobileViewport } from "@/hooks/ui/use-mobile-viewport";
import type { NavigateNestedFocus } from "@/lib/epic-nested-focus-navigation";
import type { NestedFocusTarget } from "@/lib/epic-nested-focus-route";
import { createEmptyCanvas } from "@/stores/epics/canvas/canvas-state";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import type { PipOrigin } from "@/lib/browser-view/pip/pip-store";
import { executeTileOpen } from "./execute-tile-open";
import type { TileOpenIntent } from "./intent";
import { resolveTileOpen } from "./resolve-tile-open";

/**
 * Runs the prepared focus target without a route write. For the two callers
 * that legitimately have no navigation to do: tab ACTIVATION, which folds the
 * returned target into the navigation envelope it is already building, and a
 * command dispatch whose router adapter carries no nested-focus seam.
 */
export const commitWithoutNavigation: NavigateNestedFocus = (
  _epicId,
  _tabId,
  prepare,
) => prepare();

export interface OpenTileOptions {
  /**
   * Whether an `{ epicId }` target may MINT a header tab. False for a host
   * push: a tab the user never opened must not appear (and activate) because
   * an agent opened a browser tab in it - with no tab, the open is dropped.
   */
  readonly createTab: boolean;
  /**
   * Who a `pip` plan floats on behalf of. `manual` is a user gesture and is
   * what `isManualPipActive` refuses to replace, so a host push MUST say
   * `agent` or it wedges every later agent float.
   */
  readonly pipOrigin: PipOrigin;
}

/** The values every in-app gesture carries: user-initiated, tab-creating. */
export const MANUAL_TILE_OPEN: OpenTileOptions = {
  createTab: true,
  pipOrigin: "manual",
};

export function openTileWithNavigation(
  intent: TileOpenIntent,
  navigateNested: NavigateNestedFocus,
  options: OpenTileOptions,
): NestedFocusTarget | null {
  // Resolve the header tab FIRST: for an `{ epicId }` target this can create
  // one, and the resolver needs THAT tab's canvas.
  const tabId = resolveHeaderTabId(intent, options.createTab);
  if (tabId === null) return null;
  const store = useEpicCanvasStore.getState();
  const plan = resolveTileOpen({
    intent,
    settings: useSettingsStore.getState().tilePlacement,
    canvas: store.canvasByTabId[tabId] ?? createEmptyCanvas(),
    resolveTargetTabForEpic: () => tabId,
    // Imperative read: a placement decision is command-time, so it must not
    // pin this call to a viewport snapshot (C10).
    singleTileViewport: isMobileViewport(),
  });
  return executeTileOpen({
    plan,
    node: intent.node,
    source: intent.source,
    store,
    navigateNested,
    epicId: store.tabsById[tabId]?.epicId ?? null,
    pipOrigin: options.pipOrigin,
  });
}

function resolveHeaderTabId(
  intent: TileOpenIntent,
  createTab: boolean,
): string | null {
  if ("tabId" in intent.target) return intent.target.tabId;
  const store = useEpicCanvasStore.getState();
  return createTab
    ? store.resolveTargetTabForEpic(intent.target.epicId, undefined)
    : store.resolveTabIdForEpic(intent.target.epicId);
}
