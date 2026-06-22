import { useState } from "react";
import { ChevronDown } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { LivePulse } from "@/components/ui/live-pulse";
import { AgentStopList } from "@/components/chat/chat-agent-stop-list";
import { AgentStopButton } from "@/components/chat/agent-stop-button";
import type { AgentRow } from "@/hooks/agent/use-agent-stop-controls";
import { cn } from "@/lib/utils";

/**
 * Collapsible "Active agents" panel docked above the composer, mirroring
 * the Todo / Diff pinned panels. "Stop all" stops this chat + its whole
 * delegated subtree. While collapsed it sits in the header (like the
 * accumulated-changes "Undo all") for one-click access; expanding moves it down
 * onto the current chat's own row, where it belongs alongside the agent it acts
 * on, so it is never shown twice. The expanded list shows the current chat and
 * its active sub-agents, each individually stoppable on hover. Stops cascade so
 * stopping an agent also stops the agents it in turn delegated to.
 */
export function ActiveAgentsPanel(props: {
  readonly epicId: string;
  readonly self: AgentRow;
  readonly descendants: ReadonlyArray<AgentRow>;
  readonly scrollRegionMaxHeightClass: string;
  readonly separated: boolean;
}) {
  const [open, setOpen] = useState(false);
  // The root agent counts as running too when it is itself active (not just
  // idling while its sub-agents work).
  const runningCount = props.descendants.length + (props.self.active ? 1 : 0);

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={cn(
        "bg-muted/30",
        props.separated ? "border-t border-border/50" : null,
      )}
      data-testid="active-agents-panel"
    >
      <div className="flex items-stretch">
        <CollapsibleTrigger className="group/agents flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
          <ChevronDown
            aria-hidden
            className={cn(
              "size-3 shrink-0 text-muted-foreground/70 transition-transform",
              open ? null : "-rotate-90",
            )}
          />
          <LivePulse
            size="xs"
            tone="active"
            ariaLabel="Agents running"
            className={undefined}
          />
          <span className="shrink-0 text-ui-xs font-medium text-foreground/85">
            Active agents
          </span>
          <span aria-hidden className="shrink-0 text-muted-foreground/40">
            ·
          </span>
          <span className="min-w-0 flex-1 truncate text-ui-xs text-muted-foreground">
            {runningCount} running
          </span>
        </CollapsibleTrigger>
        {open ? null : (
          // Collapsed: a one-click "Stop all" lives in the header (like the
          // accumulated-changes "Undo all"). Expanding moves it onto the
          // current chat's row, so it is never shown in both places at once.
          <div className="flex shrink-0 items-center gap-1 pr-1.5">
            <AgentStopButton
              epicId={props.epicId}
              agentId={props.self.id}
              hostId={props.self.hostId}
              label="Stop all"
              iconOnly={false}
              testId="agent-stop-all"
            />
          </div>
        )}
      </div>
      <CollapsibleContent>
        <div
          data-testid="active-agents-list"
          className={cn(
            "overflow-y-auto border-t border-border/50 chat-scrollbar-native-thin",
            props.scrollRegionMaxHeightClass,
          )}
        >
          <AgentStopList
            epicId={props.epicId}
            self={props.self}
            descendants={props.descendants}
            surface="composer-panel"
          />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
