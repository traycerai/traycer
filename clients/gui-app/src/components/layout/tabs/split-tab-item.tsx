import { splitSlotLabel } from "./header-tab-presentation";
import type { TaskPinnedState } from "@/hooks/epic/use-epic-task-pinned-states-query";
import { memo, useCallback, useMemo, useRef, type ReactNode } from "react";
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
import { useHeaderTabDisplacement } from "./use-header-tab-displacement";
import { cn } from "@/lib/utils";
import { SplitTabLayout, SplitFocusIcon } from "./split-tab-chrome";
import { SplitFillableMemberVisual } from "./header-tab-visual";
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
  TabItem,
} from "@/components/layout/tabs/tab-strip-item";
import {
  useHeaderTabDisplacementTransition,
  splitFillableMemberClassName,
  SPLIT_TAB_CONTROL_CLASS,
} from "@/components/layout/tabs/tab-chrome-tokens";
import {
  SplitQuickActionsMenuContent,
  SplitSlotMenuContent,
} from "@/components/layout/tabs/tab-strip-context-menu";

export interface SplitTabItemProps {
  readonly item: Extract<HeaderStripItem, { readonly kind: "split" }>;
  readonly stripIndex: number;
  readonly offsetX: number;
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

  const transition = useHeaderTabDisplacementTransition();
  // A split group is a strip item like any other, so it takes part in the
  // commit re-base like any other. It rendered its own `animate={{x}}` frame
  // and was therefore never registered - which made the widest item in the
  // strip exempt from every commit, in both directions, while its neighbours
  // were corrected.
  const frameRef = useRef<HTMLDivElement | null>(null);
  const x = useHeaderTabDisplacement({
    nodeRef: frameRef,
    offsetX: props.offsetX,
    transition,
  });
  const setFrameRef = useCallback(
    (node: HTMLDivElement | null) => {
      frameRef.current = node;
      setNodeRef(node);
    },
    [setNodeRef],
  );
  return (
    <m.div
      ref={setFrameRef}
      initial={false}
      animate={{ opacity: isDragging ? 0 : 1 }}
      style={{ x }}
      // Explicit x from the drag model - deliberately NOT `layout="position"`
      // plus CSS `order`. That pairing strands a translateX when the item set
      // changes under an in-flight projection; binding x to state makes the
      // class unrepresentable rather than merely currently unreachable.
      transition={transition}
      // A split group is one strip item, but it is never a merge target: the
      // pair target carries a single TabRef and a two-ref item has no
      // unambiguous one. Passing over it reorders.
      data-strip-item-id={props.item.id}
      data-strip-item-mergeable="false"
      role="group"
      aria-label="Split tab group"
      data-testid={`split-tab-group-${props.item.id}`}
      data-active={props.isActive ? "true" : "false"}
      // Two ordinary tab footprints plus the leading quick-actions control.
      // The extra width keeps that control from stealing either title's
      // share. Capped by viewport width (not just the rem ceiling) so the
      // frame stays fluid on narrow windows instead of pinning to 31rem.
      className="relative flex w-[min(60vw,31rem)] min-w-[min(60vw,26.25rem)] max-w-[min(60vw,31rem)] flex-[1_1_min(60vw,31rem)] items-end [container-type:inline-size]"
    >
      <SplitTabLayout
        leftColor={memberTab(props.item.left)?.appearance?.color ?? null}
        rightColor={memberTab(props.item.right)?.appearance?.color ?? null}
        splitId={props.item.id}
        selectedSide={props.isActive ? props.item.focusedSide : null}
        control={
          quickActionsTab === null ? null : (
            <SplitQuickActions
              splitId={props.item.id}
              tab={quickActionsTab}
              focusedSide={props.item.focusedSide}
              engaged={props.isActive}
              onSplitCommand={props.onSplitCommand}
            />
          )
        }
        left={
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
        }
        right={
          <SplitMember
            member={props.item.right}
            partner={memberTab(props.item.left)}
            side="right"
            focused={
              props.isActive ? props.item.focusedSide === "right" : false
            }
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
        }
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
            SPLIT_TAB_CONTROL_CLASS,
            "hover:bg-accent/60 [-webkit-app-region:no-drag]",
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
    <TabItem
      tab={props.member.tab}
      index={props.memberIndex}
      dnd={dnd}
      chrome="member"
      includeMotionFrame={false}
      offsetX={0}
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
  const label = splitSlotLabel(props.slot);
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
        splitFillableMemberClassName(props.focused),
        "cursor-pointer [-webkit-app-region:no-drag]",
      )}
    >
      <SplitFillableMemberVisual focused={props.focused} label={label} />
    </div>
  );
  if (props.partner === null) {
    return control;
  }
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{control}</ContextMenuTrigger>
      <SplitSlotMenuContent
        partner={props.partner}
        onSplitCommand={props.onSplitCommand}
      />
    </ContextMenu>
  );
}
