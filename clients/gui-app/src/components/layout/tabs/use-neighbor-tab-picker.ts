import { useCallback, useMemo } from "react";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { LANDING_ROUTE } from "@/lib/routes";
import { navigateToTabIntent } from "@/lib/tab-navigation";
import { pickNeighborAfterRemovingTabs } from "@/stores/tabs/neighbor";
import { tabResolveIntent } from "@/stores/tabs/registry";
import { getHeaderTabs } from "@/stores/tabs/use-header-tabs";
import type { HeaderTab } from "@/stores/tabs/types";

export interface CapturedNeighbor {
  readonly neighbor: HeaderTab | null;
  readonly wasActive: boolean;
}

export interface NeighborTabPicker {
  /**
   * Snapshot the active state and the would-be focus target BEFORE the
   * close mutation runs. Once the closing tab is gone from the strip,
   * `findIndex` can no longer recover its position.
   */
  readonly capture: (closing: HeaderTab) => CapturedNeighbor;
  /**
   * Focus the captured neighbor (or land on `/` when nothing remains)
   * iff the closing tab was active on the current route.
   */
  readonly navigateToCaptured: (captured: CapturedNeighbor) => void;
}

export function useNeighborTabPicker(): NeighborTabPicker {
  const navigate = useNavigate();
  const router = useRouter();

  const capture = useCallback(
    (closing: HeaderTab): CapturedNeighbor => {
      // `capture` runs only at close time (a user action), so read the live
      // pathname from the router then instead of subscribing. A reactive
      // `useRouterState` pathname dep rebuilt `capture` (→ the picker →
      // `closeTabFlow.requestCloseTab` → the header TabItem `onClose` prop) on
      // every navigation, re-rendering the whole strip.
      const wasActive = closing.route === router.state.location.pathname;
      const neighbor = wasActive ? pickNeighborForClose(closing) : null;
      return { neighbor, wasActive };
    },
    [router],
  );

  const navigateToCaptured = useCallback(
    (captured: CapturedNeighbor) => {
      if (!captured.wasActive) return;
      if (captured.neighbor === null) {
        void navigate(LANDING_ROUTE);
        return;
      }
      navigateToTabIntent(navigate, tabResolveIntent(captured.neighbor));
    },
    [navigate],
  );

  return useMemo(
    () => ({ capture, navigateToCaptured }),
    [capture, navigateToCaptured],
  );
}

/**
 * Pick the strip tab that should receive focus after `closingTab`
 * disappears. Reads `getHeaderTabs()` BEFORE any store mutation -
 * callers must invoke this *prior* to the kind-specific close action.
 *
 * Browser-style: focus the previous-ordered tab; if the closing tab
 * was first, focus the new first.
 */
export function pickNeighborForClose(closingTab: HeaderTab): HeaderTab | null {
  const tabs = getHeaderTabs();
  const closingIdx = tabs.findIndex(
    (t) => t.kind === closingTab.kind && t.id === closingTab.id,
  );
  return pickNeighborAfterRemovingTabs(
    tabs,
    closingIdx,
    (_tab, index) => index === closingIdx,
    () => true,
  );
}
