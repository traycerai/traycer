import { Box, ChevronRight } from "lucide-react";
import { useCallback } from "react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { useChatMeasuredOpenChange } from "@/components/chat/chat-measured-item-change-context";
import type {
  ActivityGroupModel,
  ActivityGroupDetailSegment,
} from "@/components/chat/chat-activity-groups";
import { Shimmer } from "@/components/ui/shimmer";
import { cn } from "@/lib/utils";
import {
  useActivityGroupOpen,
  useSetActivityGroupOpen,
} from "@/stores/chats/activity-group-open-store-context";
import { ResolvedApprovalSegment } from "./approval-segment";
import { CommandSegment } from "./command-segment";
import { FileChangeSegment } from "./file-change-segment";
import { LiveElapsed } from "./segment-elapsed";
import { SubagentSegment } from "./subagent-segment";
import { ToolSegment } from "./tool-segment";

interface ActivityGroupSegmentProps {
  readonly group: ActivityGroupModel;
}

export function ActivityGroupSegment(props: ActivityGroupSegmentProps) {
  const { group } = props;
  const open = useActivityGroupOpen(group.id);
  const setOpen = useSetActivityGroupOpen();
  const updateOpen = useCallback(
    (next: boolean) => setOpen(group.id, next),
    [group.id, setOpen],
  );
  const handleOpenChange = useChatMeasuredOpenChange(updateOpen);

  return (
    <Collapsible
      open={open}
      onOpenChange={handleOpenChange}
      className="text-ui-sm text-muted-foreground"
    >
      <CollapsibleTrigger
        aria-label={group.label}
        className={cn(
          "group/activity flex max-w-full items-center gap-2 overflow-hidden rounded-sm py-1 pr-1 text-left text-muted-foreground transition-colors",
          "hover:text-foreground focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        )}
      >
        <Box className="size-3.5 shrink-0 transition-colors" aria-hidden />
        {group.isActive ? (
          <Shimmer
            as="span"
            className={cn(
              "min-w-0 truncate font-medium",
              "[--shimmer-text-color:var(--color-muted-foreground)]",
              "group-hover/activity:[--shimmer-text-color:var(--color-foreground)]",
              "group-focus-visible/activity:[--shimmer-text-color:var(--color-foreground)]",
              "group-data-[state=open]/activity:[--shimmer-text-color:var(--color-foreground)]",
            )}
            duration={1.35}
            spread={1}
          >
            {group.label}
          </Shimmer>
        ) : (
          <span className="min-w-0 truncate transition-colors">
            {group.label}
          </span>
        )}
        {group.isActive && group.activeStartedAt !== null ? (
          <LiveElapsed startedAt={group.activeStartedAt} />
        ) : null}
        <ChevronRight
          className={cn(
            "size-3.5 shrink-0 -translate-x-1 text-muted-foreground/65 opacity-0 transition-[opacity,transform,color]",
            "group-hover/activity:translate-x-0 group-hover/activity:text-foreground group-hover/activity:opacity-100",
            "group-focus-visible/activity:translate-x-0 group-focus-visible/activity:text-foreground group-focus-visible/activity:opacity-100",
            "group-data-[state=open]/activity:translate-x-0 group-data-[state=open]/activity:rotate-90 group-data-[state=open]/activity:text-foreground group-data-[state=open]/activity:opacity-100",
          )}
          aria-hidden
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-0.5 ml-5 flex flex-col gap-0.5 border-l border-border/35 pl-3">
          {group.segments.map((segment) => (
            <ActivityChildSegment key={segment.id} segment={segment} />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

interface ActivityChildSegmentProps {
  readonly segment: ActivityGroupDetailSegment;
}

function ActivityChildSegment(props: ActivityChildSegmentProps) {
  const { segment } = props;
  switch (segment.kind) {
    case "tool":
      return (
        <ToolSegment
          id={segment.id}
          toolName={segment.toolName}
          inputSummary={segment.inputSummary}
          inputDetail={segment.inputDetail}
          error={segment.error}
          agentMessageSend={segment.agentMessageSend}
          isStreaming={segment.isStreaming}
          endState={segment.endState}
          progress={segment.progress}
          backgroundOutput={segment.backgroundOutput}
          backgroundTask={segment.backgroundTask}
          startedAt={segment.startedAt}
          durationMs={segment.durationMs}
          variant="row"
        />
      );
    case "command":
      return (
        <CommandSegment
          command={segment.command}
          cwd={segment.cwd}
          exitCode={segment.exitCode}
          isStreaming={segment.isStreaming}
          endState={segment.endState}
          progress={segment.progress}
          startedAt={segment.startedAt}
          variant="row"
        />
      );
    case "file_change":
      return <FileChangeSegment segment={segment} variant="row" />;
    case "subagent":
      return (
        <SubagentSegment
          id={segment.id}
          name={segment.name}
          agentType={segment.agentType}
          task={segment.task}
          progressUpdates={segment.progressUpdates}
          result={segment.result}
          isStreaming={segment.isStreaming}
          endState={segment.endState}
          startedAt={segment.startedAt}
          durationMs={segment.durationMs}
          variant="row"
        />
      );
    case "approval":
      if (segment.decision === null) return null;
      return (
        <ResolvedApprovalSegment
          toolName={segment.toolName}
          description={segment.description}
          inputSummary={segment.inputSummary}
          inputDetail={segment.inputDetail}
          decision={segment.decision}
          variant="row"
        />
      );
    default: {
      const _exhaustive: never = segment;
      void _exhaustive;
      return null;
    }
  }
}
