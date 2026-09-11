/**
 * The `comm-graph` tile body: the per-epic communication graph CANVAS.
 *
 * Unlike every other tile, this one is NOT bound to a host on the LOCAL plane -
 * it opens one `epic.communicationGraph.subscribe` per host the epic's agents
 * live on and merges the frames, so it must never read `useTabHostId()` (its
 * own ref carries an inert placeholder host for exactly that reason).
 *
 * The CLOUD relay is a separate question and rides the tab's host. The cloud
 * feed is the same rows from any relay, so the only thing that choice decides
 * is which link carries it - and this epic tab is already riding one, which is
 * the host `useEpicSessionHostId()` names. That host is passed down to
 * `useCommGraphSnapshot`, which puts it first among the dialable relay
 * candidates and keeps the rest in ID order as failover. The per-host local
 * merge above is untouched by it.
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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { DEFAULT_COMM_GRAPH_VIEW } from "@/stores/epics/canvas/tile-schema/comm-graph-tile";
import type {
  CommGraphTileCamera,
  CommGraphTileRef,
  CommGraphTileViewState,
  OfficeViewChoice,
} from "@/stores/epics/canvas/types";
import { CommGraphCanvas } from "@/components/epic-canvas/comm-graph/comm-graph-canvas";
import { CommGraphOfficeCanvas } from "@/components/epic-canvas/comm-graph/office/comm-graph-office-canvas";
import { OFFICE_VIEWS } from "@/lib/comm-graph/office/views/office-view";
import {
  decideOfficeView,
  type OfficeAutoDecision,
  type OfficeAutoProbe,
} from "@/lib/comm-graph/office/office-auto";
import type { OfficeViewId } from "@/lib/comm-graph/office/office-types";
import { OfficeAutoChip } from "@/components/epic-canvas/comm-graph/office/office-auto-chip";
import { OfficeViewPicker } from "@/components/epic-canvas/comm-graph/office/office-view-picker";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { CommGraphViewModeToggle } from "@/components/epic-canvas/comm-graph/comm-graph-view-mode-toggle";
import { useCommGraphAgents } from "@/components/epic-canvas/comm-graph/use-comm-graph-agents";
import { useCommGraphJump } from "@/components/epic-canvas/comm-graph/use-comm-graph-jump";
import { useCommGraphSnapshot } from "@/components/epic-canvas/comm-graph/use-comm-graph-snapshot";
import { useEpicSessionHostId } from "@/hooks/epic/use-epic-session-host-id";
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

/**
 * What a canvas that does not know its view yet is mounted as.
 *
 * It has to be mounted to be MEASURED - the box Auto decides on is the one
 * left after the directory and the panels - but `ready` is false until Auto
 * answers, so this view is never planned and never drawn. The Floor is the
 * fallback everywhere else in the office for the same reason: it is the one
 * view that has always existed.
 */
const MEASURING_VIEW_ID: OfficeViewId = "floor";

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
  // The Epic SESSION's host - the machine this epic tab rides. NOT
  // `useTabHostId()`: this tile's own binding is the inert placeholder.
  const tabHostId = useEpicSessionHostId();
  const snapshot = useCommGraphSnapshot(node.epicId, hostIds, tabHostId);
  const projection = useCommGraphTimelineProjection(
    node.epicId,
    snapshot.events,
    agents,
    snapshot.lastArrival,
  );
  const updateView = useEpicCanvasStore((s) => s.updateCommGraphTileViewInTab);
  const updateCamera = useEpicCanvasStore(
    (s) => s.updateCommGraphTileCameraInTab,
  );
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

  // The CAMERA, patched. A renderer knows where it has been panned to and
  // nothing else, and its write lands on a debounce - so a whole-value write
  // from one would put back whatever mode and view choice that renderer last
  // rendered, undoing a pick made while the pan was settling.
  const handleCameraChange = useCallback(
    (camera: CommGraphTileCamera) => {
      updateCamera(viewTabId, node.id, camera);
    },
    [node.id, updateCamera, viewTabId],
  );

  // The default for a tile nobody has chosen a view for. A CHANGE to it moves
  // this tile only while `officeView` is still null - which is what makes it a
  // default rather than a setting every office follows.
  const settingsDefaultView = useSettingsStore(
    (state) => state.agentOfficeDefaultView,
  );
  const choice: OfficeViewChoice = node.view.officeView ?? settingsDefaultView;
  // `null` means "Auto has not answered yet", which is the one state where
  // this tile does not know what it is drawing.
  const resolvedViewId: OfficeViewId | null =
    choice === "auto" ? node.view.officeAutoView : choice;

  // Auto's own state: the measurement in hand (for the chip and the picker's
  // Auto row), and a revision that ticks on every re-pick.
  const [autoDecision, setAutoDecision] = useState<OfficeAutoDecision | null>(
    null,
  );
  const [autoRevision, setAutoRevision] = useState(0);
  // The latest probe, in a ref: it changes with every batch of rows, and the
  // decision reads it once. Holding it in state would re-render this tile -
  // and with it the canvas - on every event that arrives.
  const probeRef = useRef<OfficeAutoProbe | null>(null);
  const [probeReady, setProbeReady] = useState(false);
  const handleAutoProbe = useCallback((probe: OfficeAutoProbe) => {
    probeRef.current = probe;
    // Only the FIRST one is news; React bails out on the rest.
    setProbeReady(true);
  }, []);

  /**
   * READY: the tile knows which view this is, and the inputs behind that are
   * the real ones.
   *
   * Three conditions, each of which was wrong on its own. The agent snapshot
   * has loaded (`EmptyCommGraph` above is what distinguishes an empty epic
   * from a pending one), the comm-graph feed has replayed its initial batch,
   * and the canvas has reported a box - which it only does once it is eligible
   * and laid out, after the directory and any panel have taken their width.
   */
  const inputsReady = snapshot.initialHistoryCaughtUp && probeReady;

  /**
   * AUTO, run ONCE per decision and persisted.
   *
   * The gate is `officeAutoView === null`: a measured outcome is written to
   * the tile, so a mode toggle, an LRU remount or a restart re-reads it rather
   * than re-deciding - which is what keeps a saved camera pointing at the view
   * it was saved on.
   */
  useEffect(() => {
    if (choice !== "auto" || node.view.officeAutoView !== null) return;
    if (!inputsReady) return;
    const probe = probeRef.current;
    if (probe === null) return;
    const decision = decideOfficeView(probe.input, probe.canvas);
    setAutoDecision(decision);
    // A FIRST measurement that lands anywhere but the Floor neutralises the
    // camera in the same write: a tile that predates this choice carries a
    // camera framed for the Floor, and reopening it on a Building through
    // those numbers is a view of empty space. An outcome of Floor is the view
    // that camera was for, so it keeps it.
    const camera: CommGraphTileCamera =
      decision.view === "floor"
        ? { x: node.view.x, y: node.view.y, zoom: node.view.zoom }
        : {
            x: DEFAULT_COMM_GRAPH_VIEW.x,
            y: DEFAULT_COMM_GRAPH_VIEW.y,
            zoom: DEFAULT_COMM_GRAPH_VIEW.zoom,
          };
    updateView(viewTabId, node.id, {
      ...node.view,
      ...camera,
      officeAutoView: decision.view,
    });
  }, [choice, inputsReady, node.id, node.view, updateView, viewTabId]);

  /**
   * A pick. Choosing the view you are already on is a no-op - EXCEPT Auto,
   * which is a command rather than a value: an epic that has doubled in size
   * since it was measured is exactly when somebody asks again.
   */
  const handleOfficeViewChange = useCallback(
    (next: OfficeViewChoice) => {
      if (next === node.view.officeView && next !== "auto") return;
      if (next === "auto") {
        setAutoDecision(null);
        // What makes a re-pick that lands on the SAME view still remount: the
        // key carries this, so the office is re-partitioned from scratch
        // rather than kept because the answer happened not to change.
        setAutoRevision((revision) => revision + 1);
      }
      // The camera is RESET: it framed the view being left, and its numbers
      // mean nothing in the one arriving.
      updateView(viewTabId, node.id, {
        ...node.view,
        x: DEFAULT_COMM_GRAPH_VIEW.x,
        y: DEFAULT_COMM_GRAPH_VIEW.y,
        zoom: DEFAULT_COMM_GRAPH_VIEW.zoom,
        officeView: next,
        officeAutoView: next === "auto" ? null : node.view.officeAutoView,
      });
    },
    [node.id, node.view, updateView, viewTabId],
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
      //
      // The OFFICE CHOICES ride through, spread from the current value rather
      // than taken from the default: going to the graph and back is not a
      // statement about which office you want, and rebuilding from the default
      // would answer it with "whatever Settings says" every time.
      updateView(viewTabId, node.id, {
        ...DEFAULT_COMM_GRAPH_VIEW,
        mode,
        officeView: node.view.officeView,
        officeAutoView: node.view.officeAutoView,
      });
    },
    [
      node.id,
      node.view.mode,
      node.view.officeView,
      node.view.officeAutoView,
      updateView,
      viewTabId,
    ],
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
        // The office lays its chrome out as one ROW and places this in it; the
        // node graph has no row, so there the toggle keeps pinning itself to
        // the canvas's top-right corner.
        className={node.view.mode === "office" ? "static" : undefined}
      />
    ),
    view: node.view,
    onCameraChange: handleCameraChange,
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
          <CommGraphOfficeCanvas
            // ONE VIEW ALIVE, by construction. A view change is an unmount and
            // a mount through the path a mode change already takes, so the
            // existing cleanup releases the scene, the runtime, the frame
            // gate, both observers, the static layer and the persist debounce,
            // and the new mount builds exactly one scene for exactly one view.
            // The revision is what makes a re-pick of Auto that lands on the
            // same view remount anyway.
            key={`${resolvedViewId ?? "measuring"}:${autoRevision}`}
            {...canvasProps}
            officeView={OFFICE_VIEWS[resolvedViewId ?? MEASURING_VIEW_ID]}
            ready={resolvedViewId !== null}
            onAutoProbe={handleAutoProbe}
            viewPicker={
              <OfficeViewPicker
                choice={choice}
                autoViewId={resolvedViewId}
                decision={autoDecision}
                onChoose={handleOfficeViewChange}
              />
            }
            autoChip={
              choice === "auto" ? (
                <OfficeAutoChip decision={autoDecision} />
              ) : null
            }
          />
        ) : (
          <CommGraphCanvas {...canvasProps} />
        )}
      </div>
      <CommGraphTransportBar epicId={node.epicId} events={snapshot.events} />
    </div>
  );
}
