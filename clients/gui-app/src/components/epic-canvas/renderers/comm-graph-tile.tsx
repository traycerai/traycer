/**
 * The `comm-graph` tile body: the per-epic communication graph CANVAS.
 *
 * Unlike every other tile, this one is NOT bound to a host - it opens one
 * `epic.communicationGraph.subscribe` per host the epic's agents live on and
 * merges the frames, so it must never read `useTabHostId()`.
 *
 * CANVAS PLUS TRANSPORT. The graph fills the tile and a media-player bar is
 * docked under it: play/pause, speed, and a scrubber whose track carries one
 * marker per captured event. The bar gets the FULL merged array while the canvas
 * gets the as-of-cursor prefix - the track spans everything captured, the graph
 * shows everything up to the playhead.
 *
 * The cursor itself is per-epic shared state, so closing and reopening the tile
 * does not rewind the epic's playback position.
 */
import { useCallback, useMemo } from "react";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { DEFAULT_COMM_GRAPH_VIEW } from "@/stores/epics/canvas/tile-schema/comm-graph-tile";
import type { CommGraphTileRef } from "@/stores/epics/canvas/types";
import type { CommGraphTileViewState } from "@/stores/epics/canvas/types";
import { CommGraphCanvas } from "@/components/epic-canvas/comm-graph/comm-graph-canvas";
import { CommGraphOfficeCanvas } from "@/components/epic-canvas/comm-graph/office/comm-graph-office-canvas";
import { CommGraphViewModeToggle } from "@/components/epic-canvas/comm-graph/comm-graph-view-mode-toggle";
import { useCommGraphAgents } from "@/components/epic-canvas/comm-graph/use-comm-graph-agents";
import { useCommGraphJump } from "@/components/epic-canvas/comm-graph/use-comm-graph-jump";
import { useCommGraphSnapshot } from "@/components/epic-canvas/comm-graph/use-comm-graph-snapshot";
import { useCommGraphTimelineProjection } from "@/components/epic-canvas/comm-graph/use-comm-graph-timeline";
import { CommGraphTransportBar } from "@/components/epic-canvas/comm-graph/comm-graph-transport-bar";
import {
  createCommGraphFindAdapter,
  type CommGraphFindRenderer,
} from "@/components/epic-canvas/comm-graph/comm-graph-find-adapter";
import { useRegisterTileFindAdapter } from "@/components/epic-canvas/tile-find/tile-find-adapter-context";

export interface CommGraphTileProps {
  readonly node: CommGraphTileRef;
  readonly viewTabId: string;
}

const EMPTY_COMM_GRAPH_FIND_RENDERER: CommGraphFindRenderer = {
  getNodes: () => [],
  showMatches: () => undefined,
  frameMatches: () => undefined,
  focusMatch: () => undefined,
  clear: () => undefined,
};

function EmptyCommGraph(props: { readonly tileInstanceId: string }) {
  const findAdapter = useMemo(
    () =>
      createCommGraphFindAdapter({
        tileInstanceId: props.tileInstanceId,
        renderer: EMPTY_COMM_GRAPH_FIND_RENDERER,
      }),
    [props.tileInstanceId],
  );
  useRegisterTileFindAdapter(findAdapter);

  return (
    <div className="flex h-full w-full items-center justify-center p-6 text-center text-ui-sm text-muted-foreground">
      <p data-testid="comm-graph-empty">
        No agents in this epic yet. The communication graph fills in as agents
        are created and start talking to each other.
      </p>
    </div>
  );
}

export function CommGraphTile(props: CommGraphTileProps) {
  const { node, viewTabId } = props;
  const { nodes: agents, hostIds } = useCommGraphAgents();
  const snapshot = useCommGraphSnapshot(node.epicId, hostIds);
  const projection = useCommGraphTimelineProjection(
    node.epicId,
    snapshot.events,
    agents,
    snapshot.lastArrival,
  );
  const updateView = useEpicCanvasStore((s) => s.updateCommGraphTileViewInTab);
  // The detail panels jump to source exactly like the timeline rows do - same
  // resolver, same degrade for `origin: null`.
  const {
    canOpenAgentForEvent,
    canJump,
    jump,
    canJumpToSender,
    jumpToSender,
    canJumpToCreated,
    jumpToCreated,
    openAgent,
  } = useCommGraphJump(node.epicId, agents, projection.asOfEvents);

  const handleViewChange = useCallback(
    (view: CommGraphTileViewState) => {
      updateView(viewTabId, node.id, view);
    },
    [node.id, updateView, viewTabId],
  );

  const handleModeChange = useCallback(
    (mode: CommGraphTileViewState["mode"]) => {
      // Pressing the mode you are already in is not a mode change, and the
      // reset below would throw away a framing the person chose by hand.
      if (mode === node.view.mode) return;
      // The viewport is RESET, not carried over: the two modes measure it in
      // different units (flow units against sprite pixels), so a framing chosen
      // in one is meaningless in the other and would land the incoming mode
      // off-screen with nothing to say it had. The neutral viewport is what
      // each renderer reads as "fit yourself".
      updateView(viewTabId, node.id, { ...DEFAULT_COMM_GRAPH_VIEW, mode });
    },
    [node.id, node.view.mode, updateView, viewTabId],
  );

  if (agents.length === 0) {
    return <EmptyCommGraph tileInstanceId={node.instanceId} />;
  }

  // ONE props object for both renderings: they are two drawings of the same
  // projection, so anything that reached only one of them would be a way for
  // them to disagree about what happened.
  const canvasProps = {
    epicId: node.epicId,
    // Find is registered per tile INSTANCE, by whichever renderer is mounted:
    // both speak the same adapter contract, so switching mode re-registers
    // rather than leaving the tile without a find surface.
    tileInstanceId: node.instanceId,
    agents,
    agentIds: projection.visibleAgentIds,
    events: projection.asOfEvents,
    hosts: snapshot.hosts,
    initialHistoryCaughtUp: snapshot.initialHistoryCaughtUp,
    playing: projection.playing,
    pulse: projection.pulse,
    pulseKey: projection.pulseEventKey,
    // Owned here (the view state is written here) but POSITIONED by the
    // renderer, which is the only thing that knows where its canvas ends and a
    // detail panel begins.
    modeToggle: (
      <CommGraphViewModeToggle
        mode={node.view.mode}
        onModeChange={handleModeChange}
      />
    ),
    view: node.view,
    onViewChange: handleViewChange,
    canOpenAgentForEvent,
    canJump,
    onJump: jump,
    canJumpToSender,
    onJumpToSender: jumpToSender,
    canJumpToCreated,
    onJumpToCreated: jumpToCreated,
    onOpenAgent: openAgent,
  };

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col">
      <div className="min-h-0 min-w-0 flex-1">
        {node.view.mode === "office" ? (
          <CommGraphOfficeCanvas {...canvasProps} />
        ) : (
          <CommGraphCanvas {...canvasProps} />
        )}
      </div>
      <CommGraphTransportBar epicId={node.epicId} events={snapshot.events} />
    </div>
  );
}
