import { useCallback } from "react";
import {
  useEpicOpenInNewWindowFlow,
  type EpicNewWindowFlow,
} from "@/components/layout/hooks/use-epic-open-in-new-window";
import { useWindowsBridge } from "@/providers/windows-bridge-context";
import { tabOpenInNewWindow } from "@/stores/tabs/registry";
import type { HeaderTab } from "@/stores/tabs/types";

export interface TabNewWindowFlow {
  readonly isAvailable: boolean;
  readonly requestOpen: (tab: HeaderTab) => void;
  readonly epicFlow: EpicNewWindowFlow;
}

/**
 * Tab-kind-aware "Open in New Window" dispatcher. Per-kind dispatch lives
 * in `tabOpenInNewWindow` (registry) - adding a new kind plugs in there
 * without touching this hook. Strip never invokes `requestOpen` for tabs
 * whose `canOpenInNewWindow` is false, so kinds that don't support
 * new-window (e.g., draft) no-op safely.
 */
export function useTabOpenInNewWindowFlow(): TabNewWindowFlow {
  const bridge = useWindowsBridge();
  const epicFlow = useEpicOpenInNewWindowFlow();

  const requestOpen = useCallback(
    (tab: HeaderTab) => {
      if (!tab.canOpenInNewWindow) return;
      if (bridge === null) return;
      tabOpenInNewWindow(tab, { bridge, epicFlow });
    },
    [bridge, epicFlow],
  );

  return {
    isAvailable: bridge !== null && epicFlow.isAvailable,
    requestOpen,
    epicFlow,
  };
}
