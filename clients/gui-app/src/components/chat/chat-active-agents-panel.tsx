import { useState } from "react";
import { ChevronDown } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { LivePulse } from "@/components/ui/live-pulse";
import { useChatDockSectionAttached } from "@/components/chat/chat-dock-compact-context";
import { ChatDockAttachedPanelBody } from "@/components/chat/chat-dock-attached-panel";
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
  readonly viewTabId: string;
  readonly self: AgentRow;
  readonly descendants: ReadonlyArray<AgentRow>;
  readonly scrollRegionMaxHeightClass: string;
  /** A hairline above this panel, because a sibling drew before it in the
   *  dock's shared frame (L-97). */
  readonly separated: boolean;
}) {
  // Attached above the composer because its pill is the open one (L-142).
  const attached = useChatDockSectionAttached("activeAgents");
  const [open, setOpen] = useState(false);
  // The root agent counts as running too when it is itself active (not just
  // idling while its sub-agents work).
  const runningCount =
    props.descendants.length + (props.self.activity === false ? 0 : 1);

  const list = (
    <AgentStopList
      epicId={props.epicId}
      viewTabId={props.viewTabId}
      self={props.self}
      descendants={props.descendants}
      surface="composer-panel"
    />
  );

  if (attached) {
    // No portalled action, and that is this panel's own long-standing rule
    // rather than an omission: "Stop all" is a COLLAPSED-header affordance,
    // and an expanded list puts the same stop on the current chat's own row,
    // where it sits beside the agent it acts on. An attached panel is expanded
    // by construction, so lifting the header button into the pill row would
    // show the same action twice.
    return (
      <ChatDockAttachedPanelBody
        section="activeAgents"
        testId="active-agents-list"
      >
        {list}
      </ChatDockAttachedPanelBody>
    );
  }

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={cn(props.separated ? "border-t border-border/50" : null)}
      data-testid="active-agents-panel"
      variant="panel"
    >
      <div className="flex items-stretch">
        <ActiveAgentsHeader open={open} runningCount={runningCount} />
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
          data-native-scrollbar="true"
          className={cn(
            "overflow-y-auto border-t border-border/50",
            props.scrollRegionMaxHeightClass,
          )}
        >
          {list}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function ActiveAgentsHeader({
  open,
  runningCount,
}: {
  open: boolean;
  runningCount: number;
}) {
  return (
    <CollapsibleTrigger
      className="group/agents flex min-w-0 flex-1 items-center text-left"
      variant="panel"
    >
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
  );
}
