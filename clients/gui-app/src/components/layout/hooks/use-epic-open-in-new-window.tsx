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
import {
  flushDesktopTabsPersistence,
  hasPendingDesktopTabsWrite,
} from "@/stores/tabs/desktop-tabs-persistence";
import { findStripItemForRef } from "@/stores/tabs/layout";
import type { PersistedTabStripLayout } from "@/stores/tabs/layout";
import { useTabsStore } from "@/stores/tabs/store";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";
import { isTabStructurallyLocked } from "@/stores/tabs/tab-structural-lock";
import type { TabRef } from "@/stores/tabs/types";

function currentTabsLayout(): PersistedTabStripLayout {
  const state = useTabsStore.getState();
  return {
    version: 2,
    items: state.items,
    activeItemId: state.activeItemId,
    systemTabs: state.systemTabs,
  };
}

/**
 * True when `ref` is currently part of a split item in the tab strip. Feeds
 * step 4's revalidation, where it catches both a step-2 separation that was
 * refused outright (e.g. a locked split partner - still grouped) and a
 * re-pair into a NEW split that happened while the flush await was in
 * flight. A ref absent from the layout entirely (e.g. a `useTabsStore` not
 * yet synced) is treated as not grouped - nothing here for a group to have
 * survived in.
 */
function isRefGroupedInLayout(ref: TabRef): boolean {
  const item = findStripItemForRef(currentTabsLayout(), ref);
  return item !== null && item.kind === "split";
}

/**
 * Revalidation for the grouped-move adapter's step 4: the tab must still be
 * open, unlocked, and ungrouped after the persistence flush settles - not
 * closed, not re-locked (e.g. entered a Phase migration), and not re-paired
 * into a new split by something that ran during the await. Any of these
 * means the move must abort cleanly rather than hand a stale ref to the
 * move IPC.
 */
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
      // Grouped-move adapter (renderer-only; the move IPC itself, step 5
      // below, is unchanged): a tab paired into a split cannot be handed to
      // another window still grouped, so this separates it first and makes
      // sure that separation is durably acknowledged by the T4 persistence
      // layer BEFORE the move IPC fires - otherwise a main-pushed snapshot
      // racing the move could restore the pre-separation pairing.
      void (async () => {
        const ref: TabRef = { kind: "epic", id: request.tabId };
        // Step 2: synchronous separate. `separateBeforeMove` refuses
        // identically (`{separated: false, splitId: null}`) whether the ref
        // was never grouped or is grouped but has a locked partner, so its
        // return value can't tell "fine to proceed" apart from "still
        // grouped, must abort" - step 4's revalidation below re-reads the
        // layout itself and catches a failed separation the same way it
        // catches a later re-pair, so no separate check is needed here.
        tabCommandCoordinator.separateBeforeMove(ref);
        // Step 3: flush + await the T4 acknowledgement - the move barrier.
        // Only a *genuine* write failure (the update IPC rejecting, an
        // unrecognizable acknowledgement, a stale revision) can leave the
        // separation's durability unconfirmed, so only that case aborts the
        // move. A window with no persistence controller, or one with
        // nothing pending (the separate above was a true no-op), has
        // nothing that could race the move with a stale main-pushed
        // snapshot - skip the flush/abort dance entirely in that case.
        if (hasPendingDesktopTabsWrite()) {
          const flushed = await flushDesktopTabsPersistence().then(
            () => true,
            () => false,
          );
          if (!flushed) return;
        }
        // Step 4: revalidate - abort if anything changed the ref's status
        // while the flush was in flight (closed, re-locked, re-paired), or
        // if step 2's separation was refused outright (e.g. a locked split
        // partner) and the ref is still grouped.
        if (!isOrdinaryMovableEpicTab(request.tabId)) return;
        // Step 5: the existing, UNCHANGED move IPC.
        const result = await bridge.requestOpenEpicInNewWindow(
          request.epicId,
          request.title,
          request.tabId,
        );
        if (result.result !== "moved") return;
        // Step 6: post-move removal routed through the coordinator (which
        // applies its own echo suppression around the same underlying
        // `discardTabState` source mutation) instead of calling the source
        // store directly. `removeMovedRef` only acts when the coordinator's
        // OWN layout still tracks this ref; fall back to a direct
        // `discardTabState` so a moved epic's now-dangling canvas-store
        // record is never left behind even when the strip layout doesn't
        // (yet) know about it.
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
      })();
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
