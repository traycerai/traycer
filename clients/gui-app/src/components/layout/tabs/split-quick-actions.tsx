import type { ReactNode } from "react";
import { useColumnOverlayPlacement } from "@/components/layout/column-edge-context";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { cn } from "@/lib/utils";
import type { TabSplitCommandId } from "@/stores/tabs/tab-split-commands";
import type { HeaderTab } from "@/stores/tabs/types";
import { SplitFocusIcon } from "./split-tab-chrome";
import { SPLIT_TAB_CONTROL_CLASS } from "./tab-chrome-tokens";
import { SplitQuickActionsMenuContent } from "./tab-strip-context-menu";

/** Where the control sits: the top bar's split item, a sidebar pair's row, or its rail tile stack. */
export type SplitQuickActionsPlacement = "top-bar" | "side-row" | "rail";

/**
 * A split's icon as a button: the focused pane filled, info blue while the
 * pair is the current task, and a click opens "Split view actions". One
 * control in both strips; only its size follows the strip.
 */
export function SplitQuickActions(props: {
  readonly splitId: string;
  readonly tab: HeaderTab;
  readonly focusedSide: "left" | "right";
  readonly engaged: boolean;
  readonly placement: SplitQuickActionsPlacement;
  readonly onSplitCommand: (id: TabSplitCommandId, tab: HeaderTab) => void;
}): ReactNode {
  const side = props.placement !== "top-bar";
  const overlay = useColumnOverlayPlacement("row");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <TooltipWrapper
          label="Split view actions"
          // Under it, clear of the halves beside it; the rail's tiles are under
          // it there, so it faces the content.
          side={
            props.placement === "rail" ? (overlay?.side ?? "right") : "bottom"
          }
          sideOffset={4}
          align={undefined}
        >
          <Button
            type="button"
            size={side ? "icon-xs" : "icon-sm"}
            variant={props.engaged ? "info-ghost" : "muted"}
            aria-label={`Split view actions, ${props.focusedSide} view focused`}
            data-testid={`split-quick-actions-${props.splitId}`}
            className={cn(
              !side && SPLIT_TAB_CONTROL_CLASS,
              "[-webkit-app-region:no-drag]",
            )}
          >
            <SplitFocusIcon
              splitId={props.splitId}
              focusedSide={props.focusedSide}
              size={side ? "size-4" : "size-5"}
            />
          </Button>
        </TooltipWrapper>
      </DropdownMenuTrigger>
      <SplitQuickActionsMenuContent
        tab={props.tab}
        onSplitCommand={props.onSplitCommand}
      />
    </DropdownMenu>
  );
}
