/**
 * What makes a comm-graph edge an interactive control, in ONE place.
 *
 * In React Flow that single fact is several unrelated knobs on two different
 * objects, and dropping any of them silently returns the edge to inert ink -
 * which is exactly how it shipped. So both halves are built here, together, and
 * the canvas cannot take one without the other.
 *
 * WHY EACH KNOB EXISTS - all of it is React Flow behavior, none of it visible
 * from the canvas:
 *
 * - `onEdgeClick`: `EdgeWrapper` writes `inactive = !isSelectable && !onClick`
 *   onto the edge's <g>, and `.react-flow__edge.inactive` is
 *   `pointer-events: none`. With `elementsSelectable={false}` and no
 *   `onEdgeClick`, every edge line is dead - `BaseEdge` paints a 20px
 *   transparent interaction path, but nothing in the group can receive a
 *   pointer.
 * - `className`: React Flow's own `cursor: pointer` rides on the `selectable`
 *   class, which `elementsSelectable={false}` withholds.
 * - `domAttributes.onKeyDown`: React Flow makes every edge a tab stop
 *   (`edgesFocusable` defaults on) but gates its own key handler on the
 *   selection this canvas turns off, so the stop does nothing. `domAttributes`
 *   is spread LAST onto the <g>, so this replaces that handler. An edge has no
 *   inner control to fall back to, so this is the only keyboard route to the
 *   pair panel.
 * - `ariaRole` / `ariaLabel`: the defaults are `group` and
 *   "Edge from <id> to <id>" - raw uuids, and DIRECTED, for an edge this canvas
 *   draws undirected on purpose.
 *
 * The focus ring is the one part NOT here: `.react-flow__edge:focus-visible` in
 * `index.css` draws it, because React Flow strips the group's outline and
 * paints its own focus stroke only for a `selectable` edge.
 *
 * NOTHING HERE IS TESTABLE IN JSDOM. `getEdgePosition` bails unless both
 * endpoints carry DOM-measured `handleBounds`, so `EdgeWrapper` renders no <g>
 * at all - no class to assert, no tab stop to land on, nothing to dispatch at.
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
