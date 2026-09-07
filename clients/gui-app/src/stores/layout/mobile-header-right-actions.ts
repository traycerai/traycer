import { type ReactNode } from "react";
import { useTabsStore } from "@/stores/tabs/store";
import { selectHostFocusedRef } from "@/stores/tabs/selectors";
import type { TabRef } from "@/stores/tabs/types";
import {
  epicTabRightActionsKey,
  landingTerminalRightActionsKey,
  useMobileHeaderStore,
} from "@/stores/layout/mobile-header-store";

/**
 * Which registry entry the presented surface is entitled to, or `null` where the header carries no
 * surface actions at all.
 */
export function resolveMobileHeaderRightActionsKey(
  focused: TabRef | null,
): string | null {
  if (focused === null) return null;
  switch (focused.kind) {
    case "draft":
      return landingTerminalRightActionsKey(focused.id);
    case "epic":
      return epicTabRightActionsKey(focused.id);
    case "history":
    case "settings":
      return null;
  }
}

/**
 * The right-actions node the mobile header should render right now: the presented surface's
 * registered entry, or nothing.
 */
export function useMobileHeaderRightActions(): ReactNode | null {
  const key = useTabsStore((state) =>
    resolveMobileHeaderRightActionsKey(selectHostFocusedRef(state)),
  );
  return useMobileHeaderStore((state) =>
    key === null ? null : (state.rightActionEntries.get(key) ?? null),
  );
}
