import { useCallback, useMemo, type ReactNode } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { toast } from "sonner";
import { navigateToTabIntent } from "@/lib/tab-navigation";
import { readTabStripLayout } from "@/stores/tabs/store";
import {
  findStripItemForRef,
  flattenStripItemRefs,
} from "@/stores/tabs/layout";
import { getHeaderTabs } from "@/stores/tabs/use-header-tabs";
import {
  tabMatchesPath,
  tabResolveIntent,
  tabRequiresCloseConfirm,
} from "@/stores/tabs/registry";
import type { HeaderTab } from "@/stores/tabs/types";
import { useTabCloseCommand } from "@/components/layout/tabs/use-tab-close-command";
import { useNeighborTabPicker } from "@/components/layout/tabs/use-neighbor-tab-picker";
import { useUnsyncedCloseDialog } from "@/components/layout/dialogs/use-unsynced-close-dialog";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import { useWindowsBridge } from "@/providers/windows-bridge-context";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { isEmptyLandingDraftContent } from "@/lib/composer/landing-draft-empty";

export interface CloseTabFlow {
  readonly requestCloseTab: (tab: HeaderTab) => void;
  readonly closeOtherTabs: (tab: HeaderTab) => void;
  readonly closeActiveTab: () => void;
  readonly unsyncedDialog: ReactNode;
}

export function useCloseTabFlow(): CloseTabFlow {
  const navigate = useNavigate();
  const closeTab = useTabCloseCommand();
  const picker = useNeighborTabPicker();
  const dialog = useUnsyncedCloseDialog();
  const windowsBridge = useWindowsBridge();
  const activePathname = useRouterState({
    select: (s) => s.location.pathname,
  });

  const requestCloseTab = useCallback(
    (tab: HeaderTab) => {
      if (windowsBridge !== null && isOnlyBlankStartPage(tab)) {
        void windowsBridge.requestClose(windowsBridge.windowId);
        return;
      }
      const captured = picker.capture(tab);
      const finalize = () => {
        closeTab(tab);
        if (tab.kind === "epic") {
          Analytics.getInstance().track(AnalyticsEvent.TabClosed, {
            target: "task",
          });
        }
        picker.navigateToCaptured(captured);
      };
      if (dialog.promptOrConfirm(tab, finalize)) return;
      finalize();
    },
    [closeTab, dialog, picker, windowsBridge],
  );

  const closeOtherTabs = useCallback(
    (target: HeaderTab) => {
      const skipped: string[] = [];
      const layout = readTabStripLayout();
      const targetItem = findStripItemForRef(layout, {
        kind: target.kind,
        id: target.id,
      });
      if (targetItem === null) return;
      const preserved = new Set(
        flattenStripItemRefs(targetItem).map((ref) => `${ref.kind}:${ref.id}`),
      );
      for (const other of getHeaderTabs()) {
        if (preserved.has(`${other.kind}:${other.id}`)) continue;
        if (tabRequiresCloseConfirm(other)) {
          skipped.push(other.name);
          continue;
        }
        closeTab(other);
        if (other.kind === "epic") {
          Analytics.getInstance().track(AnalyticsEvent.TabClosed, {
            target: "task",
          });
        }
      }
      if (skipped.length > 0) {
        const detail =
          skipped.length === 1 ? `"${skipped[0]}"` : `${skipped.length} tabs`;
        toast.warning(`Kept ${detail} open with unsynced edits`, {
          description: "Close those tabs individually to discard their edits.",
        });
      }
      navigateToTabIntent(navigate, tabResolveIntent(target), undefined);
    },
    [closeTab, navigate],
  );

  const closeActiveTab = useCallback(() => {
    // Deliberately keyed off the route, NOT `selectHostFocusedRef`. A split
    // only moves `routeBackingSide` onto the focused side when that side holds
    // a tab, so focusing the fillable half leaves the two diverged and the
    // focused ref reading `null` - which is exactly where `createEmptySplit`
    // starts ("Add tab to new split view" focuses the empty side). Gating on
    // the focused ref made Cmd+W silently do nothing there. Whenever the
    // focused side does hold a tab the two agree, so the route-backed tab is
    // the right target in both cases.
    const active = getHeaderTabs().find((t) =>
      tabMatchesPath(t, activePathname),
    );
    if (active !== undefined) requestCloseTab(active);
  }, [activePathname, requestCloseTab]);

  // Stable identity: consumers list the whole flow in `useCallback` /
  // `useEffect` deps. A fresh object literal per render gave every derived
  // handler a new identity, which defeated the memoized strip items and
  // re-registered the split action handlers on each render.
  return useMemo(
    () => ({
      requestCloseTab,
      closeOtherTabs,
      closeActiveTab,
      unsyncedDialog: dialog.dialog,
    }),
    [closeActiveTab, closeOtherTabs, dialog.dialog, requestCloseTab],
  );
}

function isOnlyBlankStartPage(tab: HeaderTab): boolean {
  if (tab.kind !== "draft") return false;
  const tabs = getHeaderTabs();
  if (tabs.length !== 1 || tabs[0]?.kind !== "draft" || tabs[0].id !== tab.id) {
    return false;
  }
  const draft = useLandingDraftStore
    .getState()
    .drafts.find((candidate) => candidate.id === tab.id);
  return draft !== undefined && isEmptyLandingDraftContent(draft.content);
}
