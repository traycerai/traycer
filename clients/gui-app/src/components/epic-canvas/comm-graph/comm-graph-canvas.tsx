/**
 * The agents-only communication graph canvas.
 *
 * Agents are nodes, aggregated A2A exchanges are edges. Lineage is a layout
 * constraint rather than a drawn edge - see `comm-graph-layout.ts`.
 *
 * The graph is rendered AS OF THE EPIC'S TIME CURSOR: it receives the event
 * prefix up to the cursor, the set of agents that existed by then, and which
 * element the cursor event should pulse. Nothing below reads a clock - "now" is
 * just the cursor being live. The transport that MOVES the cursor is docked at
 * the bottom of this canvas.
 */
import { useCallback, useMemo, useState } from "react";
import {
  Background,
  Controls,
  ReactFlow,
  type NodeMouseHandler,
  type Viewport,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useResolvedTheme } from "@/providers/use-resolved-theme";
import { useEpicAgentActivityTiers } from "@/lib/epic-selectors";
import type {
  CommGraphEvent,
  CommGraphHostState,
  CommGraphHostStatus,
} from "@/lib/comm-graph/comm-graph-events";
import {
  aggregateCommGraphEdges,
  type CommGraphAgentNode,
} from "@/lib/comm-graph/comm-graph-model";
import {
  COMM_GRAPH_NODE_HEIGHT,
  COMM_GRAPH_NODE_WIDTH,
  layoutCommGraphNodes,
} from "@/lib/comm-graph/comm-graph-layout";
import {
  COMM_GRAPH_AGENT_NODE_TYPE,
  CommGraphAgentNodeView,
  type CommGraphAgentFlowNode,
  type CommGraphNodeHostStatus,
} from "@/components/epic-canvas/comm-graph/comm-graph-agent-node";
import {
  COMM_GRAPH_EDGE_TYPE,
  CommGraphEdgeView,
  type CommGraphFlowEdge,
} from "@/components/epic-canvas/comm-graph/comm-graph-edge";
import { CommGraphThreadPanel } from "@/components/epic-canvas/comm-graph/comm-graph-thread-panel";
import { CommGraphAgentDetailPanel } from "@/components/epic-canvas/comm-graph/comm-graph-agent-detail-panel";
import { commGraphEventTouchesAgent } from "@/lib/comm-graph/comm-graph-timeline";
import { commGraphEdgeInteraction } from "@/components/epic-canvas/comm-graph/comm-graph-edge-interaction";
import {
  commGraphEdgeTravel,
  type CommGraphEdgeTravel,
} from "@/lib/comm-graph/comm-graph-travel";
import type {
  CommGraphPulse,
  CommGraphPulseKind,
} from "@/lib/comm-graph/comm-graph-timeline";
import type { CommGraphTileViewState } from "@/stores/epics/canvas/types";
import { DEFAULT_COMM_GRAPH_VIEW } from "@/stores/epics/canvas/tile-schema/comm-graph-tile";

const NODE_TYPES = { [COMM_GRAPH_AGENT_NODE_TYPE]: CommGraphAgentNodeView };
const EDGE_TYPES = { [COMM_GRAPH_EDGE_TYPE]: CommGraphEdgeView };
// React Flow's attribution link is not part of this surface.
const PRO_OPTIONS = { hideAttribution: true };
// React Flow defaults to 0.5, which is too close for a wide agent graph to fit.
const COMM_GRAPH_MIN_ZOOM = 0.1;

/** Which detail surface the canvas has open, if any. */
type CommGraphSelectedDetail =
  | { readonly kind: "pair"; readonly edgeId: string }
  | { readonly kind: "agent"; readonly agentId: string };

export interface CommGraphCanvasProps {
  readonly epicId: string;
  /**
   * EVERY agent in the epic. The layout runs over the full set on purpose:
   * positions stay put while playback reveals nodes, instead of the whole graph
   * re-flowing on each step.
   */
  readonly agents: ReadonlyArray<CommGraphAgentNode>;
  /**
   * The agents that EXIST as of the cursor (they appear at `createdAt`). Both
   * the rendered nodes and the edge endpoints are limited to this set.
   */
  readonly agentIds: ReadonlySet<string>;
  /** The merged event array up to the cursor. */
  readonly events: ReadonlyArray<CommGraphEvent>;
  readonly hosts: ReadonlyArray<CommGraphHostState>;
  /** What the cursor event lights up, or null when it lights up nothing. */
  readonly pulse: CommGraphPulse | null;
  readonly view: CommGraphTileViewState;
  readonly onViewChange: (view: CommGraphTileViewState) => void;
  /** Whether this row's owning cloud origin can currently open endpoints. */
  readonly canOpenAgentForEvent: (event: CommGraphEvent) => boolean;
  /** Whether a detail row can be opened at its source. */
  readonly canJump: (event: CommGraphEvent) => boolean;
  readonly onJump: (event: CommGraphEvent) => void;
  /** Sender-side jump to the "Sent message" card - see `CommGraphJump`. */
  readonly canJumpToSender: (event: CommGraphEvent) => boolean;
  readonly onJumpToSender: (event: CommGraphEvent) => void;
  /** Created-row jump to the child's transcript start - see `CommGraphJump`. */
  readonly canJumpToCreated: (event: CommGraphEvent) => boolean;
  readonly onJumpToCreated: (event: CommGraphEvent) => void;
  readonly onOpenAgent: (agent: CommGraphAgentNode) => void;
}

/**
 * A node with no resolvable host has no subscription behind it at all - a
 * legacy chat record that predates `Chat.hostId`. That is deliberately kept
 * distinct from "the host exists but we cannot reach it", because the reasons
 * and the remedies differ.
 */
/** Flattens the travel resolution into the edge's two data fields. */
function travelData(travel: CommGraphEdgeTravel | null): {
  readonly pulse: CommGraphPulseKind | null;
  readonly pulseReversed: boolean;
} {
  if (travel === null) return { pulse: null, pulseReversed: false };
  return { pulse: travel.kind, pulseReversed: travel.reversed };
}

function nodeHostStatus(
  hostId: string | null,
  byHost: ReadonlyMap<string, CommGraphHostStatus>,
): CommGraphNodeHostStatus {
  if (hostId === null) return "host-unknown";
  return byHost.get(hostId) ?? "connecting";
}

export function CommGraphCanvas(props: CommGraphCanvasProps) {
  // ReactFlow must create its own provider from the computed nodes below. An
  // empty outer provider would make it reuse a store initialized before those
  // nodes exist, so the first fit-to-view would have no graph to frame.
  return <CommGraphCanvasBody {...props} />;
}

function isDefaultView(view: CommGraphTileViewState): boolean {
  return (
    view.x === DEFAULT_COMM_GRAPH_VIEW.x &&
    view.y === DEFAULT_COMM_GRAPH_VIEW.y &&
    view.zoom === DEFAULT_COMM_GRAPH_VIEW.zoom
  );
}

function CommGraphCanvasBody(props: CommGraphCanvasProps) {
  const {
    agentIds,
    agents,
    canOpenAgentForEvent,
    canJump,
    canJumpToCreated,
    canJumpToSender,
    epicId,
    events,
    hosts,
    onJump,
    onJumpToCreated,
    onJumpToSender,
    onOpenAgent,
    onViewChange,
    pulse,
    view,
  } = props;
  // ONE detail surface at a time: opening an agent replaces an open pair and
  // vice versa, so the canvas never has two competing explanations beside it.
  const [selectedDetail, setSelectedDetail] =
    useState<CommGraphSelectedDetail | null>(null);
  // React Flow paints its own chrome (background dots, zoom controls) outside
  // the Tailwind cascade, so it needs the resolved mode handed to it.
  const { resolvedTheme } = useResolvedTheme();
  const activityTiers = useEpicAgentActivityTiers();

  // Shared by the edge labels and both detail panels, so an agent is named the
  // same way wherever it appears.
  const nameById = useMemo(
    () => new Map(agents.map((agent) => [agent.id, agent.name])),
    [agents],
  );
  const hostStatusById = useMemo(
    () =>
      new Map<string, CommGraphHostStatus>(
        hosts.map((host) => [host.hostId, host.status]),
      ),
    [hosts],
  );
  const aggregated = useMemo(
    () => aggregateCommGraphEdges(events, agentIds),
    [agentIds, events],
  );
  // Layout takes the PAIR edges too, so dagre pulls conversing agents together
  // instead of ranking them by lineage alone. Still over the full agent set, so
  // revealing a node during playback does not re-flow the ones already placed.
  const positions = useMemo(
    () => layoutCommGraphNodes(agents, aggregated),
    [aggregated, agents],
  );

  const pulsingAgentId =
    pulse !== null && pulse.kind === "agent" ? pulse.agentId : null;
  // One resolution per edge, so `pulse` and `pulseReversed` cannot disagree
  // about which message is traveling.
  const travelFor = useCallback(
    (edgeId: string, agentAId: string, agentBId: string) =>
      commGraphEdgeTravel(pulse, edgeId, agentAId, agentBId),
    [pulse],
  );

  const handleSelectEdge = useCallback((edgeId: string) => {
    setSelectedDetail((current) =>
      current?.kind === "pair" && current.edgeId === edgeId
        ? current
        : { kind: "pair", edgeId },
    );
  }, []);

  // Idempotent by identity, because an agent has TWO live click paths that both
  // legitimately fire (see `onNodeClick` below): re-selecting what is already
  // open must be a genuine no-op, not a second render of the same panel.
  const handleSelectAgent = useCallback((agentId: string) => {
    setSelectedDetail((current) =>
      current?.kind === "agent" && current.agentId === agentId
        ? current
        : { kind: "agent", agentId },
    );
  }, []);

  const handleNodeClick = useCallback<NodeMouseHandler<CommGraphAgentFlowNode>>(
    (_event, node) => {
      handleSelectAgent(node.id);
    },
    [handleSelectAgent],
  );

  // Both halves of "an edge is a control", from one call - see the module for
  // the React Flow behavior each knob answers.
  const { edgeInteraction, onEdgeClick } = useMemo(
    () => commGraphEdgeInteraction(handleSelectEdge, nameById),
    [handleSelectEdge, nameById],
  );

  const nodes = useMemo<ReadonlyArray<CommGraphAgentFlowNode>>(
    () =>
      // Only agents that existed as of the cursor are drawn; the layout above
      // still ran over the full set, so revealing one does not move the rest.
      agents
        .filter((agent) => agentIds.has(agent.id))
        .map((agent) => ({
          id: agent.id,
          type: COMM_GRAPH_AGENT_NODE_TYPE,
          position: positions.get(agent.id) ?? { x: 0, y: 0 },
          // Flow-space dimensions, so the node box matches what the layout
          // reserved. Supplying them up front also lets edges route before the
          // first ResizeObserver measurement lands.
          width: COMM_GRAPH_NODE_WIDTH,
          height: COMM_GRAPH_NODE_HEIGHT,
          draggable: false,
          data: {
            epicId,
            agentId: agent.id,
            kind: agent.kind,
            name: agent.name,
            archived: agent.archived,
            hostStatus: nodeHostStatus(agent.hostId, hostStatusById),
            activityTier: activityTiers.get(agent.id) ?? null,
            // The ONLY node pulse left: a message whose counterpart is not on
            // this canvas has no edge to travel along, so the endpoint that IS
            // here lights up instead of the exchange vanishing.
            pulsing: agent.id === pulsingAgentId,
            onSelect: handleSelectAgent,
          },
        })),
    [
      activityTiers,
      agentIds,
      agents,
      epicId,
      handleSelectAgent,
      hostStatusById,
      positions,
      pulsingAgentId,
    ],
  );

  const edges = useMemo<ReadonlyArray<CommGraphFlowEdge>>(
    () =>
      // ONE edge per unordered pair, and no `markerEnd`: the edge is
      // undirected. `source`/`target` are React Flow's routing endpoints only -
      // they carry the pair's canonical order, not a direction.
      aggregated.map((edge) => ({
        id: edge.id,
        source: edge.agentAId,
        target: edge.agentBId,
        type: COMM_GRAPH_EDGE_TYPE,
        ...edgeInteraction(edge),
        data: {
          edgeId: edge.id,
          hasOpenThread: edge.hasOpenThread,
          // Resolved against THIS edge's canonical endpoint order, so the drawn
          // edge stays undirected while the message that travels it does not.
          ...travelData(travelFor(edge.id, edge.agentAId, edge.agentBId)),
          onSelect: handleSelectEdge,
        },
      })),
    [aggregated, edgeInteraction, handleSelectEdge, travelFor],
  );

  const selectedEdge =
    selectedDetail?.kind === "pair"
      ? (aggregated.find((edge) => edge.id === selectedDetail.edgeId) ?? null)
      : null;
  const selectedAgent =
    selectedDetail?.kind === "agent"
      ? (agents.find((agent) => agent.id === selectedDetail.agentId) ?? null)
      : null;
  // A pure filter over the merged as-of array - an agent's activity is its slice
  // of the same raw record, in the same order, not a new aggregation.
  const selectedAgentEvents = useMemo(() => {
    if (selectedAgent === null) return [];
    return events.filter((event) =>
      commGraphEventTouchesAgent(event, selectedAgent.id),
    );
  }, [events, selectedAgent]);

  const handleMoveEnd = useCallback(
    (_event: unknown, viewport: Viewport) => {
      onViewChange({ x: viewport.x, y: viewport.y, zoom: viewport.zoom });
    },
    [onViewChange],
  );

  // The sender-side heading link. Resolves the id against the epic's agents and
  // opens that tile - no scroll, because origin refs are receiver-side and the
  // sender's transcript carries no captured anchor.
  const openAgentById = useCallback(
    (agentId: string) => {
      const agent = agents.find((candidate) => candidate.id === agentId);
      if (agent === undefined) return;
      onOpenAgent(agent);
    },
    [agents, onOpenAgent],
  );

  const closePanel = useCallback(() => setSelectedDetail(null), []);

  return (
    // The canvas fills the tile: the timeline lives in the epic sidebar now, so
    // the only thing sharing this row is the edge click-through.
    <div className="flex h-full min-h-0 w-full min-w-0">
      <div className="min-h-0 min-w-0 flex-1" data-testid="comm-graph-canvas">
        <ReactFlow
          nodes={[...nodes]}
          edges={[...edges]}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          defaultViewport={view}
          // A neutral schema viewport means this graph has never been framed by
          // the user. Let React Flow derive its first viewport from every node;
          // a persisted pan/zoom still restores exactly as the user left it.
          fitView={isDefaultView(view)}
          minZoom={COMM_GRAPH_MIN_ZOOM}
          onMoveEnd={handleMoveEnd}
          // REQUIRED, and not merely as a tidier click path. React Flow's
          // `NodeWrapper` computes
          //   hasPointerEvents = isSelectable || isDraggable || onClick || …
          // and writes `pointerEvents: 'none'` on `.react-flow__node` when it is
          // false. With `elementsSelectable={false}` and `draggable: false` and
          // no `onNodeClick`, every node was pointer-inert in a real browser -
          // the node's own <button> never saw a click at all. jsdom does not
          // implement CSS pointer-events, so `fireEvent.click` on that button
          // passed the whole time. Deleting this prop silently breaks the
          // feature again; the node-wrapper test is what guards it.
          onNodeClick={handleNodeClick}
          // REQUIRED, like `onNodeClick`: without it every edge <g> is
          // pointer-inert - see `commGraphEdgeInteraction`, which builds this
          // and the per-edge half together for that reason.
          onEdgeClick={onEdgeClick}
          nodesDraggable={false}
          nodesConnectable={false}
          // The node wrapper would otherwise take `tabIndex=0` and be a DEAD tab
          // stop: its keydown handler only drives React Flow's own selection,
          // which `elementsSelectable={false}` already rules out, so every agent
          // would cost two Tabs to reach - one for a wrapper that does nothing,
          // one for the real button inside it. Turning this off drops the
          // wrapper's `tabIndex`, `onKeyDown`, `onFocus` and `group` role and
          // leaves our own <button> as the single focus target. It cannot
          // re-inert the node: `hasPointerEvents` is a function of `onClick`,
          // not of `isFocusable`.
          //
          // `edgesFocusable` stays ON deliberately: an edge has no inner
          // control, so its wrapper is the only keyboard route to the pair
          // panel, and it earns the stop by carrying a real key handler.
          nodesFocusable={false}
          // Kept OFF deliberately, and it does not gate the click: React Flow
          // gates only its INTERNAL selection (`handleNodeClick`) on
          // `isSelectable`, then calls the user's `onClick(event, node)`
          // unconditionally. So we get clicks without selection outlines or
          // box-select.
          elementsSelectable={false}
          proOptions={PRO_OPTIONS}
          colorMode={resolvedTheme}
          aria-label="Communication graph"
        >
          <Background />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
      {selectedEdge === null ? null : (
        <CommGraphThreadPanel
          edge={selectedEdge}
          epicId={epicId}
          agentNames={nameById}
          canOpenAgentForEvent={canOpenAgentForEvent}
          canJump={canJump}
          onJump={onJump}
          canJumpToSender={canJumpToSender}
          onJumpToSender={onJumpToSender}
          canJumpToCreated={canJumpToCreated}
          onJumpToCreated={onJumpToCreated}
          onOpenAgentId={openAgentById}
          onClose={closePanel}
        />
      )}
      {selectedAgent === null ? null : (
        <CommGraphAgentDetailPanel
          agent={selectedAgent}
          epicId={epicId}
          agentNames={nameById}
          events={selectedAgentEvents}
          canOpenAgentForEvent={canOpenAgentForEvent}
          canJump={canJump}
          onJump={onJump}
          canJumpToSender={canJumpToSender}
          onJumpToSender={onJumpToSender}
          canJumpToCreated={canJumpToCreated}
          onJumpToCreated={onJumpToCreated}
          onOpenAgent={onOpenAgent}
          onOpenAgentId={openAgentById}
          onClose={closePanel}
        />
      )}
    </div>
  );
}
