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
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Background,
  Controls,
  ReactFlow,
  type OnMove,
  type NodeMouseHandler,
  type ReactFlowInstance,
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
import { CommGraphAgentDetailSurface } from "@/components/epic-canvas/comm-graph/comm-graph-agent-detail-surface";
import { useCommGraphOpenAgentById } from "@/components/epic-canvas/comm-graph/use-comm-graph-open-agent-by-id";
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
import { isDefaultCommGraphView } from "@/stores/epics/canvas/tile-schema/comm-graph-tile";
import { useRegisterTileFindAdapter } from "@/components/epic-canvas/tile-find/tile-find-adapter-context";
import { createCommGraphFindAdapter } from "@/components/epic-canvas/comm-graph/comm-graph-find-adapter";

const NODE_TYPES = { [COMM_GRAPH_AGENT_NODE_TYPE]: CommGraphAgentNodeView };
const EDGE_TYPES = { [COMM_GRAPH_EDGE_TYPE]: CommGraphEdgeView };
// React Flow's attribution link is not part of this surface.
const PRO_OPTIONS = { hideAttribution: true };
// React Flow defaults to 0.5, which is too close for a wide agent graph to fit.
const COMM_GRAPH_MIN_ZOOM = 0.1;
const COMM_GRAPH_AUTO_PAN_MS = 250;
const COMM_GRAPH_SEARCH_PAN_MS = 200;

/** Which detail surface the canvas has open, if any. */
type CommGraphSelectedDetail =
  | { readonly kind: "pair"; readonly edgeId: string }
  | { readonly kind: "agent"; readonly agentId: string };

interface CommGraphFindRuntime {
  readonly getNodes: () => ReadonlyArray<CommGraphAgentFlowNode>;
  readonly getFlowInstance: () => ReactFlowInstance<
    CommGraphAgentFlowNode,
    CommGraphFlowEdge
  > | null;
  readonly updateNodes: (nodes: ReadonlyArray<CommGraphAgentFlowNode>) => void;
  readonly updateFlowInstance: (
    instance: ReactFlowInstance<
      CommGraphAgentFlowNode,
      CommGraphFlowEdge
    > | null,
  ) => void;
  readonly enablePlaybackAutoPan: () => void;
  readonly disablePlaybackAutoPan: () => void;
  readonly isPlaybackAutoPanEnabled: () => boolean;
}

function createCommGraphFindRuntime(): CommGraphFindRuntime {
  let currentNodes: ReadonlyArray<CommGraphAgentFlowNode> = [];
  let currentFlowInstance: ReactFlowInstance<
    CommGraphAgentFlowNode,
    CommGraphFlowEdge
  > | null = null;
  let playbackAutoPanEnabled = true;
  return {
    getNodes: () => currentNodes,
    getFlowInstance: () => currentFlowInstance,
    updateNodes: (nodes) => {
      currentNodes = nodes;
    },
    updateFlowInstance: (instance) => {
      currentFlowInstance = instance;
    },
    enablePlaybackAutoPan: () => {
      playbackAutoPanEnabled = true;
    },
    disablePlaybackAutoPan: () => {
      playbackAutoPanEnabled = false;
    },
    isPlaybackAutoPanEnabled: () => playbackAutoPanEnabled,
  };
}

export interface CommGraphCanvasProps {
  readonly epicId: string;
  readonly tileInstanceId: string;
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
  /** Every source has delivered its initial bounded history. */
  readonly initialHistoryCaughtUp: boolean;
  /** Whether the detached timeline cursor is currently advancing. */
  readonly playing: boolean;
  /** What the cursor event lights up, or null when it lights up nothing. */
  readonly pulse: CommGraphPulse | null;
  /**
   * Stable identity of the ROW behind `pulse` (`commGraphEventKey`), or null.
   *
   * The pulse itself is a derived value with no identity, so two consecutive
   * rows between the same pair are indistinguishable from one row re-supplied.
   * The office renderer spawns an envelope per key change and needs to tell
   * those apart; the node graph re-renders either way and ignores this.
   */
  readonly pulseKey: string | null;
  /**
   * The office/graph switch, floated over the canvas AREA by each renderer.
   *
   * The tile owns the control (it owns the view state it writes) but cannot
   * position it: a detail panel is the canvas's own sibling, so a toggle
   * anchored to the tile would sit on top of that panel's close button
   * whenever one is open.
   */
  readonly modeToggle: ReactNode;
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

function pulseSenderAgentId(pulse: CommGraphPulse | null): string | null {
  if (pulse === null) return null;
  return pulse.kind === "edge" ? pulse.fromAgentId : pulse.senderAgentId;
}

export function CommGraphCanvas(props: CommGraphCanvasProps) {
  // ReactFlow must create its own provider from the computed nodes below. An
  // empty outer provider would make it reuse a store initialized before those
  // nodes exist, so the first fit-to-view would have no graph to frame.
  return <CommGraphCanvasBody {...props} />;
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
    initialHistoryCaughtUp,
    modeToggle,
    onJump,
    onJumpToCreated,
    onJumpToSender,
    onOpenAgent,
    onViewChange,
    playing,
    pulse,
    tileInstanceId,
    view,
  } = props;
  // ONE detail surface at a time: opening an agent replaces an open pair and
  // vice versa, so the canvas never has two competing explanations beside it.
  const [selectedDetail, setSelectedDetail] =
    useState<CommGraphSelectedDetail | null>(null);
  const [flowInstance, setFlowInstance] = useState<ReactFlowInstance<
    CommGraphAgentFlowNode,
    CommGraphFlowEdge
  > | null>(null);
  const [searchHighlight, setSearchHighlight] = useState<{
    readonly agentIds: ReadonlySet<string>;
    readonly requestId: number;
  }>({ agentIds: new Set(), requestId: 0 });
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const [findRuntime] = useState(createCommGraphFindRuntime);
  const wasPlayingRef = useRef(playing);
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
            searchMatched: searchHighlight.agentIds.has(agent.id),
            searchHighlightNonce: searchHighlight.agentIds.has(agent.id)
              ? searchHighlight.requestId
              : 0,
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
      searchHighlight,
    ],
  );

  // Find is registered once per tile instance. The adapter reads live nodes and
  // viewport controls through an imperative runtime, so a playback step does
  // not tear down the active find session or reset its query.
  useEffect(() => {
    findRuntime.updateNodes(nodes);
  }, [findRuntime, nodes]);
  useEffect(() => {
    findRuntime.updateFlowInstance(flowInstance);
  }, [findRuntime, flowInstance]);
  const stopAutoPan = useCallback(() => {
    findRuntime.disablePlaybackAutoPan();
  }, [findRuntime]);
  const findAdapter = useMemo(
    () =>
      createCommGraphFindAdapter({
        tileInstanceId,
        renderer: {
          getNodes: () =>
            findRuntime.getNodes().map((node) => ({
              id: node.id,
              name: node.data.name,
            })),
          showMatches: (agentIds, requestId) => {
            setSearchHighlight({ agentIds, requestId });
          },
          frameMatches: (agentIds) => {
            const instance = findRuntime.getFlowInstance();
            if (instance === null) return;
            const matchingNodes = findRuntime
              .getNodes()
              .filter((node) => agentIds.has(node.id));
            if (matchingNodes.length === 0) return;
            stopAutoPan();
            const currentZoom = instance.getViewport().zoom;
            void instance.fitView({
              nodes: [...matchingNodes],
              padding: 0.35,
              duration: COMM_GRAPH_SEARCH_PAN_MS,
              minZoom: COMM_GRAPH_MIN_ZOOM,
              // Searching should zoom OUT when the result set needs it, but a
              // single nearby result must not unexpectedly magnify the graph.
              maxZoom: currentZoom,
            });
          },
          focusMatch: (agentId) => {
            const instance = findRuntime.getFlowInstance();
            const match = findRuntime
              .getNodes()
              .find((node) => node.id === agentId);
            if (instance === null || match === undefined) return;
            stopAutoPan();
            void instance.fitView({
              nodes: [match],
              padding: 0.5,
              duration: COMM_GRAPH_SEARCH_PAN_MS,
              minZoom: COMM_GRAPH_MIN_ZOOM,
              maxZoom: 1,
            });
          },
          clear: () => {
            setSearchHighlight({ agentIds: new Set(), requestId: 0 });
          },
        },
      }),
    [findRuntime, stopAutoPan, tileInstanceId],
  );
  useRegisterTileFindAdapter(findAdapter);

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

  // Pressing Play is an explicit request to follow the action again. Pause
  // leaves the current choice alone; only the next false -> true transition
  // re-arms after a person has taken manual control of the canvas.
  useEffect(() => {
    if (playing && !wasPlayingRef.current) {
      findRuntime.enablePlaybackAutoPan();
    }
    wasPlayingRef.current = playing;
  }, [findRuntime, playing]);

  const handleMoveStart: OnMove = (event) => {
    // React Flow uses `null` for programmatic viewport changes, including our
    // own `setCenter`; a real interaction event means the person took over.
    if (event !== null) stopAutoPan();
  };

  const senderAgentId = pulseSenderAgentId(pulse);
  useEffect(() => {
    if (
      !playing ||
      !findRuntime.isPlaybackAutoPanEnabled() ||
      senderAgentId === null ||
      flowInstance === null
    ) {
      return;
    }
    const canvas = canvasRef.current;
    const sender = nodes.find((node) => node.id === senderAgentId);
    if (canvas === null || sender === undefined) return;

    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const viewport = flowInstance.getViewport();
    const left = sender.position.x * viewport.zoom + viewport.x;
    const top = sender.position.y * viewport.zoom + viewport.y;
    const right = left + COMM_GRAPH_NODE_WIDTH * viewport.zoom;
    const bottom = top + COMM_GRAPH_NODE_HEIGHT * viewport.zoom;
    const intersectsViewport =
      right >= 0 && left <= rect.width && bottom >= 0 && top <= rect.height;
    if (intersectsViewport) return;

    void flowInstance.setCenter(
      sender.position.x + COMM_GRAPH_NODE_WIDTH / 2,
      sender.position.y + COMM_GRAPH_NODE_HEIGHT / 2,
      { zoom: viewport.zoom, duration: COMM_GRAPH_AUTO_PAN_MS },
    );
    // `pulse` is intentionally a dependency even when two consecutive rows
    // share a sender: every cursor step gets its own visibility decision.
  }, [findRuntime, flowInstance, nodes, playing, pulse, senderAgentId]);

  const selectedEdge =
    selectedDetail?.kind === "pair"
      ? (aggregated.find((edge) => edge.id === selectedDetail.edgeId) ?? null)
      : null;
  const selectedAgentId =
    selectedDetail?.kind === "agent" ? selectedDetail.agentId : null;
  const selectedEdgeHistoryCaughtUp =
    selectedEdge !== null && initialHistoryCaughtUp;

  const handleMoveEnd = useCallback(
    (_event: unknown, viewport: Viewport) => {
      // `mode` is carried through: the viewport moved, the rendering did not.
      onViewChange({
        x: viewport.x,
        y: viewport.y,
        zoom: viewport.zoom,
        mode: view.mode,
      });
    },
    [onViewChange, view.mode],
  );

  const openAgentById = useCommGraphOpenAgentById(agents, onOpenAgent);

  const closePanel = useCallback(() => setSelectedDetail(null), []);

  return (
    // The canvas fills the tile: the timeline lives in the epic sidebar now, so
    // the only thing sharing this row is the edge click-through.
    <div className="flex h-full min-h-0 w-full min-w-0">
      <div
        ref={canvasRef}
        // `relative` so the mode toggle floats over the graph rather than over
        // a detail panel, which is this element's sibling.
        className="relative min-h-0 min-w-0 flex-1"
        data-testid="comm-graph-canvas"
        onPointerDownCapture={stopAutoPan}
        onWheelCapture={stopAutoPan}
      >
        <ReactFlow
          nodes={[...nodes]}
          edges={[...edges]}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          // The tile's view carries a `mode` React Flow has no use for, so the
          // viewport is handed over as its own three fields.
          defaultViewport={{ x: view.x, y: view.y, zoom: view.zoom }}
          // A neutral schema viewport means this graph has never been framed by
          // the user. Let React Flow derive its first viewport from every node;
          // a persisted pan/zoom still restores exactly as the user left it.
          fitView={isDefaultCommGraphView(view)}
          minZoom={COMM_GRAPH_MIN_ZOOM}
          onInit={setFlowInstance}
          onMoveStart={handleMoveStart}
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
        {modeToggle}
      </div>
      {selectedEdge === null ? null : (
        <CommGraphThreadPanel
          key={selectedEdge.id}
          edge={selectedEdge}
          epicId={epicId}
          agentNames={nameById}
          initialHistoryCaughtUp={selectedEdgeHistoryCaughtUp}
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
      <CommGraphAgentDetailSurface
        agentId={selectedAgentId}
        agents={agents}
        agentNames={nameById}
        events={events}
        epicId={epicId}
        initialHistoryCaughtUp={initialHistoryCaughtUp}
        canOpenAgentForEvent={canOpenAgentForEvent}
        canJump={canJump}
        onJump={onJump}
        canJumpToSender={canJumpToSender}
        onJumpToSender={onJumpToSender}
        canJumpToCreated={canJumpToCreated}
        onJumpToCreated={onJumpToCreated}
        onOpenAgent={onOpenAgent}
        onClose={closePanel}
      />
    </div>
  );
}
