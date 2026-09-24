import { useMemo } from "react";
import { buildChatActivityTimeline } from "@/components/chat/chat-activity-groups";
import { AssistantSegment } from "@/components/chat/chat-message-assistant-body";
import { ChatBlockNavigationAnchor } from "@/components/chat/chat-navigation-highlight";
import { distinctRenderKeys } from "@/components/chat/segment-render-keys";
import type {
  SubagentChildSegment,
  SubagentSegment as SubagentSegmentModel,
} from "@/stores/composer/chat-store";
import { ActivityGroupSegment } from "./activity-group-segment";
import { SubagentSegment } from "./subagent-segment";

// A subagent's background work is traced by its own card, never promoted out
// of it, so the card's conversation has no host-listed running tools to mark.
const NO_BACKGROUND_TOOL_BLOCK_IDS: ReadonlySet<string> = new Set();

interface SubagentConversationProps {
  readonly entries: ReadonlyArray<SubagentChildSegment>;
  /** The owning card is still running: its trailing activity group is live. */
  readonly isStreaming: boolean;
}

/**
 * A subagent's whole conversation, in block order, drawn by the SAME pieces a
 * top-level assistant turn is: the activity timeline groups its tools,
 * commands, file changes and reasoning (reasoning collapsed as everywhere
 * else), and every other entry - its prose, notices, errors - goes through the
 * transcript's own segment renderer. A nested agent is one more entry, drawn
 * as a row card that recurses through this component.
 *
 * Shared by every card variant and by the open-as-chat view, so a child reads
 * the same in all three places. Mounted only while the card is open: the card
 * is a `Collapsible` whose content unmounts when closed.
 */
export function SubagentConversation(props: SubagentConversationProps) {
  const { entries, isStreaming } = props;
  const turnState = isStreaming ? "active" : "complete";
  const timeline = useMemo(
    () =>
      buildChatActivityTimeline(entries, {
        turnState,
        promotedToolBlockIds: NO_BACKGROUND_TOOL_BLOCK_IDS,
      }),
    [entries, turnState],
  );
  const keys = useMemo(
    () =>
      distinctRenderKeys(
        timeline.map((item) => ({
          id: item.id,
          kind: item.kind === "segment" ? item.segment.kind : item.kind,
        })),
      ),
    [timeline],
  );
  if (timeline.length === 0) return null;
  return (
    <div data-subagent-conversation="" className="flex flex-col gap-2">
      {timeline.map((item, index) => {
        const key = keys[index];
        if (item.kind === "activity_group") {
          return <ActivityGroupSegment key={key} group={item.group} />;
        }
        if (item.kind === "promoted_subagent") {
          return (
            <ChatBlockNavigationAnchor key={key} blockId={item.segment.id}>
              <NestedSubagentCard segment={item.segment} />
            </ChatBlockNavigationAnchor>
          );
        }
        return (
          <ChatBlockNavigationAnchor key={key} blockId={item.id}>
            <AssistantSegment
              id={item.id}
              segment={item.segment}
              backgroundToolBlockIds={NO_BACKGROUND_TOOL_BLOCK_IDS}
              // A subagent's prose offers no next-step chips, fork, or
              // turn-recovery actions: those act on the parent agent's turn.
              nextStepActions={null}
              forkAction={null}
              interviewDeliveryRetry={null}
              harnessId={null}
              turnId={null}
            />
          </ChatBlockNavigationAnchor>
        );
      })}
    </div>
  );
}

/**
 * A nested agent inside its parent's conversation: a `row` card keyed by its
 * own block id (the id its open state and find units have always used), with
 * the indentation rule that accumulates once per spawn level.
 */
function NestedSubagentCard(props: { readonly segment: SubagentSegmentModel }) {
  const { segment } = props;
  return (
    <div className="border-l border-border/40 pl-3">
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
    </div>
  );
}
