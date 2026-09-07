/**
 * The agent click-through, resolved from a selected id.
 *
 * Both renderings of the communication graph open the SAME panel on the same
 * data, so the resolution (id -> agent, merged array -> that agent's slice) and
 * the sender-side "open this agent" link live here once. A second copy would be
 * free to drift into showing an agent a different set of its own rows.
 */
import { useMemo } from "react";
import type { CommGraphEvent } from "@/lib/comm-graph/comm-graph-events";
import type { CommGraphAgentNode } from "@/lib/comm-graph/comm-graph-model";
import { commGraphEventTouchesAgent } from "@/lib/comm-graph/comm-graph-timeline";
import { CommGraphAgentDetailPanel } from "@/components/epic-canvas/comm-graph/comm-graph-agent-detail-panel";
import { useCommGraphOpenAgentById } from "@/components/epic-canvas/comm-graph/use-comm-graph-open-agent-by-id";

export interface CommGraphAgentDetailSurfaceProps {
  /** `null` closes the surface; nothing renders beside the canvas. */
  readonly agentId: string | null;
  readonly agents: ReadonlyArray<CommGraphAgentNode>;
  readonly agentNames: ReadonlyMap<string, string>;
  /** The merged as-of array; filtered to the selected agent here. */
  readonly events: ReadonlyArray<CommGraphEvent>;
  readonly epicId: string;
  readonly initialHistoryCaughtUp: boolean;
  readonly canOpenAgentForEvent: (event: CommGraphEvent) => boolean;
  readonly canJump: (event: CommGraphEvent) => boolean;
  readonly onJump: (event: CommGraphEvent) => void;
  readonly canJumpToSender: (event: CommGraphEvent) => boolean;
  readonly onJumpToSender: (event: CommGraphEvent) => void;
  readonly canJumpToCreated: (event: CommGraphEvent) => boolean;
  readonly onJumpToCreated: (event: CommGraphEvent) => void;
  readonly onOpenAgent: (agent: CommGraphAgentNode) => void;
  readonly onClose: () => void;
}

export function CommGraphAgentDetailSurface(
  props: CommGraphAgentDetailSurfaceProps,
) {
  const {
    agentId,
    agentNames,
    agents,
    canJump,
    canJumpToCreated,
    canJumpToSender,
    canOpenAgentForEvent,
    epicId,
    events,
    initialHistoryCaughtUp,
    onClose,
    onJump,
    onJumpToCreated,
    onJumpToSender,
    onOpenAgent,
  } = props;

  const agent =
    agentId === null
      ? null
      : (agents.find((candidate) => candidate.id === agentId) ?? null);

  // A pure filter over the merged as-of array - an agent's activity is its
  // slice of the same raw record, in the same order, not a new aggregation.
  const agentEvents = useMemo(() => {
    if (agent === null) return [];
    return events.filter((event) =>
      commGraphEventTouchesAgent(event, agent.id),
    );
  }, [agent, events]);

  const openAgentById = useCommGraphOpenAgentById(agents, onOpenAgent);

  if (agent === null) return null;
  return (
    <CommGraphAgentDetailPanel
      key={agent.id}
      agent={agent}
      epicId={epicId}
      agentNames={agentNames}
      events={agentEvents}
      initialHistoryCaughtUp={initialHistoryCaughtUp}
      canOpenAgentForEvent={canOpenAgentForEvent}
      canJump={canJump}
      onJump={onJump}
      canJumpToSender={canJumpToSender}
      onJumpToSender={onJumpToSender}
      canJumpToCreated={canJumpToCreated}
      onJumpToCreated={onJumpToCreated}
      onOpenAgent={onOpenAgent}
      onOpenAgentId={openAgentById}
      onClose={onClose}
    />
  );
}
