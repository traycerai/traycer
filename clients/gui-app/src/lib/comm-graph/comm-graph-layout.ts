/**
 * Layered auto-layout for the agents-only communication graph, via dagre.
 *
 * Replaces a hand-rolled "one row per lineage depth, columns in order" pass that
 * placed nodes without ever considering who talks to whom: conversing agents
 * landed at opposite ends of a row and read as unrelated, while the drawn edges
 * had to cross the whole canvas to reach them.
 *
 * TWO EDGE SETS GO IN, ONLY ONE COMES OUT ON SCREEN:
 *
 * - LINEAGE (`parentId` → child) is a layout constraint, never a drawn edge. It
 *   is what gives the graph its depth ranking - creators above what they
 *   created. It stays undrawn because it is mutable via reparent and already
 *   visualized by the sidebar tree, so drawing it would duplicate the tree and
 *   imply a message that never happened.
 * - PAIR edges (the undirected A2A folds) are fed in so dagre pulls agents that
 *   actually talk to each other close together. These ARE the drawn edges.
 *
 * dagre resolves any cycle between the two sets itself (it reverses edges
 * internally for ranking), so a child messaging its own parent is fine.
 *
 * Positions are recomputed from the node and pair sets on every data change and
 * are never persisted: an agent created, archived, or reparented would strand a
 * stored coordinate. Only the viewport is remembered (see
 * `CommGraphTileViewState`).
 *
 * Coordinates are React Flow FLOW-space units, not CSS layout - the canvas
 * surface itself stays fluid.
 */
import dagre from "@dagrejs/dagre";
import {
  commGraphPairId,
  type CommGraphAgentNode,
} from "@/lib/comm-graph/comm-graph-model";

export const COMM_GRAPH_NODE_WIDTH = 208;
export const COMM_GRAPH_NODE_HEIGHT = 60;
/** Gap between siblings in a rank, and between ranks. */
const NODE_SEPARATION = 56;
const RANK_SEPARATION = 96;

export interface CommGraphNodePosition {
  readonly x: number;
  readonly y: number;
}

/** The drawn pair edges, as layout input. Only the endpoints matter here. */
export interface CommGraphLayoutEdge {
  readonly agentAId: string;
  readonly agentBId: string;
}

/**
 * Insertion order decides dagre's tie-breaks, so it is pinned to
 * `(createdAt, id)` rather than left to the projection's iteration order - two
 * renders of the same graph must not shuffle.
 */
function orderedForLayout(
  nodes: ReadonlyArray<CommGraphAgentNode>,
): ReadonlyArray<CommGraphAgentNode> {
  return [...nodes].sort((left, right) => {
    if (left.createdAt !== right.createdAt) {
      return left.createdAt - right.createdAt;
    }
    return left.id < right.id ? -1 : 1;
  });
}

export function layoutCommGraphNodes(
  nodes: ReadonlyArray<CommGraphAgentNode>,
  edges: ReadonlyArray<CommGraphLayoutEdge>,
): ReadonlyMap<string, CommGraphNodePosition> {
  const positions = new Map<string, CommGraphNodePosition>();
  if (nodes.length === 0) return positions;

  const graph = new dagre.graphlib.Graph({ directed: true });
  graph.setGraph({
    rankdir: "TB",
    nodesep: NODE_SEPARATION,
    ranksep: RANK_SEPARATION,
  });
  graph.setDefaultEdgeLabel(() => ({}));

  const ordered = orderedForLayout(nodes);
  const known = new Set(ordered.map((node) => node.id));
  for (const node of ordered) {
    graph.setNode(node.id, {
      width: COMM_GRAPH_NODE_WIDTH,
      height: COMM_GRAPH_NODE_HEIGHT,
    });
  }

  // Lineage first and weighted heavier: depth is the graph's backbone, and a
  // busy conversation should bend the layout rather than flatten the tree.
  for (const node of ordered) {
    if (node.parentId === null) continue;
    if (!known.has(node.parentId)) continue;
    graph.setEdge(node.parentId, node.id, { weight: 2 });
  }
  // Sorted by the CANONICAL PAIR ID, a topology-only key. The aggregation hands
  // these over in Map insertion order, which is "whichever pair spoke first" -
  // so a late row on an existing pair can reorder an otherwise IDENTICAL
  // topology and swap two nodes' positions under the user. Insertion order is a
  // dagre tie-break, so the same graph must always be inserted the same way.
  const orderedEdges = [...edges].sort((left, right) => {
    const leftKey = commGraphPairId(left.agentAId, left.agentBId);
    const rightKey = commGraphPairId(right.agentAId, right.agentBId);
    if (leftKey === rightKey) return 0;
    return leftKey < rightKey ? -1 : 1;
  });
  for (const edge of orderedEdges) {
    if (!known.has(edge.agentAId) || !known.has(edge.agentBId)) continue;
    if (edge.agentAId === edge.agentBId) continue;
    // `setEdge` is idempotent per (v, w) on a non-multigraph, so a pair that
    // also has a lineage edge simply keeps the heavier lineage weight.
    if (graph.hasEdge(edge.agentAId, edge.agentBId)) continue;
    if (graph.hasEdge(edge.agentBId, edge.agentAId)) continue;
    graph.setEdge(edge.agentAId, edge.agentBId, { weight: 1 });
  }

  dagre.layout(graph);

  for (const node of ordered) {
    const laidOut = graph.node(node.id);
    // dagre reports CENTRES; React Flow positions from the top-left corner.
    positions.set(node.id, {
      x: laidOut.x - COMM_GRAPH_NODE_WIDTH / 2,
      y: laidOut.y - COMM_GRAPH_NODE_HEIGHT / 2,
    });
  }
  return positions;
}
