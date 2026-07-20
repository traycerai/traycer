import { useCallback, type ReactNode } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { toast } from "sonner";
import { navigateToTabIntent } from "@/lib/tab-navigation";
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
  const activePathname = useRouterState({
    select: (s) => s.location.pathname,
  });

  const requestCloseTab = useCallback(
    (tab: HeaderTab) => {
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
    [closeTab, dialog, picker],
  );

  const closeOtherTabs = useCallback(
    (target: HeaderTab) => {
      const skipped: string[] = [];
      for (const other of getHeaderTabs()) {
        if (other.kind === target.kind && other.id === target.id) continue;
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
      navigateToTabIntent(navigate, tabResolveIntent(target));
    },
    [closeTab, navigate],
  );

  const closeActiveTab = useCallback(() => {
    const active = getHeaderTabs().find((t) =>
      tabMatchesPath(t, activePathname),
    );
    if (active !== undefined) requestCloseTab(active);
  }, [activePathname, requestCloseTab]);

  return {
    requestCloseTab,
    closeOtherTabs,
    closeActiveTab,
    unsyncedDialog: dialog.dialog,
  };
}
