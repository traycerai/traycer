/**
 * In React Flow that single fact is several unrelated knobs on two different objects, and dropping any of them silently returns the edge to inert ink - which is exactly how it shipped.
 * So both halves are built here, together, and the canvas cannot take one without the other.
 */
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { EdgeMouseHandler } from "@xyflow/react";
import { commGraphAgentLabel } from "@/lib/comm-graph/comm-graph-labels";
import type { CommGraphFlowEdge } from "@/components/epic-canvas/comm-graph/comm-graph-edge";

/** The per-edge half: spread onto every edge object the canvas builds. */
export interface CommGraphEdgeInteraction {
  readonly className: string;
  readonly ariaRole: "button";
  readonly ariaLabel: string;
  readonly domAttributes: {
    readonly onKeyDown: (event: ReactKeyboardEvent<SVGGElement>) => void;
  };
}

export interface CommGraphEdgeInteractionParts {
  /** The canvas half: hand to `<ReactFlow onEdgeClick={...}>`. */
  readonly onEdgeClick: EdgeMouseHandler<CommGraphFlowEdge>;
  readonly edgeInteraction: (edge: {
    readonly id: string;
    readonly agentAId: string;
    readonly agentBId: string;
  }) => CommGraphEdgeInteraction;
}

export function commGraphEdgeInteraction(
  onOpen: (edgeId: string) => void,
  agentNames: ReadonlyMap<string, string>,
): CommGraphEdgeInteractionParts {
  return {
    onEdgeClick: (_event, edge) => onOpen(edge.id),
    edgeInteraction: (edge) => ({
      className: "cursor-pointer",
      ariaRole: "button",
      ariaLabel: `Open messages between ${commGraphAgentLabel(edge.agentAId, agentNames)} and ${commGraphAgentLabel(edge.agentBId, agentNames)}`,
      domAttributes: {
        onKeyDown: (event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          // Space scrolls the canvas otherwise, and Enter would bubble out of
          // the tile.
          event.preventDefault();
          onOpen(edge.id);
        },
      },
    }),
  };
}
