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
import {
  convertBrowserTabToPip,
  type PipOrigin,
} from "@/lib/browser-view/pip/pip-store";
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
  /**
   * Who a `pip` plan floats on behalf of. `manual` is the user's own gesture;
   * `agent` is a host push, and it MATTERS - `isManualPipActive` refuses to
   * replace a `manual` float, so mislabelling one wedges every later agent
   * float (L4).
   */
  readonly pipOrigin: PipOrigin;
}

/**
 * `<kind>Opened` analytics for the split path, which has no `FromSource`
 * variant of its own. Identity of the tab's canvas IS the "did anything
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

  if (plan.kind === "noop") return null;

  if (plan.kind === "pip") {
    if (epicId === null || !isBrowserSessionTileRef(node)) return null;
    convertBrowserTabToPip({
      epicId,
      hostId: node.hostId,
      sessionId: node.sessionId,
      tabId: node.tabId,
      origin: args.pipOrigin,
      onReady: () => {},
      onError: (message) => {
        // Silent for a host push by design: a failed auto-PiP leaves the tab
        // reachable in the sidebar instead of toasting about background
        // automation.
        if (args.pipOrigin === "agent") return;
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
    // No `<kind>Opened` here: nothing entered the canvas, and counting a
    // focus as an open inflates every open metric (R9).
    const target = commit(() =>
      store.prepareSetActiveTileTabFocusTarget(
        tabId,
        plan.paneId,
        plan.instanceId,
      ),
    );
    // Preview membership is not part of `NestedFocusTarget`, so the promotion
    // needs no route write of its own (same as the preview split below).
    if (plan.promote) store.promotePreviewInTab(tabId, plan.paneId);
    return target;
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
    if (target === null) {
      // The split was refused (`MAX_TREE_DEPTH`, or a pane that has since
      // gone). Land the tile as a tab in the pane we would have split rather
      // than dropping the open on the floor.
      return commit(() =>
        store.prepareOpenTileInPaneFocusTargetFromSource(
          tabId,
          plan.paneId,
          node,
          { mode: plan.mode, index: null, source },
        ),
      );
    }
    // `splitPaneAtEdge` always lands the node as a permanent tab, so a preview
    // split claims the fresh pane's (still empty) preview slot afterwards.
    // Preview membership is not part of `NestedFocusTarget`, so this needs no
    // route write of its own.
    const splitInstanceId = target.tileInstanceId;
    if (plan.mode === "preview" && splitInstanceId !== undefined) {
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
