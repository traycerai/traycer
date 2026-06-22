import { useEffect } from "react";
import { useRouterState } from "@tanstack/react-router";
import { isHistoryPath } from "@/stores/tabs/kinds/history";
import { isSettingsPath } from "@/stores/tabs/kinds/settings";
import {
  ensureHistoryTab,
  ensureSettingsTab,
} from "@/lib/commands/actions/open-system-tab";
import { useTabsStore } from "@/stores/tabs/store";

/**
 * Auto-create the right system tab when the URL lands on a kind's
 * route without it (deep-link, back/forward, paste). Runs in the
 * committed lifecycle (`useEffect`) per workspace rule that route
 * preload paths must not mutate client state.
 */
export function useDeepLinkTabSync(): void {
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  useEffect(() => {
    if (isSettingsPath(pathname)) {
      // Make sure the settings tab exists and remembers the current path.
      ensureSettingsTab({ subSection: null, resetToGeneral: false });
      useTabsStore.getState().rememberSystemTabPath("settings", pathname);
      return;
    }
    if (isHistoryPath(pathname)) {
      ensureHistoryTab();
      useTabsStore.getState().rememberSystemTabPath("history", pathname);
      return;
    }
  }, [pathname]);
}
