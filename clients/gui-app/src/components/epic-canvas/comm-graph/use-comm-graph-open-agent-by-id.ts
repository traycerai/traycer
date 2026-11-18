import { useCallback } from "react";
import type { CommGraphAgentNode } from "@/lib/comm-graph/comm-graph-model";

/**
 * The sender-side heading link: resolve an id against the epic's agents and
 * open that tile. No scroll - origin refs are receiver-side, so the sender's
 * transcript carries no captured anchor to scroll to.
 *
 * Lives in its own module rather than beside the panel that uses it: a file
 * that exports both a component and a hook cannot be hot-replaced.
 */
export function useCommGraphOpenAgentById(
  agents: ReadonlyArray<CommGraphAgentNode>,
  onOpenAgent: (agent: CommGraphAgentNode) => void,
): (agentId: string) => void {
  return useCallback(
    (agentId: string) => {
      const target = agents.find((candidate) => candidate.id === agentId);
      if (target === undefined) return;
      onOpenAgent(target);
    },
    [agents, onOpenAgent],
  );
}
