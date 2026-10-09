import { useEffect, type ReactNode } from "react";
import { writeArrangementField } from "@/lib/layout/arrangement-gestures";
import { ACTION_META } from "@/lib/keybindings/actions";
import { registerDynamicActionHandler } from "@/lib/keybindings/dispatch";
import { toggleVerticalTabs } from "@/lib/layout/layout-arrangement";
import { isMobileApp } from "@/lib/mobile-app";
import { useLayoutStore } from "@/stores/layout/layout-store";

/**
 * Registers "Toggle vertical tabs" with the keybinding registry: the tabs go
 * from the top to a vertical strip at the left, and from either side back to
 * the top.
 *
 * Mounted app-wide rather than by the strip, because the strip is drawn by a
 * different component in each placement and the command has to exist in both.
 * The build gate reads the action's own `desktopOnly` flag, the same fact the
 * palette filters its row on.
 *
 * The write goes through the surface placements' one writer (D14), a
 * recorded gesture, so a toggle made while the layout editor is
 * open is one Undo step that Discard takes back; with no editor open it is a
 * plain layout write.
 */
export function TabStripKeybindingBridge(): ReactNode {
  useEffect(() => {
    if (ACTION_META["app.tabs.vertical.toggle"].desktopOnly && isMobileApp()) {
      return undefined;
    }
    return registerDynamicActionHandler("app.tabs.vertical.toggle", () => {
      // Read at invocation: the handler is registered once and the
      // arrangement changes underneath it.
      writeArrangementField(
        "tabStripPlacement",
        toggleVerticalTabs(
          useLayoutStore.getState().arrangement.tabStripPlacement,
        ),
      );
    });
  }, []);
  return null;
}
