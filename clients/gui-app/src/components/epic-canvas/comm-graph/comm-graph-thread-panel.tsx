/**
 * Click-through for one PAIR: every raw A2A row between two agents, both
 * directions interleaved chronologically, uncollapsed.
 *
 * DIRECTION LIVES ON THE ROWS, and only there. The canvas edge is undirected and
 * its label is recency only, so this list is where who-spoke-to-whom is
 * expressed - every row leads with `sender → receiver` through the same
 * component the timeline uses. There is deliberately no per-direction summary in
 * the header: it restated what every row already says, and the counts are
 * readable off the rows themselves.
 *
 * Interleaving is free: the rows arrive in the merged array's order and the
 * aggregation appends in one pass, so a reply always sits after the request it
 * answers.
 */
import type { CommGraphEvent } from "@/lib/comm-graph/comm-graph-events";
import { commGraphAgentLabel } from "@/lib/comm-graph/comm-graph-labels";
import type { CommGraphAggregatedEdge } from "@/lib/comm-graph/comm-graph-model";
import { CommGraphDetailPanel } from "@/components/epic-canvas/comm-graph/comm-graph-detail-panel";

export interface CommGraphThreadPanelProps {
  readonly edge: CommGraphAggregatedEdge;
  readonly epicId: string;
  readonly agentNames: ReadonlyMap<string, string>;
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
  readonly onClose: () => void;
}

export function CommGraphThreadPanel(props: CommGraphThreadPanelProps) {
  const {
    agentNames,
    canJump,
    canJumpToCreated,
    canJumpToSender,
    edge,
    epicId,
    onClose,
    onJump,
    onJumpToCreated,
    onJumpToSender,
    onOpenAgentId,
  } = props;
  return (
    <CommGraphDetailPanel
      ariaLabel="Messages on this edge"
      testId="comm-graph-thread-panel"
      title={
        <>
          {commGraphAgentLabel(edge.agentAId, agentNames)}
          {" ⇄ "}
          {commGraphAgentLabel(edge.agentBId, agentNames)}
        </>
      }
      actions={null}
      events={edge.events}
      epicId={epicId}
      agentNames={agentNames}
      emptyLabel="No messages on this pair yet."
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
