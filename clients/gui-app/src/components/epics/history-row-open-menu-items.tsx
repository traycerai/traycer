import type { ReactNode } from "react";
import { ArrowDownToLine, ExternalLink } from "lucide-react";
import type { HistoryItem } from "@/components/home/data/home-page.data";
import { openHistoryItemInBackground } from "@/components/epics/open-history-item-in-background";
import { ContextMenuItem } from "@/components/ui/context-menu";

// The open actions of a task row's right-click menu, shared by History and the
// start page's Current tasks so a task behaves the same wherever it is listed.

// Phases have no background-open: a phase only opens through its migration
// route (migrationSource=phase), which a plain canvas tab can't carry, so it
// would activate into the wrong (non-migration) surface. New Window stays
// available - it goes through the route.
export function HistoryOpenInBackgroundMenuItem(props: {
  readonly item: HistoryItem;
  readonly isOpen: boolean;
}): ReactNode {
  if (props.item.taskType === "phase") return null;
  return (
    <ContextMenuItem
      onSelect={() => openHistoryItemInBackground(props.item, props.isOpen)}
      disabled={props.isOpen}
      data-testid="epics-list-row-open-background"
    >
      <ArrowDownToLine className="mt-0.5 self-start" />
      <span className="flex flex-col">
        <span>Open in Background</span>
        <span hidden={!props.isOpen} className="text-ui-xs">
          Already open
        </span>
      </span>
    </ContextMenuItem>
  );
}

export function HistoryOpenInNewWindowMenuItem(props: {
  readonly onSelect: () => void;
}): ReactNode {
  return (
    <ContextMenuItem
      onSelect={props.onSelect}
      data-testid="epics-list-row-open-new-window"
    >
      <ExternalLink />
      Open in New Window
    </ContextMenuItem>
  );
}
