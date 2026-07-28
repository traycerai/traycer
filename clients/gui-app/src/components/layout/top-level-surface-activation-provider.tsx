import { useCallback, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { navigateToTabIntent } from "@/lib/tab-navigation";
import { tabResolveIntent } from "@/stores/tabs/registry";
import type { HeaderTab } from "@/stores/tabs/types";
import { TopLevelSurfaceActivationContext } from "./top-level-surface-activation-context";

/** Bridges a deliberate split-slot interaction into the canonical tab command. */
export function TopLevelSurfaceActivationProvider(props: {
  readonly children: ReactNode;
}): ReactNode {
  const navigate = useNavigate();
  const activate = useCallback(
    (tab: HeaderTab): void => {
      navigateToTabIntent(navigate, tabResolveIntent(tab), undefined);
    },
    [navigate],
  );

  return (
    <TopLevelSurfaceActivationContext.Provider value={activate}>
      {props.children}
    </TopLevelSurfaceActivationContext.Provider>
  );
}
