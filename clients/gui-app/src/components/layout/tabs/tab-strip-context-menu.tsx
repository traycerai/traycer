import { CopyPlus, ExternalLink, Pencil, Pin, X } from "lucide-react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
import type { HeaderTab } from "@/stores/tabs/types";

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
