import { useCallback, useMemo } from "react";
import { useEpicNestedFocusNavigation } from "@/hooks/epic/use-epic-nested-focus-navigation";
import type { NavigateNestedFocus } from "@/lib/epic-nested-focus-navigation";
import type { NestedFocusTarget } from "@/lib/epic-nested-focus-route";
import {
  useEpicCanvasStore,
  type EpicCanvasStore,
} from "@/stores/epics/canvas/store";
import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";

export interface EpicTileNavigation {
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
      openTileInTab,
      openTilePreviewInTab,
      openTileInEpic,
      openTilePreviewInEpic,
    }),
    [
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
