import { Box, ChevronRight } from "lucide-react";
import { useCallback, useMemo, useRef } from "react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { useChatMeasuredOpenChange } from "@/components/chat/chat-measured-item-change-context";
import { deriveActivityGroupCollapsibleKey } from "@/components/chat/chat-collapsible-key";
import {
  chatFindActivityGroupChildHeaderUnitId,
  chatFindActivityGroupSummaryUnitId,
} from "@/components/chat/chat-find";
import {
  isSoleReasoningGroup,
  type ActivityGroupModel,
  type ActivityGroupDetailSegment,
} from "@/components/chat/chat-activity-groups";
import { Shimmer } from "@/components/ui/shimmer";
import { cn } from "@/lib/utils";
import {
  useActivityGroupOpen,
  useSetActivityGroupOpen,
} from "@/stores/chats/activity-group-open-store-context";
import {
  useChatCollapsibleTileInstanceId,
  useChatFindForcedOpen,
  useSetChatFindForcedOpen,
} from "@/stores/chats/chat-find-force-store-context";
import { ResolvedApprovalSegment } from "./approval-segment";
import { CommandSegment } from "./command-segment";
import { FileChangeSegment } from "./file-change-segment";
import { LiveActivityWindow } from "./live-activity-window";
import { ReasoningSegment } from "./reasoning-segment";
import { LiveElapsed } from "./segment-elapsed";
import { SubagentSegment } from "./subagent-segment";
import { ToolSegment } from "./tool-segment";

interface ActivityGroupSegmentProps {
  readonly group: ActivityGroupModel;
}

export function ActivityGroupSegment(props: ActivityGroupSegmentProps) {
  const { group } = props;
  const tileInstanceId = useChatCollapsibleTileInstanceId();
  const collapsibleKey = useMemo(
    () => deriveActivityGroupCollapsibleKey(tileInstanceId, group.id),
    [group.id, tileInstanceId],
  );
  const userOpen = useActivityGroupOpen(group.id);
  const summaryFindUnitId = chatFindActivityGroupSummaryUnitId(group.id);
  const findForcedOpen = useChatFindForcedOpen(collapsibleKey);
  const open = userOpen || findForcedOpen;
  const setOpen = useSetActivityGroupOpen();
  const setFindForcedOpen = useSetChatFindForcedOpen();
  const updateOpen = useCallback(
    (next: boolean) => {
      setOpen(group.id, next);
      if (!next) setFindForcedOpen(collapsibleKey, false);
    },
    [collapsibleKey, group.id, setFindForcedOpen, setOpen],
  );
  const triggerRef = useRef<HTMLButtonElement>(null);
  const handleOpenChange = useChatMeasuredOpenChange(updateOpen, triggerRef);
  const soleReasoning = isSoleReasoningGroup(group.segments);
  // Computed here rather than inline in the JSX: `jsx-no-leaked-render`
  // rewrites an inline `&&` into `? … : null`, which is right for children and
  // wrong for a boolean prop.
  const liveWindowShown = group.isActive && !open;
  const children = group.segments.map((segment) => (
    <ActivityChildSegment
      key={segment.id}
      groupId={group.id}
      segment={segment}
      headerless={soleReasoning}
    />
  ));

  return (
    <Collapsible
      open={open}
      onOpenChange={handleOpenChange}
      className="text-ui-sm text-muted-foreground"
    >
      <CollapsibleTrigger
        ref={triggerRef}
        data-find-include="true"
        data-chat-find-unit={summaryFindUnitId}
        aria-label={group.label}
        className={cn(
          "group/activity flex max-w-full items-center gap-2 overflow-hidden rounded-sm px-1 py-1 text-left text-muted-foreground transition-colors",
          "hover:text-foreground focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        )}
      >
        <ChevronRight
          className={cn(
            "size-3 shrink-0 text-muted-foreground/50 transition-transform",
            "group-data-[state=open]/activity:rotate-90",
          )}
          aria-hidden
        />
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
          <span data-find-skip className="contents">
            <LiveElapsed startedAt={group.activeStartedAt} />
          </span>
        ) : null}
      </CollapsibleTrigger>
      {/* While the run is live and the group is collapsed, the rows show in a
          bounded window instead of being hidden entirely - you can watch the
          work without it growing the turn under the run indicator. Children are
          withheld once the group is open so they never exist in both this
          window and `CollapsibleContent` at once: a find unit rendered twice
          would double-count. */}
      <LiveActivityWindow shown={liveWindowShown}>
        {open ? null : children}
      </LiveActivityWindow>
      <CollapsibleContent>
        <div className="mt-0.5 ml-5 flex flex-col gap-0.5 border-l border-border/35 pl-3">
          {children}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

interface ActivityChildSegmentProps {
  readonly groupId: string;
  readonly segment: ActivityGroupDetailSegment;
  /**
   * The group's entire content is this one reasoning block, so the group's
   * summary line is already its header. Only reasoning honours this - no other
   * child kind can be a group's sole content and also be fully described by the
   * group summary.
   */
  readonly headerless: boolean;
}

function ActivityChildSegment(props: ActivityChildSegmentProps) {
  const { groupId, segment, headerless } = props;
  const headerFindUnitId = chatFindActivityGroupChildHeaderUnitId(
    groupId,
    segment.id,
  );
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
          stopped={segment.stopped}
          progress={segment.progress}
          backgroundOutput={segment.backgroundOutput}
          backgroundTask={segment.backgroundTask}
          startedAt={segment.startedAt}
          durationMs={segment.durationMs}
          variant="row"
          headerFindUnitId={
            segment.agentMessageSend === null ? headerFindUnitId : null
          }
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
          headerFindUnitId={headerFindUnitId}
        />
      );
    case "file_change":
      return (
        <FileChangeSegment
          segment={segment}
          variant="row"
          headerFindUnitId={headerFindUnitId}
        />
      );
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
          stopped={segment.stopped}
          startedAt={segment.startedAt}
          durationMs={segment.durationMs}
          workflowMeta={segment.workflowMeta}
          nested={segment.children}
          variant="row"
        />
      );
    case "reasoning":
      return (
        <ReasoningSegment
          // Headerless renders no anchor element, so it must carry no find unit
          // id either - `chat-find-projection.ts` skips indexing this child in
          // exactly that case, and the two must not disagree.
          findUnitId={headerless ? null : headerFindUnitId}
          markdown={segment.markdown}
          isStreaming={segment.isStreaming}
          durationMs={segment.durationMs}
          headerless={headerless}
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
          headerFindUnitId={headerFindUnitId}
        />
      );
    default: {
      const _exhaustive: never = segment;
      void _exhaustive;
      return null;
    }
  }
}
