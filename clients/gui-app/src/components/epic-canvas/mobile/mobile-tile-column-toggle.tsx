import type { ReactNode } from "react";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useMobileTileColumnStore } from "@/stores/epics/mobile-tile-column-store";

/**
 * Folds the level-2 task column into the menu under the tile's name, and
 * unfolds it. Drawn only where the width offers a column: a width that draws
 * the menu or the bottom sheet of its own accord has nothing to fold. In the
 * column it sits at the end of the category row; folded, it sits at the head
 * of the pane's header beside the name that opens the menu, so each form has
 * the control once.
 */
export function MobileTileColumnToggle(props: {
  readonly offered: boolean;
}): ReactNode {
  const collapsed = useMobileTileColumnStore((state) => state.collapsed);
  const setCollapsed = useMobileTileColumnStore((state) => state.setCollapsed);
  if (!props.offered) return null;
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={collapsed ? "Show sidebar" : "Hide sidebar"}
      aria-expanded={!collapsed}
      data-testid="mobile-tile-column-toggle"
      className="shrink-0"
      onClick={() => setCollapsed(!collapsed)}
    >
      {collapsed ? (
        <PanelLeftOpen aria-hidden="true" />
      ) : (
        <PanelLeftClose aria-hidden="true" />
      )}
    </Button>
  );
}
