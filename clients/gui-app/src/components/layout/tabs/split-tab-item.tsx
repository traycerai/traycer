import { memo, useCallback, useMemo, type ReactNode } from "react";
import { useDroppable } from "@dnd-kit/core";
import * as m from "motion/react-m";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
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
  SplitMemberChrome,
  TabChrome,
  TabItem,
} from "@/components/layout/tabs/tab-strip-item";
import {
  HEADER_TAB_LAYOUT_TRANSITION,
  TAB_CLASS_BASE,
} from "@/components/layout/tabs/tab-chrome-tokens";
import { SplitSlotMenuContent } from "@/components/layout/tabs/tab-strip-context-menu";

export interface SplitTabItemProps {
  readonly item: Extract<HeaderStripItem, { readonly kind: "split" }>;
  readonly stripIndex: number;
  readonly leftMemberIndex: number;
  readonly rightMemberIndex: number;
  readonly isActive: boolean;
  readonly showDropIndicatorBefore: boolean;
  readonly showDropIndicatorAfter: boolean;
  readonly onClose: (tab: HeaderTab) => void;
  readonly onCloseOtherTabs: (tab: HeaderTab) => void;
  readonly onDuplicateTab: (tab: HeaderTab) => void;
  readonly canCloseOtherTabs: boolean;
  readonly onOpenInNewWindow: (tab: HeaderTab) => void;
  readonly canOpenInNewWindow: boolean;
  readonly onSplitCommand: (id: TabSplitCommandId, tab: HeaderTab) => void;
  readonly taskPinnedStates: ReadonlyMap<string, boolean>;
  readonly pendingSetPinnedEpicIds: ReadonlySet<string>;
  readonly onSetTaskPinned: (
    epicId: string,
    pinned: boolean,
    displayName: string,
  ) => void;
}

/**
 * A split group occupies exactly one ordinary tab's footprint and draws exactly
 * one tab silhouette around both halves. Earlier this was a rounded bordered
 * box holding two members that each drew their own chrome, which nested a
 * second outline inside the first and made a group read as a foreign object in
 * the strip rather than as a tab.
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
      // HeaderTabMotionFrame's frame at double width: a group holds two titles,
      // so it earns two tab footprints. Every value here is exactly 2x the
      // single-tab frame, keeping a group's flex behaviour proportional to an
      // ordinary tab's instead of a separate rule.
      className="relative flex w-[28rem] min-w-[240px] max-w-[28rem] flex-[1_1_28rem] items-end [container-type:inline-size]"
    >
      {/*
        The shared silhouette's end caps flare over the outer ~20px, so the
        halves are inset by a tab's own side padding. Without it the leading
        half's label and focus wash ride on top of the cap curve and read as
        overlapping chrome.
      */}
      <div className="relative flex h-10 w-full min-w-0 items-center px-[clamp(0.75rem,5%,1.5rem)]">
        {/*
          Only the active silhouette is shared. Hover feedback stays per-half
          (see SplitMemberChrome) because pointing at one side and lighting up
          both would misreport which side a click lands on.
        */}
        {props.isActive ? <TabChrome isActive /> : null}
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
        <span
          aria-hidden
          data-testid={`split-tab-divider-${props.item.id}`}
          className="relative z-20 my-2 w-px shrink-0 self-stretch bg-border/70"
        />
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
    </m.div>
  );
});

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
  readonly taskPinnedStates: ReadonlyMap<string, boolean>;
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
        taskPinned={
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
        "cursor-pointer gap-1 px-1.5 text-muted-foreground",
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
