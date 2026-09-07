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
import { appLogger, describeLogError } from "@/lib/logger";
import { getDesktopEpicOwnershipBridge } from "@/lib/windows/desktop-epic-ownership";
import {
  epicHasUnsyncedEdits,
  getOpenEpicRegistry,
  releaseOpenEpicSession,
} from "@/lib/registries/epic-session-registry";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import {
  flushDesktopTabsPersistence,
  hasPendingDesktopTabsWrite,
} from "@/stores/tabs/desktop-tabs-persistence";
import { flushActiveDesktopPerWindowProjection } from "@/lib/windows/per-window-projection-debounce";
import {
  flushLiveReadingPositions,
  preserveReadingPositionViewsForMove,
} from "@/lib/reading-position";
import { findStripItemForRef } from "@/stores/tabs/layout";
import { readTabStripLayout } from "@/stores/tabs/store";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";
import { isTabStructurallyLocked } from "@/stores/tabs/tab-structural-lock";
import type { TabRef } from "@/stores/tabs/types";

/** Feeds step 4's revalidation, where it catches both a step-2 separation that was refused outright (e.g. a
 * locked split partner. */
export function isRefGroupedInLayout(ref: TabRef): boolean {
  const item = findStripItemForRef(readTabStripLayout(), ref);
  return item !== null && item.kind === "split";
}

/** Any of these means the move must abort cleanly rather than hand a stale ref to the move IPC. */
function isOrdinaryMovableEpicTab(tabId: string): boolean {
  if (!useEpicCanvasStore.getState().openTabOrder.includes(tabId)) {
    return false;
  }
  const ref: TabRef = { kind: "epic", id: tabId };
  if (isTabStructurallyLocked(ref)) {
    return false;
  }
  return !isRefGroupedInLayout(ref);
}

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
      const movingViewKeys = Object.keys(
        stateBeforeMove.canvasByTabId[request.tabId]?.tilesByInstanceId ?? {},
      );
      // Grouped-move adapter (renderer-only; the move IPC itself, step 5 below, is unchanged).
      void (async () => {
        const ref: TabRef = { kind: "epic", id: request.tabId };
        // Publish the source renderer's last coherent reading snapshots before any structural mutation can conceal or
        // unmount their DOM.
        flushLiveReadingPositions(request.epicId);
        // `separateBeforeMove` refuses identically (`{separated: false, splitId: null}`) whether the ref was never
        // grouped or is grouped but has a locked partner.
        tabCommandCoordinator.separateBeforeMove(ref);
        // A window with no persistence controller, or one with nothing pending (the separate above was a true no-op),
        // has nothing that could race the move with a stale main-pushed snapshot.
        if (hasPendingDesktopTabsWrite()) {
          const flushed = await flushDesktopTabsPersistence().then(
            () => true,
            () => false,
          );
          if (!flushed) return;
        }
        // Flush it independently so a just-mutated layout and its stable tile instance ids arrive before the move IPC
        // hydrates the destination renderer.
        const canvasFlushed =
          await flushActiveDesktopPerWindowProjection().then(
            () => true,
            () => false,
          );
        if (!canvasFlushed) return;
        // Step 4: revalidate - abort if anything changed the ref's status while the flush was in flight (closed,
        // re-locked, re-paired).
        if (!isOrdinaryMovableEpicTab(request.tabId)) return;
        // Step 5: the existing, unchanged move IPC.
        const result = await bridge.requestOpenEpicInNewWindow(
          request.epicId,
          request.title,
          request.tabId,
        );
        if (result.result !== "moved") return;
        preserveReadingPositionViewsForMove(movingViewKeys);
        // `removeMovedRef` only acts when the coordinator's own layout still tracks this ref.
        if (!tabCommandCoordinator.removeMovedRef(ref)) {
          useEpicCanvasStore.getState().discardTabState(ref.id);
        }
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
          undefined,
        );
      })().catch((error: unknown) => {
        // Fire-and-forget from a click handler: by the time the move IPC can reject, step 2 has already separated the
        // tab. Without this the rejection is an unhandled promise and the half-applied move leaves no trace at all.
        appLogger.warn("[windows] open epic in new window failed", {
          epicId: request.epicId,
          tabId: request.tabId,
          error: describeLogError(error),
        });
      });
    },
    [activePathname, navigate],
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

  // Consumers thread it into effect deps (e.g. `UnsyncedEpicMoveDialog`'s registry subscription); a fresh object
  // each render would churn those subscriptions on every unrelated re-render.
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
