/**
 * Runs one {@link TileOpenPlan} (plan §5.1, ticket 05). The resolver decides,
 * this dispatches - no placement logic lives here.
 *
 * Every plan except `pip` commits through `navigateNested`, so the canvas
 * mutation and the route's `focusPaneId` / `focusTileInstanceId` are written in
 * one step (the nested-focus boundary; see
 * `traycer/eslint/traycer-nested-focus-boundary-rules.mjs`). `pip` moves the
 * tab out of the tile tree entirely, so it has no focus target to commit.
 */
import { toast } from "sonner";
import type { AnalyticsSource } from "@/lib/analytics";
import { convertBrowserTabToPip } from "@/lib/browser-view/pip/pip-store";
import type { NavigateNestedFocus } from "@/lib/epic-nested-focus-navigation";
import type { NestedFocusTarget } from "@/lib/epic-nested-focus-route";
import {
  trackOpenedCanvasTile,
  useEpicCanvasStore,
  type EpicCanvasStore,
} from "@/stores/epics/canvas/store";
import {
  isBrowserSessionTileRef,
  type EpicCanvasTileRef,
} from "@/stores/epics/canvas/types";
import type { TileOpenPlan } from "./intent";

export interface ExecuteTileOpenArgs {
  readonly plan: TileOpenPlan;
  readonly node: EpicCanvasTileRef;
  readonly source: AnalyticsSource;
  readonly store: EpicCanvasStore;
  readonly navigateNested: NavigateNestedFocus;
  /**
   * The epic behind `plan.tabId` - the header tab may have just been created.
   * `null` for a tab id the store does not know: the canvas mutation still
   * runs, it just has no route to write (the pre-existing `openTileInTab`
   * fallback), and `pip` becomes a no-op.
   */
  readonly epicId: string | null;
}

/**
 * `<kind>Opened` analytics for the two prepare* paths with no `FromSource`
 * variant of their own. Identity of the tab's canvas IS the "did anything
 * happen" signal every `FromSource` wrapper already uses.
 */
function trackIfCanvasChanged(
  tabId: string,
  node: EpicCanvasTileRef,
  source: AnalyticsSource,
  run: () => NestedFocusTarget | null,
): NestedFocusTarget | null {
  const before = useEpicCanvasStore.getState().canvasByTabId[tabId];
  const target = run();
  if (before !== useEpicCanvasStore.getState().canvasByTabId[tabId]) {
    trackOpenedCanvasTile(node, source);
  }
  return target;
}

export function executeTileOpen(
  args: ExecuteTileOpenArgs,
): NestedFocusTarget | null {
  const { epicId, navigateNested, node, plan, source, store } = args;

  if (plan.kind === "pip") {
    // ponytail: origin is always "manual" - the plan carries no gesture, and
    // the only agent-origin caller (ticket 09) does its own suppression pass
    // before it ever reaches a plan. Thread the gesture through if that stops
    // being true.
    if (epicId === null || !isBrowserSessionTileRef(node)) return null;
    convertBrowserTabToPip({
      epicId,
      hostId: node.hostId,
      sessionId: node.sessionId,
      tabId: node.tabId,
      origin: "manual",
      onReady: () => {},
      onError: (message) => {
        toast.error(message);
      },
    });
    return null;
  }

  const tabId = plan.tabId;
  const commit = (
    prepare: () => NestedFocusTarget | null,
  ): NestedFocusTarget | null =>
    epicId === null ? prepare() : navigateNested(epicId, tabId, prepare);

  if (plan.kind === "focus-existing") {
    return trackIfCanvasChanged(tabId, node, source, () =>
      commit(() =>
        store.prepareSetActiveTileTabFocusTarget(
          tabId,
          plan.paneId,
          plan.instanceId,
        ),
      ),
    );
  }

  if (plan.kind === "split") {
    const target = trackIfCanvasChanged(tabId, node, source, () =>
      commit(() =>
        store.prepareSplitPaneWithNodeFocusTarget(
          tabId,
          plan.paneId,
          plan.edge,
          node,
        ),
      ),
    );
    // `splitPaneAtEdge` always lands the node as a permanent tab, so a preview
    // split claims the fresh pane's (still empty) preview slot afterwards.
    // Preview membership is not part of `NestedFocusTarget`, so this needs no
    // route write of its own.
    const splitInstanceId = target === null ? undefined : target.tileInstanceId;
    if (
      plan.mode === "preview" &&
      target !== null &&
      splitInstanceId !== undefined
    ) {
      store.restorePreviewInTab(tabId, target.paneId, splitInstanceId);
    }
    return target;
  }

  const paneId = plan.paneId;
  if (paneId === null) {
    // Nothing to open INTO: the whole-canvas openers seed a root pane.
    return commit(() => {
      if (plan.mode === "background") {
        return store.prepareOpenTileInBackgroundTabFocusTargetFromSource(
          tabId,
          node,
          source,
        );
      }
      if (plan.mode === "preview") {
        return store.prepareOpenTilePreviewInTabFocusTargetFromSource(
          tabId,
          node,
          source,
        );
      }
      return store.prepareOpenTileInTabFocusTargetFromSource(
        tabId,
        node,
        source,
      );
    });
  }

  return commit(() =>
    store.prepareOpenTileInPaneFocusTargetFromSource(tabId, paneId, node, {
      mode: plan.mode,
      index: plan.index,
      source,
    }),
  );
}
