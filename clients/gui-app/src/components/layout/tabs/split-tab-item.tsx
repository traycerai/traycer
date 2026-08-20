import type { TaskPinnedState } from "@/hooks/epic/use-epic-task-pinned-states-query";
import { memo, useCallback, useMemo, type ReactNode } from "react";
import { useDroppable } from "@dnd-kit/core";
import * as m from "motion/react-m";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  HEADER_TAB_SLOT_DND_TYPE,
  getHeaderStripItemSlotDropId,
  type HeaderTabSlotDropData,
} from "@/components/layout/tabs/header-tab-dnd";
import { useEpicDndStore } from "@/components/epic-canvas/dnd/dnd-store";
import { cn } from "@/lib/utils";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";
import type {
  HeaderStripItem,
  HeaderStripMember,
} from "@/stores/tabs/use-header-tabs";
import type { SplitSide } from "@/stores/tabs/layout";
import type { HeaderTab } from "@/stores/tabs/types";
import type { TabSplitCommandId } from "@/stores/tabs/tab-split-commands";
import {
  HeaderTabSeparator,
  SplitMemberChrome,
  TabItem,
} from "@/components/layout/tabs/tab-strip-item";
import {
  HEADER_TAB_LAYOUT_TRANSITION,
  TAB_CLASS_BASE,
} from "@/components/layout/tabs/tab-chrome-tokens";
import {
  SplitQuickActionsMenuContent,
  SplitSlotMenuContent,
} from "@/components/layout/tabs/tab-strip-context-menu";

export interface SplitTabItemProps {
  readonly item: Extract<HeaderStripItem, { readonly kind: "split" }>;
  readonly stripIndex: number;
  readonly leftMemberIndex: number;
  readonly rightMemberIndex: number;
  readonly isActive: boolean;
  /**
   * Draws the strip hairline at the GROUP's right edge - the boundary between
   * this group and whatever strip item follows it. Distinct from the internal
   * divider between the two halves, which is unconditional and belongs to the
   * group's own silhouette.
   */
  readonly showSeparatorAfter: boolean;
  readonly showDropIndicatorBefore: boolean;
  readonly showDropIndicatorAfter: boolean;
  readonly onClose: (tab: HeaderTab) => void;
  readonly onCloseOtherTabs: (tab: HeaderTab) => void;
  readonly onDuplicateTab: (tab: HeaderTab) => void;
  readonly canCloseOtherTabs: boolean;
  readonly onOpenInNewWindow: (tab: HeaderTab) => void;
  readonly canOpenInNewWindow: boolean;
  readonly onSplitCommand: (id: TabSplitCommandId, tab: HeaderTab) => void;
  readonly taskPinnedStates: ReadonlyMap<string, TaskPinnedState>;
  readonly pendingSetPinnedEpicIds: ReadonlySet<string>;
  readonly onSetTaskPinned: (
    epicId: string,
    pinned: boolean,
    displayName: string,
  ) => void;
}

/**
 * One reorder frame owns the split control and both members. A persistent
 * accent underline communicates their group membership, while only the
 * focused member draws ordinary selected-tab chrome.
 */
export const SplitTabItem = memo(function SplitTabItem(
  props: SplitTabItemProps,
): ReactNode {
  const dropData = useMemo<HeaderTabSlotDropData>(
    () => ({
      kind: HEADER_TAB_SLOT_DND_TYPE,
      index: props.stripIndex,
      isTrailing: false,
    }),
    [props.stripIndex],
  );
  const { setNodeRef } = useDroppable({
    id: getHeaderStripItemSlotDropId(props.item.id),
    data: dropData,
  });
  const isDragging = useEpicDndStore(
    (state) =>
      state.activeHeaderTab !== null &&
      state.activeHeaderTab.stripItemId === props.item.id,
  );
  const quickActionsTab =
    memberTab(props.item.left) ?? memberTab(props.item.right);

  return (
    <m.div
      ref={setNodeRef}
      layout="position"
      initial={false}
      animate={{ opacity: isDragging ? 0.36 : 1, scale: isDragging ? 0.96 : 1 }}
      transition={HEADER_TAB_LAYOUT_TRANSITION}
      role="group"
      aria-label="Split tab group"
      data-testid={`split-tab-group-${props.item.id}`}
      data-active={props.isActive ? "true" : "false"}
      // Two ordinary tab footprints plus the leading quick-actions control.
      // The extra width keeps that control from stealing either title's
      // share. Capped by viewport width (not just the rem ceiling) so the
      // frame stays fluid on narrow windows instead of pinning to 31rem.
      className="relative flex w-[min(60vw,31rem)] min-w-[276px] max-w-[min(60vw,31rem)] flex-[1_1_min(60vw,31rem)] items-end [container-type:inline-size]"
    >
      {/*
        The shared silhouette's end caps flare over the outer ~20px, so the
        halves are inset by a tab's own side padding. Without it the leading
        half's label and focus wash ride on top of the cap curve and read as
        overlapping chrome.
      */}
      <div className="relative flex h-10 w-full min-w-0 items-center pr-[clamp(0.75rem,5%,1.5rem)] pl-2">
        {/* Hover and selection feedback stay per-half (see SplitMemberChrome)
            so the focused member reads like the selected tab in a group. */}
        {quickActionsTab === null ? null : (
          <SplitQuickActions
            splitId={props.item.id}
            tab={quickActionsTab}
            focusedSide={props.item.focusedSide}
            engaged={props.isActive}
            onSplitCommand={props.onSplitCommand}
          />
        )}
        <SplitMember
          member={props.item.left}
          partner={memberTab(props.item.right)}
          side="left"
          focused={props.isActive ? props.item.focusedSide === "left" : false}
          stripItemId={props.item.id}
          stripIndex={props.stripIndex}
          memberIndex={props.leftMemberIndex}
          onClose={props.onClose}
          onCloseOtherTabs={props.onCloseOtherTabs}
          onDuplicateTab={props.onDuplicateTab}
          canCloseOtherTabs={props.canCloseOtherTabs}
          onOpenInNewWindow={props.onOpenInNewWindow}
          canOpenInNewWindow={props.canOpenInNewWindow}
          onSplitCommand={props.onSplitCommand}
          showDropIndicatorBefore={props.showDropIndicatorBefore}
          showDropIndicatorAfter={false}
          taskPinnedStates={props.taskPinnedStates}
          pendingSetPinnedEpicIds={props.pendingSetPinnedEpicIds}
          onSetTaskPinned={props.onSetTaskPinned}
        />
        {props.isActive ? null : (
          <span
            aria-hidden
            data-testid={`split-tab-divider-${props.item.id}`}
            className="relative z-20 my-2 w-px shrink-0 self-stretch bg-border/70"
          />
        )}
        <SplitMember
          member={props.item.right}
          partner={memberTab(props.item.left)}
          side="right"
          focused={props.isActive ? props.item.focusedSide === "right" : false}
          stripItemId={props.item.id}
          stripIndex={props.stripIndex}
          memberIndex={props.rightMemberIndex}
          onClose={props.onClose}
          onCloseOtherTabs={props.onCloseOtherTabs}
          onDuplicateTab={props.onDuplicateTab}
          canCloseOtherTabs={props.canCloseOtherTabs}
          onOpenInNewWindow={props.onOpenInNewWindow}
          canOpenInNewWindow={props.canOpenInNewWindow}
          onSplitCommand={props.onSplitCommand}
          showDropIndicatorBefore={false}
          showDropIndicatorAfter={props.showDropIndicatorAfter}
          taskPinnedStates={props.taskPinnedStates}
          pendingSetPinnedEpicIds={props.pendingSetPinnedEpicIds}
          onSetTaskPinned={props.onSetTaskPinned}
        />
      </div>
      <SplitGroupUnderline
        splitId={props.item.id}
        selectedSide={props.isActive ? props.item.focusedSide : null}
      />
      {/*
        Outside the padded inner row so it lands on the group's own right edge,
        where an ordinary tab's separator sits - not inset against the trailing
        half's label.
      */}
      <HeaderTabSeparator visible={props.showSeparatorAfter} />
    </m.div>
  );
});

function SplitGroupUnderline(props: {
  readonly splitId: string;
  readonly selectedSide: "left" | "right" | null;
}): ReactNode {
  return (
    <span
      aria-hidden="true"
      data-testid={`split-tab-group-underline-${props.splitId}`}
      className="pointer-events-none absolute inset-x-0 bottom-0 z-30 flex h-px pr-[clamp(0.75rem,5%,1.5rem)] pl-2"
    >
      <span
        data-testid={`split-tab-group-underline-control-${props.splitId}`}
        className={cn(
          "relative w-11 shrink-0 rounded-l-full bg-primary",
          props.selectedSide === "left" &&
            "after:absolute after:inset-y-0 after:-right-0.5 after:w-0.5 after:bg-primary",
        )}
      />
      <span
        data-testid={`split-tab-group-underline-left-${props.splitId}`}
        className={cn(
          "relative min-w-0 flex-1 rounded-l-full",
          props.selectedSide !== "left" && "bg-primary",
          props.selectedSide === "right" &&
            "after:absolute after:inset-y-0 after:-right-0.5 after:w-0.5 after:bg-primary",
        )}
      />
      <span
        className={cn(
          "shrink-0",
          props.selectedSide === null ? "w-px bg-primary" : "w-0",
        )}
      />
      <span
        data-testid={`split-tab-group-underline-right-${props.splitId}`}
        className={cn(
          "relative min-w-0 flex-1 rounded-r-full",
          props.selectedSide !== "right" && "bg-primary",
          props.selectedSide === "left" &&
            "before:absolute before:inset-y-0 before:-left-0.5 before:w-0.5 before:bg-primary",
        )}
      />
    </span>
  );
}

function SplitQuickActions(props: {
  readonly splitId: string;
  readonly tab: HeaderTab;
  readonly focusedSide: "left" | "right";
  readonly engaged: boolean;
  readonly onSplitCommand: (id: TabSplitCommandId, tab: HeaderTab) => void;
}): ReactNode {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label={`Split view actions, ${props.focusedSide} view focused`}
          data-testid={`split-quick-actions-${props.splitId}`}
          className={cn(
            "relative z-20 mr-1 h-7 w-10 shrink-0 rounded-md hover:bg-accent/60 [-webkit-app-region:no-drag]",
            props.engaged
              ? "text-blue-600 hover:text-blue-500 dark:text-blue-300 dark:hover:text-blue-200"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <SplitFocusIcon
            splitId={props.splitId}
            focusedSide={props.focusedSide}
          />
        </Button>
      </DropdownMenuTrigger>
      <SplitQuickActionsMenuContent
        tab={props.tab}
        onSplitCommand={props.onSplitCommand}
      />
    </DropdownMenu>
  );
}

function SplitFocusIcon(props: {
  readonly splitId: string;
  readonly focusedSide: "left" | "right";
}): ReactNode {
  const leftFocused = props.focusedSide === "left";

  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      data-testid={`split-focus-indicator-${props.splitId}`}
      data-focused-side={props.focusedSide}
      className="size-5"
    >
      <rect
        data-split-pane="left"
        data-focused={leftFocused ? "true" : "false"}
        x="3"
        y="4"
        width="8"
        height="16"
        rx="1.5"
        fill={leftFocused ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth="1.75"
      />
      <rect
        data-split-pane="right"
        data-focused={leftFocused ? "false" : "true"}
        x="13"
        y="4"
        width="8"
        height="16"
        rx="1.5"
        fill={leftFocused ? "none" : "currentColor"}
        stroke="currentColor"
        strokeWidth="1.75"
      />
    </svg>
  );
}

function memberTab(member: HeaderStripMember): HeaderTab | null {
  return member.kind === "tab" ? member.tab : null;
}

interface SplitMemberProps {
  readonly member: HeaderStripMember;
  /** The other half's tab, used to scope an empty half's own menu. */
  readonly partner: HeaderTab | null;
  readonly side: "left" | "right";
  readonly focused: boolean;
  readonly stripItemId: string;
  readonly stripIndex: number;
  readonly memberIndex: number;
  readonly onClose: (tab: HeaderTab) => void;
  readonly onCloseOtherTabs: (tab: HeaderTab) => void;
  readonly onDuplicateTab: (tab: HeaderTab) => void;
  readonly canCloseOtherTabs: boolean;
  readonly onOpenInNewWindow: (tab: HeaderTab) => void;
  readonly canOpenInNewWindow: boolean;
  readonly onSplitCommand: (id: TabSplitCommandId, tab: HeaderTab) => void;
  readonly showDropIndicatorBefore: boolean;
  readonly showDropIndicatorAfter: boolean;
  readonly taskPinnedStates: ReadonlyMap<string, TaskPinnedState>;
  readonly pendingSetPinnedEpicIds: ReadonlySet<string>;
  readonly onSetTaskPinned: (
    epicId: string,
    pinned: boolean,
    displayName: string,
  ) => void;
}

function SplitMember(props: SplitMemberProps): ReactNode {
  const dnd = useMemo(
    () => ({
      stripItemId: props.stripItemId,
      index: props.stripIndex,
      isDropSlot: false,
    }),
    [props.stripIndex, props.stripItemId],
  );
  if (props.member.kind === "fillable") {
    return (
      <SplitFillableMember
        slot={props.member.slot}
        side={props.side}
        focused={props.focused}
        stripItemId={props.stripItemId}
        partner={props.partner}
        onSplitCommand={props.onSplitCommand}
      />
    );
  }
  return (
    <div className="relative flex min-w-0 flex-1">
      <TabItem
        tab={props.member.tab}
        index={props.memberIndex}
        dnd={dnd}
        chrome="member"
        includeMotionFrame={false}
        isActive={props.focused}
        showSeparatorAfter={false}
        showDropIndicatorBefore={props.showDropIndicatorBefore}
        showDropIndicatorAfter={props.showDropIndicatorAfter}
        onClose={props.onClose}
        onCloseOtherTabs={props.onCloseOtherTabs}
        onDuplicateTab={props.onDuplicateTab}
        canCloseOtherTabs={props.canCloseOtherTabs}
        onOpenInNewWindow={props.onOpenInNewWindow}
        canOpenInNewWindow={props.canOpenInNewWindow}
        onSplitCommand={props.onSplitCommand}
        taskPinnedState={
          props.member.tab.kind === "epic"
            ? (props.taskPinnedStates.get(props.member.tab.epicId) ?? null)
            : null
        }
        isTaskPinPending={
          props.member.tab.kind === "epic" &&
          props.pendingSetPinnedEpicIds.has(props.member.tab.epicId)
        }
        onSetTaskPinned={props.onSetTaskPinned}
      />
    </div>
  );
}

function SplitFillableMember(props: {
  readonly slot: Exclude<SplitSide, { readonly kind: "tab" }>;
  readonly side: "left" | "right";
  readonly focused: boolean;
  readonly stripItemId: string;
  readonly partner: HeaderTab | null;
  readonly onSplitCommand: (id: TabSplitCommandId, tab: HeaderTab) => void;
}): ReactNode {
  const { stripItemId, side } = props;
  const focusSide = useCallback(() => {
    tabCommandCoordinator.focusSplitSide({ splitId: stripItemId, side });
  }, [side, stripItemId]);
  const unavailable = props.slot.kind === "unavailable";
  const label = unavailable ? props.slot.label : "Choose view";
  const control = (
    <div
      role="tab"
      tabIndex={0}
      aria-selected={props.focused}
      aria-label={unavailable ? label : "Choose a view for this split side"}
      data-testid={`split-tab-placeholder-${props.side}`}
      onClick={focusSide}
      onFocus={focusSide}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        focusSide();
      }}
      className={cn(
        TAB_CLASS_BASE,
        "cursor-pointer gap-1 text-muted-foreground",
        props.focused ? "px-5" : "px-1.5",
        "[-webkit-app-region:no-drag]",
        props.focused && "text-foreground",
      )}
    >
      <SplitMemberChrome focused={props.focused} />
      <span className="relative z-20 min-w-0 flex-1 truncate text-center italic">
        {label}
      </span>
    </div>
  );
  if (props.partner === null) {
    return <div className="relative flex min-w-0 flex-1">{control}</div>;
  }
  return (
    <div className="relative flex min-w-0 flex-1">
      <ContextMenu>
        <ContextMenuTrigger asChild>{control}</ContextMenuTrigger>
        <SplitSlotMenuContent
          partner={props.partner}
          onSplitCommand={props.onSplitCommand}
        />
      </ContextMenu>
    </div>
  );
}
