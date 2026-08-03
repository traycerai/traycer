/**
 * Click-through for one AGENT: everything this epic captured that the agent took
 * part in, interleaved chronologically - messages it sent AND received, and
 * notices about its threads.
 *
 * A PURE FILTER over the merged array (`sender OR receiver`), not a new
 * aggregation: the pair panel folds by pair because the canvas draws pairs, but
 * an agent's activity is just its slice of the same raw record, in the same
 * order.
 *
 * "ACTIVITY", NOT "everything it did". The log holds communications only - not
 * tool calls, not file edits, not reasoning, not shell commands.
 * The copy says what is actually here, because a panel that claims completeness
 * it does not have is worse than one that shows less.
 */
import { ExternalLinkIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { EpicNodeTabIcon } from "@/components/epic-canvas/epic-node-tab-icon";
import type { CommGraphEvent } from "@/lib/comm-graph/comm-graph-events";
import type { CommGraphAgentNode } from "@/lib/comm-graph/comm-graph-model";
import { UNKNOWN_HOST_PLACEHOLDER } from "@/lib/host/constants";
import { CommGraphDetailPanel } from "@/components/epic-canvas/comm-graph/comm-graph-detail-panel";

export interface CommGraphAgentDetailPanelProps {
  readonly agent: CommGraphAgentNode;
  readonly epicId: string;
  readonly agentNames: ReadonlyMap<string, string>;
  /** Already filtered to this agent, in merged-array order. */
  readonly events: ReadonlyArray<CommGraphEvent>;
  readonly canJump: (event: CommGraphEvent) => boolean;
  readonly onJump: (event: CommGraphEvent) => void;
  /** Sender-side jump to the "Sent message" card - see `CommGraphJump`. */
  readonly canJumpToSender: (event: CommGraphEvent) => boolean;
  readonly onJumpToSender: (event: CommGraphEvent) => void;
  /** Created-row jump to the child's transcript start - see `CommGraphJump`. */
  readonly canJumpToCreated: (event: CommGraphEvent) => boolean;
  readonly onJumpToCreated: (event: CommGraphEvent) => void;
  /** Opens an agent's tile with no scroll - an anchor-less heading link. */
  readonly onOpenAgentId: (agentId: string) => void;
  readonly onOpenAgent: (agent: CommGraphAgentNode) => void;
  readonly onClose: () => void;
}

export function CommGraphAgentDetailPanel(
  props: CommGraphAgentDetailPanelProps,
) {
  const {
    agent,
    agentNames,
    canJump,
    canJumpToCreated,
    canJumpToSender,
    epicId,
    events,
    onClose,
    onJump,
    onJumpToCreated,
    onJumpToSender,
    onOpenAgent,
    onOpenAgentId,
  } = props;
  return (
    <CommGraphDetailPanel
      ariaLabel={`Activity for ${agent.name}`}
      testId="comm-graph-agent-panel"
      title={
        <>
          {/* Same icon renderer as the node and the nav surfaces, so an agent
              looks like itself wherever it appears. */}
          <EpicNodeTabIcon
            node={{
              id: agent.id,
              instanceId: agent.id,
              type: agent.kind,
              name: agent.name,
              hostId: agent.hostId ?? UNKNOWN_HOST_PLACEHOLDER,
            }}
            epicId={epicId}
            variant="live"
            className="size-3.5 shrink-0"
            defaultIcon={undefined}
          />
          <span className="min-w-0 truncate">{agent.name}</span>
        </>
      }
      actions={
        <TooltipWrapper
          label="Open agent"
          side="bottom"
          sideOffset={4}
          align="end"
        >
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label="Open agent"
            data-testid="comm-graph-agent-panel-open"
            className="text-muted-foreground hover:text-foreground"
            onClick={() => onOpenAgent(agent)}
          >
            <ExternalLinkIcon />
          </Button>
        </TooltipWrapper>
      }
      events={events}
      epicId={epicId}
      agentNames={agentNames}
      emptyLabel="No captured activity for this agent yet. The graph records messages between agents and broker notices."
      canJump={canJump}
      onJump={onJump}
      canJumpToSender={canJumpToSender}
      onJumpToSender={onJumpToSender}
      canJumpToCreated={canJumpToCreated}
      onJumpToCreated={onJumpToCreated}
      onOpenAgentId={onOpenAgentId}
      onClose={onClose}
    />
  );
}
