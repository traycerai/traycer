import {
  ArrowLeftRight,
  CopyPlus,
  ExternalLink,
  Maximize2,
  PanelLeftClose,
  PanelRightClose,
  Pencil,
  Pin,
  SplitSquareHorizontal,
  X,
} from "lucide-react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { ShortcutHint } from "@/components/ui/shortcut-hint";
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import type { HeaderTab } from "@/stores/tabs/types";
import {
  TAB_SPLIT_COMMANDS,
  resolveTabSplitCommandAvailability,
  type TabSplitCommandAvailability,
  type TabSplitCommandId,
} from "@/stores/tabs/tab-split-commands";

interface TabContextMenuContentProps {
  readonly tab: HeaderTab;
  readonly canCloseOtherTabs: boolean;
  readonly canOpenInNewWindow: boolean;
  readonly canEditTitle: boolean;
  readonly taskPinned: boolean | null;
  readonly isTaskPinPending: boolean;
  readonly onCloseOtherTabs: (tab: HeaderTab) => void;
  readonly onDuplicateTab: (tab: HeaderTab) => void;
  readonly onOpenInNewWindow: (tab: HeaderTab) => void;
  readonly onSplitCommand: (id: TabSplitCommandId, tab: HeaderTab) => void;
  /** Switches the epic tab title into the inline editable input. */
  readonly onEditTitle: () => void;
  readonly onSetTaskPinned: (pinned: boolean) => void;
}

export function TabContextMenuContent(
  props: TabContextMenuContentProps,
): React.ReactNode {
  const {
    tab,
    canCloseOtherTabs,
    canOpenInNewWindow,
    canEditTitle,
    taskPinned,
    isTaskPinPending,
    onCloseOtherTabs,
    onDuplicateTab,
    onOpenInNewWindow,
    onSplitCommand,
    onEditTitle,
    onSetTaskPinned,
  } = props;

  const showDuplicate = tab.canDuplicate;
  const showOpenInNewWindow = tab.canOpenInNewWindow;

  return (
    <ContextMenuContent onCloseAutoFocus={(event) => event.preventDefault()}>
      {tab.kind === "epic" ? (
        <>
          {canEditTitle ? (
            <ContextMenuItem
              onSelect={onEditTitle}
              data-testid={`tab-edit-title-${tab.kind}-${tab.id}`}
            >
              <Pencil />
              Edit Title
            </ContextMenuItem>
          ) : null}
          <ContextMenuItem
            disabled={taskPinned === null || isTaskPinPending}
            onSelect={() => {
              if (taskPinned === null) return;
              onSetTaskPinned(!taskPinned);
            }}
            data-testid={`tab-pin-history-${tab.id}`}
          >
            <Pin className={taskPinned === true ? "fill-current" : undefined} />
            {taskPinned === true
              ? "Unpin Task in History"
              : "Pin Task in History"}
            {taskPinned === null || isTaskPinPending ? (
              <AgentSpinningDots
                className="ml-auto text-muted-foreground"
                testId={`tab-pin-history-spinner-${tab.id}`}
                variant={undefined}
              />
            ) : null}
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
          <ShortcutHint>
            <span className="ml-auto text-ui-xs text-muted-foreground">
              ⌘⇧K
            </span>
          </ShortcutHint>
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
      <TabSplitMenuItems tab={tab} onSplitCommand={onSplitCommand} />
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

/**
 * The split-command section. Availability is resolved here at render time so
 * the menu reflects the live layout. Group-scoped commands remain directly in
 * the main menu: in a split, the creation commands above them are disabled, so
 * a second arrangement submenu only adds an unnecessary navigation step.
 */
function TabSplitMenuItems(props: {
  readonly tab: HeaderTab;
  readonly onSplitCommand: (id: TabSplitCommandId, tab: HeaderTab) => void;
}): React.ReactNode {
  const { tab, onSplitCommand } = props;
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
    <>
      <ContextMenuItem
        disabled={!splitAvailability.add}
        onSelect={() => onSplitCommand(TAB_SPLIT_COMMANDS.add.id, tab)}
        data-testid={`tab-add-split-${tab.kind}-${tab.id}`}
      >
        <SplitSquareHorizontal />
        {TAB_SPLIT_COMMANDS.add.label}
      </ContextMenuItem>
      <ContextMenuItem
        disabled={!splitAvailability.pair}
        onSelect={() => onSplitCommand(TAB_SPLIT_COMMANDS.pair.id, tab)}
        data-testid={`tab-pair-current-${tab.kind}-${tab.id}`}
      >
        {TAB_SPLIT_COMMANDS.pair.label}
      </ContextMenuItem>
      {showsGroupCommands ? (
        <>
          <ContextMenuSeparator />
          <TabSplitArrangeItems
            tab={tab}
            availability={splitAvailability}
            onSplitCommand={onSplitCommand}
          />
        </>
      ) : null}
    </>
  );
}

/**
 * The four group-scoped verbs, ordered to match the platform browser: separate,
 * then the per-side closes, then reverse. Shared verbatim by the arrange
 * submenu and by an empty half's own menu, so the two can never drift.
 */
function TabSplitArrangeItems(props: {
  readonly tab: HeaderTab;
  readonly availability: TabSplitCommandAvailability;
  readonly onSplitCommand: (id: TabSplitCommandId, tab: HeaderTab) => void;
}): React.ReactNode {
  const { tab, availability, onSplitCommand } = props;
  return (
    <>
      <ContextMenuItem
        disabled={!availability.separate}
        onSelect={() => onSplitCommand(TAB_SPLIT_COMMANDS.separate.id, tab)}
        data-testid={`tab-separate-split-${tab.kind}-${tab.id}`}
      >
        <Maximize2 />
        {TAB_SPLIT_COMMANDS.separate.label}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem
        disabled={availability.closeLeft === null}
        onSelect={() => onSplitCommand(TAB_SPLIT_COMMANDS.closeLeft.id, tab)}
        data-testid={`tab-close-left-${tab.kind}-${tab.id}`}
      >
        <PanelLeftClose />
        {TAB_SPLIT_COMMANDS.closeLeft.label}
      </ContextMenuItem>
      <ContextMenuItem
        disabled={availability.closeRight === null}
        onSelect={() => onSplitCommand(TAB_SPLIT_COMMANDS.closeRight.id, tab)}
        data-testid={`tab-close-right-${tab.kind}-${tab.id}`}
      >
        <PanelRightClose />
        {TAB_SPLIT_COMMANDS.closeRight.label}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem
        disabled={!availability.swap}
        onSelect={() => onSplitCommand(TAB_SPLIT_COMMANDS.swap.id, tab)}
        data-testid={`tab-swap-split-${tab.kind}-${tab.id}`}
      >
        <ArrowLeftRight />
        {TAB_SPLIT_COMMANDS.swap.label}
      </ContextMenuItem>
    </>
  );
}

/**
 * Menu for a split group's empty half. That half has no tab of its own, so the
 * commands resolve against the populated partner - which names the same group -
 * and are shown flat rather than nested, since the menu is already scoped to
 * this split. Without it, right-clicking a "Choose view" half did nothing.
 */
export function SplitSlotMenuContent(props: {
  readonly partner: HeaderTab;
  readonly onSplitCommand: (id: TabSplitCommandId, tab: HeaderTab) => void;
}): React.ReactNode {
  const availability = resolveTabSplitCommandAvailability({
    kind: props.partner.kind,
    id: props.partner.id,
  });
  return (
    <ContextMenuContent onCloseAutoFocus={(event) => event.preventDefault()}>
      <TabSplitArrangeItems
        tab={props.partner}
        availability={availability}
        onSplitCommand={props.onSplitCommand}
      />
    </ContextMenuContent>
  );
}

/** Click-menu counterpart to the flattened context-menu arrangement section. */
export function SplitQuickActionsMenuContent(props: {
  readonly tab: HeaderTab;
  readonly onSplitCommand: (id: TabSplitCommandId, tab: HeaderTab) => void;
}): React.ReactNode {
  const availability = resolveTabSplitCommandAvailability({
    kind: props.tab.kind,
    id: props.tab.id,
  });
  return (
    <DropdownMenuContent
      align="start"
      className="w-52"
      onCloseAutoFocus={(event) => event.preventDefault()}
    >
      <DropdownMenuItem
        disabled={!availability.separate}
        onSelect={() =>
          props.onSplitCommand(TAB_SPLIT_COMMANDS.separate.id, props.tab)
        }
        data-testid={`split-quick-separate-${props.tab.kind}-${props.tab.id}`}
      >
        <Maximize2 />
        {TAB_SPLIT_COMMANDS.separate.label}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        disabled={availability.closeLeft === null}
        onSelect={() =>
          props.onSplitCommand(TAB_SPLIT_COMMANDS.closeLeft.id, props.tab)
        }
        data-testid={`split-quick-close-left-${props.tab.kind}-${props.tab.id}`}
      >
        <PanelLeftClose />
        {TAB_SPLIT_COMMANDS.closeLeft.label}
      </DropdownMenuItem>
      <DropdownMenuItem
        disabled={availability.closeRight === null}
        onSelect={() =>
          props.onSplitCommand(TAB_SPLIT_COMMANDS.closeRight.id, props.tab)
        }
        data-testid={`split-quick-close-right-${props.tab.kind}-${props.tab.id}`}
      >
        <PanelRightClose />
        {TAB_SPLIT_COMMANDS.closeRight.label}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        disabled={!availability.swap}
        onSelect={() =>
          props.onSplitCommand(TAB_SPLIT_COMMANDS.swap.id, props.tab)
        }
        data-testid={`split-quick-swap-${props.tab.kind}-${props.tab.id}`}
      >
        <ArrowLeftRight />
        {TAB_SPLIT_COMMANDS.swap.label}
      </DropdownMenuItem>
    </DropdownMenuContent>
  );
}
