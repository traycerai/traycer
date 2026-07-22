import { memo, useMemo, type ReactNode } from "react";
import { useDroppable } from "@dnd-kit/core";
import * as m from "motion/react-m";
import { Button } from "@/components/ui/button";
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
import type { HeaderTab } from "@/stores/tabs/types";
import type { TabSplitCommandId } from "@/stores/tabs/tab-split-commands";
import { TabItem } from "@/components/layout/tabs/tab-strip-item";

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
}

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
      transition={{ type: "spring", stiffness: 520, damping: 42, mass: 0.72 }}
      role="group"
      aria-label="Split tab group"
      data-testid={`split-tab-group-${props.item.id}`}
      data-active={props.isActive ? "true" : "false"}
      className={cn(
        "relative flex min-w-[min(42vw,16rem)] max-w-[min(68vw,32rem)] flex-[1_1_20rem] overflow-hidden rounded-md border border-border bg-background",
        props.isActive && "ring-2 ring-primary/70",
      )}
    >
      <SplitMember
        member={props.item.left}
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
      />
      <SplitMember
        member={props.item.right}
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
      />
    </m.div>
  );
});

interface SplitMemberProps {
  readonly member: HeaderStripMember;
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
      <Button
        type="button"
        role="tab"
        variant="ghost"
        aria-selected={props.focused}
        aria-label={
          props.member.slot.kind === "unavailable"
            ? props.member.slot.label
            : "Choose a view for this split side"
        }
        data-testid={`split-tab-placeholder-${props.side}`}
        onClick={() =>
          tabCommandCoordinator.focusSplitSide({
            splitId: props.stripItemId,
            side: props.side,
          })
        }
        onFocus={() =>
          tabCommandCoordinator.focusSplitSide({
            splitId: props.stripItemId,
            side: props.side,
          })
        }
        className={cn(
          "min-w-0 flex-1 rounded-none border-r border-border px-2 text-ui-xs",
          props.side === "right" && "border-r-0",
          props.focused && "bg-accent text-accent-foreground",
        )}
      >
        {props.member.slot.kind === "unavailable"
          ? props.member.slot.label
          : "Choose view"}
      </Button>
    );
  }
  return (
    <div
      className={cn(
        "min-w-0 flex-1 border-r border-border",
        props.side === "right" && "border-r-0",
        props.focused && "bg-accent/40",
      )}
    >
      <TabItem
        tab={props.member.tab}
        index={props.memberIndex}
        dnd={dnd}
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
      />
    </div>
  );
}
