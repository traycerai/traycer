import { useCallback, useMemo } from "react";
import {
  useEpicOpenInNewWindowFlow,
  type EpicNewWindowFlow,
} from "@/components/layout/hooks/use-epic-open-in-new-window";
import { useWindowsBridge } from "@/providers/windows-bridge-context";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { openEpicInNewWindow } from "@/lib/commands/actions/open-epic-in-new-window";
import type { HistoryItem } from "@/components/home/data/home-page.data";

export interface HistoryNewWindowFlow {
  readonly isAvailable: boolean;
  readonly requestOpen: (item: HistoryItem) => void;
  readonly epicFlow: EpicNewWindowFlow;
}

/**
 * History-row "Open in New Window" dispatcher.
 *
 * An epic already open in this window is popped out through the shared
 * `useEpicOpenInNewWindowFlow` move flow - which transfers ownership and, when
 * the epic has unsynced edits, raises the confirm dialog - instead of silently
 * focusing the current window (the old bug). Every other case (epic open only
 * in another window, or open nowhere, and all phase rows) is delegated to
 * `openEpicInNewWindow`. Phases route there too because the move flow can't
 * carry `migrationSource=phase`, and a phase is never a movable epic tab.
 *
 * The dialog is owned by the panel that calls this hook: render
 * `<UnsyncedEpicMoveDialog flow={epicFlow} />` once alongside the list.
 */
export function useHistoryOpenInNewWindowFlow(): HistoryNewWindowFlow {
  const bridge = useWindowsBridge();
  const epicFlow = useEpicOpenInNewWindowFlow();
  // Depend on the memoized action, not the whole `epicFlow` object (a fresh
  // literal each render), so `requestOpen` stays stable and the memoized rows
  // it is handed to don't re-render on every panel render.
  const requestEpicMove = epicFlow.requestOpenInNewWindow;

  const requestOpen = useCallback(
    (item: HistoryItem) => {
      if (bridge === null) return;
      if (item.taskType !== "phase") {
        const localTabId = useEpicCanvasStore
          .getState()
          .resolveTabIdForEpic(item.epicId);
        if (localTabId !== null) {
          requestEpicMove({
            epicId: item.epicId,
            tabId: localTabId,
            title: item.title,
          });
          return;
        }
      }
      void openEpicInNewWindow(bridge, {
        epicId: item.epicId,
        tabId: item.epicId,
        isPhase: item.taskType === "phase",
      });
    },
    [bridge, requestEpicMove],
  );

  // Keep a stable identity (see `useEpicOpenInNewWindowFlow`): `epicFlow` is
  // already memoized upstream, so this object only changes when availability,
  // `requestOpen`, or the underlying flow actually changes.
  return useMemo(
    () => ({
      isAvailable: bridge !== null && epicFlow.isAvailable,
      requestOpen,
      epicFlow,
    }),
    [bridge, epicFlow, requestOpen],
  );
}
