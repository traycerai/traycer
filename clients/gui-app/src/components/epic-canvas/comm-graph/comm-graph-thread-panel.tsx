/** DIRECTION LIVES ON THE ROWS, and only there. */
import type { CommGraphEvent } from "@/lib/comm-graph/comm-graph-events";
import { commGraphAgentLabel } from "@/lib/comm-graph/comm-graph-labels";
import type { CommGraphAggregatedEdge } from "@/lib/comm-graph/comm-graph-model";
import { CommGraphDetailPanel } from "@/components/epic-canvas/comm-graph/comm-graph-detail-panel";

export interface CommGraphThreadPanelProps {
  readonly edge: CommGraphAggregatedEdge;
  readonly epicId: string;
  readonly agentNames: ReadonlyMap<string, string>;
  readonly initialHistoryCaughtUp: boolean;
  readonly canOpenAgentForEvent: (event: CommGraphEvent) => boolean;
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
    canOpenAgentForEvent,
    canJump,
    canJumpToCreated,
    canJumpToSender,
    edge,
    epicId,
    initialHistoryCaughtUp,
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
      initialHistoryCaughtUp={initialHistoryCaughtUp}
      epicId={epicId}
      agentNames={agentNames}
      emptyLabel="No messages on this pair yet."
      canOpenAgentForEvent={canOpenAgentForEvent}
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
