import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import {
  LANDING_ROUTE,
  epicPathname,
  readActiveEpicIdFromPath,
  readActiveEpicTabIdFromPath,
} from "@/lib/routes";
import {
  existingEpicTabIntent,
  navigateToTabIntent,
} from "@/lib/tab-navigation";
import { getDesktopEpicOwnershipBridge } from "@/lib/windows/desktop-epic-ownership";
import {
  epicHasUnsyncedEdits,
  getOpenEpicRegistry,
  releaseOpenEpicSession,
} from "@/lib/registries/epic-session-registry";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";

export interface EpicNewWindowRequest {
  readonly epicId: string;
  readonly tabId: string;
  readonly title: string;
}

export interface EpicNewWindowFlow {
  readonly isAvailable: boolean;
  readonly pendingMove: EpicNewWindowRequest | null;
  readonly requestOpenInNewWindow: (request: EpicNewWindowRequest) => void;
  readonly waitForSync: () => void;
  readonly cancelMove: () => void;
  readonly discardAndMove: () => void;
}

export function useEpicOpenInNewWindowFlow(): EpicNewWindowFlow {
  const navigate = useNavigate();
  const activePathname = useRouterState({
    select: (s) => s.location.pathname,
  });
  const discardTabState = useEpicCanvasStore((state) => state.discardTabState);
  const [pendingMove, setPendingMove] = useState<EpicNewWindowRequest | null>(
    null,
  );
  const [queuedMove, setQueuedMove] = useState<EpicNewWindowRequest | null>(
    null,
  );
  const isAvailable = getDesktopEpicOwnershipBridge() !== null;

  const executeMove = useCallback(
    (request: EpicNewWindowRequest, discardUnsyncedEdits: boolean) => {
      const bridge = getDesktopEpicOwnershipBridge();
      if (bridge === null) return;
      if (discardUnsyncedEdits) {
        const handle = getOpenEpicRegistry().get(request.epicId);
        handle?.store.getState().discardUnsyncedEdits();
      }
      const stateBeforeMove = useEpicCanvasStore.getState();
      const tabsBeforeMove = stateBeforeMove.openTabOrder.flatMap((tabId) => {
        const tab = stateBeforeMove.tabsById[tabId];
        return tab === undefined ? [] : [tab];
      });
      void bridge
        .requestOpenEpicInNewWindow(
          request.epicId,
          request.title,
          request.tabId,
        )
        .then((result) => {
          if (result.result !== "moved") return;
          discardTabState(request.tabId);
          if (
            !tabsBeforeMove.some(
              (tab) =>
                tab.tabId !== request.tabId && tab.epicId === request.epicId,
            )
          ) {
            releaseOpenEpicSession(request.epicId);
          }
          const movingPath = epicPathname({
            tabId: request.tabId,
            epicId: request.epicId,
          });
          const activeRouteEpicId = readActiveEpicIdFromPath(activePathname);
          const activeRouteTabId = readActiveEpicTabIdFromPath(activePathname);
          const movingTabIsActive =
            activePathname === movingPath ||
            (activeRouteEpicId === request.epicId &&
              (activeRouteTabId ?? request.tabId) === request.tabId);
          if (!movingTabIsActive) {
            return;
          }
          const fallbackTab = tabsBeforeMove
            .filter((tab) => tab.tabId !== request.tabId)
            .at(-1);
          if (fallbackTab === undefined) {
            void navigate(LANDING_ROUTE);
            return;
          }
          navigateToTabIntent(
            navigate,
            existingEpicTabIntent({
              epicId: fallbackTab.epicId,
              tabId: fallbackTab.tabId,
              focus: undefined,
            }),
          );
        });
    },
    [activePathname, discardTabState, navigate],
  );

  const requestOpenInNewWindow = useCallback(
    (request: EpicNewWindowRequest) => {
      if (getDesktopEpicOwnershipBridge() === null) return;
      if (epicHasUnsyncedEdits(request.epicId)) {
        setPendingMove(request);
        return;
      }
      executeMove(request, false);
    },
    [executeMove],
  );

  const waitForSync = useCallback(() => {
    const request = pendingMove;
    if (request === null) return;
    setPendingMove(null);
    if (!epicHasUnsyncedEdits(request.epicId)) {
      executeMove(request, false);
      return;
    }
    setQueuedMove(request);
  }, [executeMove, pendingMove]);

  const cancelMove = useCallback(() => {
    setPendingMove(null);
  }, []);

  const discardAndMove = useCallback(() => {
    const request = pendingMove;
    if (request === null) return;
    setPendingMove(null);
    setQueuedMove((current) =>
      current?.tabId === request.tabId ? null : current,
    );
    executeMove(request, true);
  }, [executeMove, pendingMove]);

  useEffect(() => {
    if (queuedMove === null) return;
    const registry = getOpenEpicRegistry();
    let completed = false;
    const check = () => {
      if (completed) return;
      if (epicHasUnsyncedEdits(queuedMove.epicId)) return;
      completed = true;
      setQueuedMove((current) =>
        current?.tabId === queuedMove.tabId ? null : current,
      );
      executeMove(queuedMove, false);
    };
    const unsubscribe = registry.subscribe(check);
    check();
    return () => {
      unsubscribe();
    };
  }, [executeMove, queuedMove]);

  // Memoize so the returned flow keeps a stable identity across renders where
  // nothing it carries changed. Consumers thread it into effect deps (e.g.
  // `UnsyncedEpicMoveDialog`'s registry subscription); a fresh object each
  // render would churn those subscriptions on every unrelated re-render.
  return useMemo(
    () => ({
      isAvailable,
      pendingMove,
      requestOpenInNewWindow,
      waitForSync,
      cancelMove,
      discardAndMove,
    }),
    [
      isAvailable,
      pendingMove,
      requestOpenInNewWindow,
      waitForSync,
      cancelMove,
      discardAndMove,
    ],
  );
}
