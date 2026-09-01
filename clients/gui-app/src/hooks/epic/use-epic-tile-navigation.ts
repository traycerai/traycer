import { useCallback, useMemo } from "react";
import { useEpicNestedFocusNavigation } from "@/hooks/epic/use-epic-nested-focus-navigation";
import { isMobileViewport } from "@/hooks/ui/use-mobile-viewport";
import { executeTileOpen } from "@/lib/canvas/tile-open/execute-tile-open";
import type { TileOpenIntent } from "@/lib/canvas/tile-open/intent";
import { resolveTileOpen } from "@/lib/canvas/tile-open/resolve-tile-open";
import type { NavigateNestedFocus } from "@/lib/epic-nested-focus-navigation";
import type { NestedFocusTarget } from "@/lib/epic-nested-focus-route";
import { createEmptyCanvas } from "@/stores/epics/canvas/canvas-state";
import {
  useEpicCanvasStore,
  type EpicCanvasStore,
} from "@/stores/epics/canvas/store";
import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";
import { useSettingsStore } from "@/stores/settings/settings-store";

export interface EpicTileNavigation {
  /**
   * The one way a tile enters or is focused on a canvas (decision C1): the
   * intent plus the placement settings, the live canvas and the viewport go
   * through the pure resolver, and the resulting plan through the
   * nested-focus boundary. Returns the committed focus target, or `null` when
   * nothing was focused (a background open, a PiP, a no-op).
   */
  readonly openTile: (intent: TileOpenIntent) => NestedFocusTarget | null;
  readonly openTileInTab: (
    tabId: string,
    node: EpicCanvasTileRef,
  ) => NestedFocusTarget | null;
  readonly openTilePreviewInTab: (
    tabId: string,
    node: EpicCanvasTileRef,
  ) => NestedFocusTarget | null;
  readonly openTileInEpic: (
    epicId: string,
    node: EpicCanvasTileRef,
  ) => NestedFocusTarget | null;
  readonly openTilePreviewInEpic: (
    epicId: string,
    node: EpicCanvasTileRef,
  ) => NestedFocusTarget | null;
}

export function useEpicTileNavigation(): EpicTileNavigation {
  const navigateNested = useEpicNestedFocusNavigation();

  const openTile = useCallback(
    (intent: TileOpenIntent): NestedFocusTarget | null => {
      // Resolve the header tab FIRST: for an `{ epicId }` target this can
      // create one, and the resolver needs THAT tab's canvas.
      const tabId =
        "tabId" in intent.target
          ? intent.target.tabId
          : useEpicCanvasStore
              .getState()
              .resolveTargetTabForEpic(intent.target.epicId, undefined);
      const store = useEpicCanvasStore.getState();
      const plan = resolveTileOpen({
        intent,
        settings: useSettingsStore.getState().tilePlacement,
        canvas: store.canvasByTabId[tabId] ?? createEmptyCanvas(),
        resolveTargetTabForEpic: () => tabId,
        // Imperative read: a placement decision is command-time, so it must
        // not pin this callback to a viewport snapshot (C10).
        singleTileViewport: isMobileViewport(),
      });
      return executeTileOpen({
        plan,
        node: intent.node,
        source: intent.source,
        store,
        navigateNested,
        epicId: store.tabsById[tabId]?.epicId ?? null,
      });
    },
    [navigateNested],
  );

  const openTileInTab = useCallback(
    (tabId: string, node: EpicCanvasTileRef): NestedFocusTarget | null => {
      const store = useEpicCanvasStore.getState();
      return openPreparedTileInTab({
        store,
        navigateNested,
        tabId,
        node,
        preview: false,
      });
    },
    [navigateNested],
  );

  const openTilePreviewInTab = useCallback(
    (tabId: string, node: EpicCanvasTileRef): NestedFocusTarget | null => {
      const store = useEpicCanvasStore.getState();
      return openPreparedTileInTab({
        store,
        navigateNested,
        tabId,
        node,
        preview: true,
      });
    },
    [navigateNested],
  );

  const openTileInEpic = useCallback(
    (epicId: string, node: EpicCanvasTileRef): NestedFocusTarget | null => {
      const tabId = useEpicCanvasStore
        .getState()
        .resolveTargetTabForEpic(epicId, undefined);
      return openTileInTab(tabId, node);
    },
    [openTileInTab],
  );

  const openTilePreviewInEpic = useCallback(
    (epicId: string, node: EpicCanvasTileRef): NestedFocusTarget | null => {
      const tabId = useEpicCanvasStore
        .getState()
        .resolveTargetTabForEpic(epicId, undefined);
      return openTilePreviewInTab(tabId, node);
    },
    [openTilePreviewInTab],
  );

  return useMemo(
    () => ({
      openTile,
      openTileInTab,
      openTilePreviewInTab,
      openTileInEpic,
      openTilePreviewInEpic,
    }),
    [
      openTile,
      openTileInEpic,
      openTileInTab,
      openTilePreviewInEpic,
      openTilePreviewInTab,
    ],
  );
}

function openPreparedTileInTab(args: {
  readonly store: EpicCanvasStore;
  readonly navigateNested: NavigateNestedFocus;
  readonly tabId: string;
  readonly node: EpicCanvasTileRef;
  readonly preview: boolean;
}): NestedFocusTarget | null {
  const epicId = args.store.tabsById[args.tabId]?.epicId ?? null;
  const prepare = () =>
    args.preview
      ? useEpicCanvasStore
          .getState()
          .prepareOpenTilePreviewInTabFocusTarget(args.tabId, args.node)
      : useEpicCanvasStore
          .getState()
          .prepareOpenTileInTabFocusTarget(args.tabId, args.node);
  if (epicId === null) return prepare();
  return args.navigateNested(epicId, args.tabId, prepare);
}
