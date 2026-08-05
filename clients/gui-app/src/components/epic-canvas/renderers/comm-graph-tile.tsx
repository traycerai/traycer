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
import { useCallback } from "react";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type { CommGraphTileRef } from "@/stores/epics/canvas/types";
import type { CommGraphTileViewState } from "@/stores/epics/canvas/types";
import { CommGraphCanvas } from "@/components/epic-canvas/comm-graph/comm-graph-canvas";
import { useCommGraphAgents } from "@/components/epic-canvas/comm-graph/use-comm-graph-agents";
import { useCommGraphJump } from "@/components/epic-canvas/comm-graph/use-comm-graph-jump";
import { useCommGraphSnapshot } from "@/components/epic-canvas/comm-graph/use-comm-graph-snapshot";
import { useCommGraphTimelineProjection } from "@/components/epic-canvas/comm-graph/use-comm-graph-timeline";
import { CommGraphTransportBar } from "@/components/epic-canvas/comm-graph/comm-graph-transport-bar";

export interface CommGraphTileProps {
  readonly node: CommGraphTileRef;
  readonly viewTabId: string;
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

  if (agents.length === 0) {
    return (
      <div className="flex h-full w-full items-center justify-center p-6 text-center text-ui-sm text-muted-foreground">
        <p data-testid="comm-graph-empty">
          No agents in this epic yet. The communication graph fills in as agents
          are created and start talking to each other.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col">
      <div className="min-h-0 min-w-0 flex-1">
        <CommGraphCanvas
          epicId={node.epicId}
          agents={agents}
          agentIds={projection.visibleAgentIds}
          events={projection.asOfEvents}
          hosts={snapshot.hosts}
          pulse={projection.pulse}
          view={node.view}
          onViewChange={handleViewChange}
          canOpenAgentForEvent={canOpenAgentForEvent}
          canJump={canJump}
          onJump={jump}
          canJumpToSender={canJumpToSender}
          onJumpToSender={jumpToSender}
          canJumpToCreated={canJumpToCreated}
          onJumpToCreated={jumpToCreated}
          onOpenAgent={openAgent}
        />
      </div>
      <CommGraphTransportBar epicId={node.epicId} events={snapshot.events} />
    </div>
  );
}
