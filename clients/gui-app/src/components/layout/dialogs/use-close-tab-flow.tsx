import { batchHeaderTabRecovery } from "@/lib/tab-recovery/history";
import { useCallback, useMemo, type ReactNode } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { toast } from "sonner";
import { navigateToTabIntent } from "@/lib/tab-navigation";
import { readTabStripLayout } from "@/stores/tabs/store";
import {
  findStripItemForRef,
  flattenStripItemRefs,
  tabRefKey,
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
  readonly closeGroup: (groupId: string) => void;
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

  const finalizeCloseTab = useCallback(
    (tab: HeaderTab) => {
      if (windowsBridge !== null && isOnlyBlankStartPage(tab)) {
        void windowsBridge.requestClose(windowsBridge.windowId);
        return;
      }
      const captured = picker.capture(tab);
      closeTab(tab);
      if (tab.kind === "epic") {
        Analytics.getInstance().track(AnalyticsEvent.TabClosed, {
          target: "task",
        });
      }
      picker.navigateToCaptured(captured);
    },
    [closeTab, picker, windowsBridge],
  );

  const requestCloseTab = useCallback(
    (tab: HeaderTab) => {
      const finalize = () => finalizeCloseTab(tab);
      if (dialog.promptOrConfirm(tab, finalize)) return;
      finalize();
    },
    [dialog, finalizeCloseTab],
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
      batchHeaderTabRecovery(() => {
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
      }, layout);
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

  const closeGroup = useCallback(
    (groupId: string) => {
      const layout = readTabStripLayout();
      const members = getHeaderTabs().filter(
        (tab) => layout.customizations?.[tabRefKey(tab)]?.groupId === groupId,
      );
      const active = members.find((tab) => tabMatchesPath(tab, activePathname));
      const finalize = () => {
        let skipped = 0;
        // Do not keep a global batch open while the dialog waits: unrelated
        // closes must stay separate. Only confirmed group closes run here.
        batchHeaderTabRecovery(() => {
          for (const tab of members) {
            if (tab === active) continue;
            if (tabRequiresCloseConfirm(tab)) {
              skipped += 1;
              continue;
            }
            closeTab(tab);
          }
          if (
            active !== undefined &&
            getHeaderTabs().some((tab) => tabRefKey(tab) === tabRefKey(active))
          ) {
            // Capture the neighbor after the other group members are gone.
            finalizeCloseTab(active);
          }
        }, readTabStripLayout());
        if (skipped > 0)
          toast.warning(`Kept ${skipped} tabs open with unsynced edits`, {
            description:
              "Close those tabs individually to discard their edits.",
          });
      };
      if (active !== undefined && dialog.promptOrConfirm(active, finalize))
        return;
      finalize();
    },
    [activePathname, closeTab, dialog, finalizeCloseTab],
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
      closeGroup,
      unsyncedDialog: dialog.dialog,
    }),
    [
      closeActiveTab,
      closeGroup,
      closeOtherTabs,
      dialog.dialog,
      requestCloseTab,
    ],
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
