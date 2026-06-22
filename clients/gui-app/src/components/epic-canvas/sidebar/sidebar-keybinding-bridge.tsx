import { useCallback } from "react";
import { useActivePaneEffect } from "@/components/epic-tabs/pane-visibility-context";
import { registerDynamicActionHandler } from "@/lib/keybindings/dispatch";
import { useLeftPanelStore } from "@/stores/epics/left-panel-store";

/**
 * Bridges the configurable left-panel toggle action into the global keybinding
 * registry. When rendered inside a keep-alive pane, `useActivePaneEffect`
 * keeps only the visible pane registered; in the hoisted sidebar column it
 * defaults to active.
 */
export function SidebarKeybindingBridge(props: { readonly tabId: string }) {
  const toggleMainCollapsed = useLeftPanelStore((s) => s.toggleMainCollapsed);
  const registerVisibleSidebarToggle = useCallback(
    () =>
      registerDynamicActionHandler("app.sidebar.toggle", () => {
        toggleMainCollapsed(props.tabId);
      }),
    [props.tabId, toggleMainCollapsed],
  );
  useActivePaneEffect(registerVisibleSidebarToggle);
  return null;
}
