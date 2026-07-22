import { CopyPlus, ExternalLink, Pencil, X } from "lucide-react";
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
import type { HeaderTab } from "@/stores/tabs/types";
import {
  TAB_SPLIT_COMMANDS,
  resolveTabSplitCommandAvailability,
  type TabSplitCommandId,
} from "@/stores/tabs/tab-split-commands";

interface TabContextMenuContentProps {
  readonly tab: HeaderTab;
  readonly canCloseOtherTabs: boolean;
  readonly canOpenInNewWindow: boolean;
  readonly canEditTitle: boolean;
  readonly onCloseOtherTabs: (tab: HeaderTab) => void;
  readonly onDuplicateTab: (tab: HeaderTab) => void;
  readonly onOpenInNewWindow: (tab: HeaderTab) => void;
  readonly onSplitCommand: (id: TabSplitCommandId, tab: HeaderTab) => void;
  /** Switches the epic tab title into the inline editable input. */
  readonly onEditTitle: () => void;
}

export function TabContextMenuContent(
  props: TabContextMenuContentProps,
): React.ReactNode {
  const {
    tab,
    canCloseOtherTabs,
    canOpenInNewWindow,
    canEditTitle,
    onCloseOtherTabs,
    onDuplicateTab,
    onOpenInNewWindow,
    onSplitCommand,
    onEditTitle,
  } = props;

  const showDuplicate = tab.canDuplicate;
  const showOpenInNewWindow = tab.canOpenInNewWindow;
  const splitAvailability = resolveTabSplitCommandAvailability({
    kind: tab.kind,
    id: tab.id,
  });
  const showsGroupCommands =
    splitAvailability.swap ||
    splitAvailability.separate ||
    splitAvailability.closeLeft !== null ||
    splitAvailability.closeRight !== null;

  return (
    <ContextMenuContent onCloseAutoFocus={(event) => event.preventDefault()}>
      {tab.kind === "epic" && canEditTitle ? (
        <>
          <ContextMenuItem
            onSelect={onEditTitle}
            data-testid={`tab-edit-title-${tab.kind}-${tab.id}`}
          >
            <Pencil />
            Edit Title
          </ContextMenuItem>
          <ContextMenuSeparator />
        </>
      ) : null}
      {showDuplicate ? (
        <ContextMenuItem
          onSelect={() => onDuplicateTab(tab)}
          data-testid={`tab-duplicate-${tab.kind}-${tab.id}`}
        >
          <CopyPlus />
          Duplicate Tab
          <span className="ml-auto text-ui-xs text-muted-foreground">⌘⇧K</span>
        </ContextMenuItem>
      ) : null}
      {showDuplicate ? <ContextMenuSeparator /> : null}
      {showOpenInNewWindow ? (
        <ContextMenuItem
          disabled={!canOpenInNewWindow}
          onSelect={() => onOpenInNewWindow(tab)}
          data-testid={`tab-open-new-window-${tab.kind}-${tab.id}`}
        >
          <ExternalLink />
          Open in New Window
        </ContextMenuItem>
      ) : null}
      {showOpenInNewWindow ? <ContextMenuSeparator /> : null}
      <ContextMenuItem
        disabled={!splitAvailability.add}
        onSelect={() => onSplitCommand(TAB_SPLIT_COMMANDS.add.id, tab)}
        data-testid={`tab-add-split-${tab.kind}-${tab.id}`}
      >
        {TAB_SPLIT_COMMANDS.add.label}
      </ContextMenuItem>
      <ContextMenuItem
        disabled={!splitAvailability.pair}
        onSelect={() => onSplitCommand(TAB_SPLIT_COMMANDS.pair.id, tab)}
        data-testid={`tab-pair-current-${tab.kind}-${tab.id}`}
      >
        {TAB_SPLIT_COMMANDS.pair.label}
      </ContextMenuItem>
      {showsGroupCommands ? <ContextMenuSeparator /> : null}
      {showsGroupCommands ? (
        <ContextMenuItem
          disabled={!splitAvailability.swap}
          onSelect={() => onSplitCommand(TAB_SPLIT_COMMANDS.swap.id, tab)}
          data-testid={`tab-swap-split-${tab.kind}-${tab.id}`}
        >
          {TAB_SPLIT_COMMANDS.swap.label}
        </ContextMenuItem>
      ) : null}
      {showsGroupCommands ? (
        <ContextMenuItem
          disabled={!splitAvailability.separate}
          onSelect={() => onSplitCommand(TAB_SPLIT_COMMANDS.separate.id, tab)}
          data-testid={`tab-separate-split-${tab.kind}-${tab.id}`}
        >
          {TAB_SPLIT_COMMANDS.separate.label}
        </ContextMenuItem>
      ) : null}
      {showsGroupCommands ? (
        <ContextMenuItem
          disabled={splitAvailability.closeLeft === null}
          onSelect={() => onSplitCommand(TAB_SPLIT_COMMANDS.closeLeft.id, tab)}
          data-testid={`tab-close-left-${tab.kind}-${tab.id}`}
        >
          {TAB_SPLIT_COMMANDS.closeLeft.label}
        </ContextMenuItem>
      ) : null}
      {showsGroupCommands ? (
        <ContextMenuItem
          disabled={splitAvailability.closeRight === null}
          onSelect={() => onSplitCommand(TAB_SPLIT_COMMANDS.closeRight.id, tab)}
          data-testid={`tab-close-right-${tab.kind}-${tab.id}`}
        >
          {TAB_SPLIT_COMMANDS.closeRight.label}
        </ContextMenuItem>
      ) : null}
      <ContextMenuSeparator />
      <ContextMenuItem
        disabled={!canCloseOtherTabs}
        onSelect={() => onCloseOtherTabs(tab)}
        data-testid={`tab-close-others-${tab.kind}-${tab.id}`}
      >
        <X />
        Close Other Tabs
      </ContextMenuItem>
    </ContextMenuContent>
  );
}
