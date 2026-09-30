import { useColumnOverlayPlacement } from "@/components/layout/column-edge-context";
import type { ReactNode } from "react";
import {
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
} from "lucide-react";
import { HistoryNavButtons } from "@/components/layout/header/history-nav-buttons";
import { WINDOW_LEADING_INSET_CLASS } from "@/components/layout/header/title-bar-drag";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { formatChordForDisplay } from "@/lib/keybindings/chord";
import { shortcutHintsVisible } from "@/lib/keybindings/shortcut-hints";
import type { EdgeSide } from "@/lib/layout/layout-arrangement";
import { cn } from "@/lib/utils";
import { useBindingForAction } from "@/stores/settings/keybinding-store";
import { SideHomeRow } from "./side-home-row";
import {
  SideStripNavRows,
  SideStripNewTask,
  SideStripTasksLabel,
} from "./side-strip-nav-rows";
import { useLiveAgentsInStrip } from "./strip-agents-mode";
import type { SideTabRowVariant } from "./side-tab-row";
import {
  SIDE_STRIP_INSET_CLASS,
  SIDE_STRIP_RAIL_DIVIDER_CLASS,
  SIDE_STRIP_RAIL_NAV_CLASS,
} from "./side-strip-tokens";

export interface SideStripTopBlockProps {
  readonly edge: EdgeSide;
  readonly variant: SideTabRowVariant;
  /** macOS with the strip at the left: the first row is the title bar (S-04). */
  readonly ownsTitleBar: boolean;
  /** The drag-region class for the title row, or `undefined` when not frameless. */
  readonly dragClass: string | undefined;
  readonly homeTabDrawn: boolean;
  readonly homeIsActive: boolean;
  readonly onHomeTab: () => void;
  readonly onNewTab: () => void;
  /** Collapses the strip to the rail or expands it, easing the width. */
  readonly onToggleCollapsed: () => void;
  /** How many tabs the rows below list, for the "Tasks" label. */
  readonly taskCount: number;
}

/**
 * What leads in the header, in the strip (S-03). Expanded: history back and
 * forward beside the collapse toggle, the Notifications and All tasks nav rows (D6),
 * Home, New Task as the primary last row (F7), then the "Tasks" label over the
 * rows (the Activity view's section headers replace it). On macOS with the
 * strip at the left the first row is the title bar: a drag row that reserves
 * the traffic lights and puts the arrows right of them (S-04).
 *
 * Collapsed, one centred column (F1): the title bar's lights, the expand
 * toggle, Notifications, All tasks and New Task as 32px tiles 4px apart, a divider,
 * then Home as the first tile of the rail's 8px rhythm the task tiles
 * continue. The arrows are not drawn; their shortcuts still work.
 */
export function SideStripTopBlock(props: SideStripTopBlockProps): ReactNode {
  const collapsed = props.variant === "collapsed";
  // The Activity view's section headers say what the "Tasks" label does.
  const sectioned = useLiveAgentsInStrip();
  const toggle = (
    <SideStripCollapseToggle
      edge={props.edge}
      collapsed={collapsed}
      onToggle={props.onToggleCollapsed}
    />
  );
  const newTask = (
    <SideStripNewTask variant={props.variant} onNewTab={props.onNewTab} />
  );
  const home = props.homeTabDrawn ? (
    <SideHomeRow
      variant={props.variant}
      isActive={props.homeIsActive}
      onActivate={props.onHomeTab}
    />
  ) : null;
  return (
    <div
      data-testid="side-strip-top-block"
      // No bottom padding: the row list's own 8px inset below it is the gap.
      className={cn("flex shrink-0 flex-col", !collapsed && "gap-1")}
    >
      {props.ownsTitleBar ? (
        // The title bar. Its empty space is the window's drag region; the
        // leading inset clears the traffic lights, and the collapsed rail is
        // never narrower than that inset.
        <div
          data-testid="side-strip-title-row"
          className={cn(
            "flex h-10 shrink-0 items-center",
            !collapsed && SIDE_STRIP_INSET_CLASS,
            WINDOW_LEADING_INSET_CLASS,
            props.dragClass,
          )}
        >
          {collapsed ? null : <FirstRow toggle={toggle} />}
        </div>
      ) : null}
      {collapsed ? (
        <>
          <div
            className={cn(
              SIDE_STRIP_RAIL_NAV_CLASS,
              "[-webkit-app-region:no-drag]",
              !props.ownsTitleBar && "pt-2",
            )}
          >
            {toggle}
            <SideStripNavRows variant={props.variant} />
            {newTask}
          </div>
          <div
            aria-hidden
            data-testid="side-strip-rail-divider"
            className={cn(
              SIDE_STRIP_RAIL_DIVIDER_CLASS,
              "shrink-0 self-center",
              // Without Home the row list's own 8px inset is the gap below.
              home === null && "mb-0",
            )}
          />
          {home}
        </>
      ) : (
        <div
          className={cn(
            "flex flex-col gap-1",
            SIDE_STRIP_INSET_CLASS,
            !props.ownsTitleBar && "pt-2",
          )}
        >
          {props.ownsTitleBar ? null : <FirstRow toggle={toggle} />}
          <SideStripNavRows variant={props.variant} />
          {home}
          {newTask}
          {sectioned ? null : <SideStripTasksLabel count={props.taskCount} />}
        </div>
      )}
    </div>
  );
}

/** The expanded first row: the arrows at the start, the collapse toggle at the end. */
function FirstRow(props: { readonly toggle: ReactNode }): ReactNode {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1">
      <HistoryNavButtons />
      <div aria-hidden className="min-w-0 flex-1" />
      <div className="flex shrink-0 items-center [-webkit-app-region:no-drag]">
        {props.toggle}
      </div>
    </div>
  );
}

const COLLAPSE_ICON: Record<
  EdgeSide,
  {
    readonly collapse: typeof PanelLeftClose;
    readonly expand: typeof PanelLeftOpen;
  }
> = {
  left: { collapse: PanelLeftClose, expand: PanelLeftOpen },
  right: { collapse: PanelRightClose, expand: PanelRightOpen },
};

/** Collapses the strip to the rail and back (S-07, S-20); the icon mirrors for a right strip. */
function SideStripCollapseToggle(props: {
  readonly edge: EdgeSide;
  readonly collapsed: boolean;
  readonly onToggle: () => void;
}): ReactNode {
  const placement = useColumnOverlayPlacement("top");
  const label = props.collapsed ? "Expand tabs" : "Collapse tabs";
  const chord = useBindingForAction("app.tabs.vertical.collapse");
  const tooltip =
    chord === null || !shortcutHintsVisible()
      ? label
      : `${label} (${formatChordForDisplay(chord)})`;
  const icons = COLLAPSE_ICON[props.edge];
  const Icon = props.collapsed ? icons.expand : icons.collapse;
  return (
    <TooltipWrapper
      label={tooltip}
      side={placement?.side ?? "bottom"}
      sideOffset={undefined}
      align={placement?.align}
    >
      <Button
        type="button"
        variant="muted"
        size={props.collapsed ? "nav-tile" : "icon-sm"}
        aria-label={label}
        data-testid="side-tab-strip-collapse"
        data-layout-passive
        onClick={props.onToggle}
      >
        <Icon className="size-4" />
      </Button>
    </TooltipWrapper>
  );
}
