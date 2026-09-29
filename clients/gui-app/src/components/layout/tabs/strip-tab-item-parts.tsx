import { isPreservedOrphanEpic } from "./preserved-orphan-epic";
import { useId, useState, type ReactElement, type ReactNode } from "react";
import { useTitleBarDragSuppression } from "@/stores/layout/title-bar-drag-store";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import { TabContextMenuContent } from "@/components/layout/tabs/tab-strip-context-menu";
import type { HeaderTab } from "@/stores/tabs/types";
import type { StripTabItem, StripTabItemInput } from "./use-strip-tab-item";

/** The tab's right-click (and long-press) menu around its trigger element. */
export function StripTabContextMenu(props: {
  readonly item: Pick<
    StripTabItem,
    "displayTab" | "canEditTitle" | "rename" | "setTaskPinned"
  >;
  readonly input: StripTabItemInput;
  readonly children: ReactElement;
}): ReactNode {
  const { item, input } = props;
  // Open over a title-bar drag region (the vertical strip's spacer, the
  // header row), the menu's items must receive their clicks and a click
  // outside must dismiss it, so the drag regions stand down while it is open.
  const [open, setOpen] = useState(false);
  useTitleBarDragSuppression(`tab-menu:${useId()}`, open);
  return (
    // Edit Title's focus is `TabContextMenuContent`'s `finalFocus={false}`: the
    // closing menu does not pull focus back, so the rename input keeps the
    // focus it takes on mount instead of blurring (and `useInlineRename`
    // blur-committing) before a keystroke lands.
    <ContextMenu
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (
          !nextOpen ||
          input.tab.kind !== "epic" ||
          input.taskPinnedState?.pinnedKnown === true
        )
          return;
        if (
          (input.taskPinnedState?.home === "local" &&
            input.taskPinnedState.hostId === null) ||
          isPreservedOrphanEpic(input.tab.epicId)
        )
          return;
        input.onTaskPinMenuOpen(input.tab.epicId);
      }}
    >
      <ContextMenuTrigger render={props.children} />
      <TabContextMenuContent
        tab={item.displayTab}
        canCloseOtherTabs={input.canCloseOtherTabs}
        canOpenInNewWindow={input.canOpenInNewWindow}
        canEditTitle={item.canEditTitle}
        taskPinnedState={input.taskPinnedState}
        isTaskPinPending={input.isTaskPinPending}
        onCloseOtherTabs={input.onCloseOtherTabs}
        onDuplicateTab={input.onDuplicateTab}
        onOpenInNewWindow={input.onOpenInNewWindow}
        onSplitCommand={input.onSplitCommand}
        onEditTitle={item.rename.startEditing}
        onSetTaskPinned={item.setTaskPinned}
      />
    </ContextMenu>
  );
}

/**
 * The inline rename input. Render it only while `item.rename.isEditing`: the
 * caller owns that gate, so a visual that falls back to the label on a null
 * title control never receives an element that renders nothing.
 */
export function StripTabTitleInput(props: {
  readonly item: Pick<StripTabItem, "rename">;
  readonly tab: HeaderTab;
  readonly className: string;
}): ReactNode {
  return (
    <input
      {...props.item.rename.inputProps}
      aria-label="Edit epic title"
      data-testid={`tab-title-input-${props.tab.kind}-${props.tab.id}`}
      className={props.className}
    />
  );
}
