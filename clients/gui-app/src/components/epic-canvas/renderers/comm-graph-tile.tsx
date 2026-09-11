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
import { officeBenchOverride } from "@/components/epic-canvas/comm-graph/office/office-bench";
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

/**
 * The framing a tile gets when the office under it changes out from under the
 * camera. Pan and zoom are in the ARRIVING view's coordinates, and a Floor's
 * numbers read as empty space in a Building, so they are not carried across.
 */
const NEUTRAL_CAMERA: CommGraphTileCamera = {
  x: DEFAULT_COMM_GRAPH_VIEW.x,
  y: DEFAULT_COMM_GRAPH_VIEW.y,
  zoom: DEFAULT_COMM_GRAPH_VIEW.zoom,
};

/**
 * THE CAMERA THE CANVAS IS BUILT WITH - decided here, in render, not in an
 * effect.
 *
 * A view change swaps the canvas's key, and the replacement builds its
 * one-time runtime from the camera it is handed on its FIRST render
 * (`createOfficeRuntime` reads x/y/zoom once and keeps them). An effect that
 * resets the store afterwards is too late: the runtime is already framing
 * `{2500, 5000}` in a world that ends at `{1376, 320}`, and the next wheel
 * persists those coordinates stamped with the new view. The store writes that
 * follow this merely make the record agree with what the canvas already has.
 *
 * The record is the only evidence available at render, and it is enough: a
 * default change necessarily leaves it naming the view being left, so one test
 * covers both the change nobody saw and the change that just happened. A
 * `null` record means nobody framed this camera, which for any tile created
 * since the field existed means it is neutral already.
 *
 * OFFICE ONLY. The same view object is handed to the Graph canvas, where the
 * camera belongs to the Graph - neutralising it there would erase a framing
 * the office has no claim on.
 */
function officeViewForCanvas(
  view: CommGraphTileViewState,
  resolvedViewId: OfficeViewId | null,
): CommGraphTileViewState {
  if (view.mode !== "office") return view;
  if (resolvedViewId === null) return view;
  if (view.officeCameraView === null) return view;
  if (view.officeCameraView === resolvedViewId) return view;
  return { ...view, ...NEUTRAL_CAMERA, officeCameraView: resolvedViewId };
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
  const { nodes: epicAgents, hostIds } = useCommGraphAgents();
  // THE DEV BENCH, substituted as far upstream as there is: everything below -
  // the timeline projection, the visible set, the partition, the plan - runs on
  // whatever this is, so a benched office is the office. `null` in production,
  // where the whole thing folds away. The SUBSCRIPTIONS stay on the real epic's
  // hosts: a synthetic agent's host is a label, not a machine to dial.
  const agents = officeBenchOverride() ?? epicAgents;
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
  const updateOfficeCamera = useEpicCanvasStore(
    (s) => s.updateCommGraphTileOfficeCameraInTab,
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

  // The OFFICE's camera write, which also records the view it frames. Safe to
  // close over the resolved view despite the 150ms debounce: a view change
  // remounts the canvas, and that unmount cancels the pending write - the
  // shipped "cancels a pending camera persist on unmount" case is exactly
  // this guarantee.
  const handleOfficeCameraChange = useCallback(
    (camera: CommGraphTileCamera) => {
      updateOfficeCamera(viewTabId, node.id, camera, resolvedViewId);
    },
    [node.id, resolvedViewId, updateOfficeCamera, viewTabId],
  );

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
  /**
   * WHICH CANVAS the measurement in `probeRef` came from, or `null` for none.
   *
   * State rather than a ref because validity is read during render, and a
   * string rather than a boolean because that is what makes a stale
   * measurement impossible instead of merely short-lived: a probe is valid
   * exactly while the canvas that reported it is still the one mounted. Every
   * later report for the SAME canvas sets the same string, which React bails
   * out of, so a batch of rows costs no render.
   */
  const [probeKey, setProbeKey] = useState<string | null>(null);
  /**
   * WHICH CANVAS a measurement would be about: the mounted view, the Auto
   * request that asked for it, and the mode the tile is in.
   *
   * The canvas withdraws its own probe when it goes, but it cannot be relied
   * on to get the word out first - a torn-down canvas reports nothing - so the
   * tile drops the measurement on its own transitions as well. Same string as
   * the mount key below, deliberately: what remounts the canvas is exactly
   * what invalidates its measurement.
   */
  const canvasKey = `${node.view.mode}:${resolvedViewId ?? "measuring"}:${autoRevision}`;

  /**
   * A measurement is a claim about ONE canvas, and it is WITHDRAWN when that
   * canvas stops being the one on screen.
   *
   * The canvas reports `null` when it loses eligibility or unmounts - a
   * remount, a re-pick of Auto, a switch to Graph - because merely ceasing to
   * emit would leave the last measurement standing. A decision taken from a
   * departed canvas is a decision about a box that is no longer there: it
   * picked an office while the tile was hidden, wrote a neutral camera over
   * the Graph's, and answered a re-pick from the box the detail panel had
   * shrunk. Withdrawal is what makes the next decision wait for the new box.
   */
  const handleAutoProbe = useCallback(
    (probe: OfficeAutoProbe | null) => {
      probeRef.current = probe;
      setProbeKey(probe === null ? null : canvasKey);
    },
    [canvasKey],
  );

  /**
   * READY: the tile knows which view this is, and the inputs behind that are
   * the real ones.
   *
   * Three conditions, each of which was wrong on its own. The agent snapshot
   * has loaded (a non-empty set: `EmptyCommGraph` below is what distinguishes
   * an empty epic from a pending one), the comm-graph feed has replayed its
   * initial batch, and the canvas has reported a probe - which it only does
   * once it is eligible and laid out, after the directory and any panel have
   * taken their width.
   */
  const inputsReady =
    agents.length > 0 &&
    snapshot.initialHistoryCaughtUp &&
    // Derived, not stored: the moment the mounted canvas changes, the old
    // canvas's measurement stops being about anything on screen.
    probeKey === canvasKey &&
    // The office is what is being measured; a tile showing the Graph has no
    // office canvas, and the last one's numbers describe a box that is gone.
    node.view.mode === "office";

  const viewForCanvas = useMemo(
    () => officeViewForCanvas(node.view, resolvedViewId),
    [node.view, resolvedViewId],
  );

  /**
   * A default that changes WHILE THIS TILE WATCHES owes the camera the same
   * reset a pick does.
   *
   * Kept as its own rule beside the record below, because the two answer
   * different questions. This one knows the default moved just now, so it
   * resets whatever the record says - including a tile from before the record
   * existed, which is the reviewer's own reproduction. The record answers the
   * case nobody was here to see.
   *
   * Only a tile still FOLLOWING the default is moved - an explicit pick and
   * its framing are nobody else's to touch - and only when the resolved view
   * actually changes, so switching between two defaults this tile resolves
   * identically moves nothing.
   */
  const followedDefaultRef = useRef<OfficeViewChoice>(settingsDefaultView);
  useEffect(() => {
    const previous = followedDefaultRef.current;
    if (previous === settingsDefaultView) return;
    followedDefaultRef.current = settingsDefaultView;
    // NOT while the Graph is on screen. The camera in the store is the
    // Graph's, and neutralising it here would throw away a framing the office
    // has no claim on. The mismatch this leaves in the record is the carrier:
    // the next office mount reads it and resets at render, above.
    if (node.view.mode !== "office") return;
    if (node.view.officeView !== null) return;
    const before = previous === "auto" ? node.view.officeAutoView : previous;
    const after =
      settingsDefaultView === "auto"
        ? node.view.officeAutoView
        : settingsDefaultView;
    if (before === after) return;
    updateView(viewTabId, node.id, {
      ...node.view,
      ...NEUTRAL_CAMERA,
      officeCameraView: after,
    });
  }, [node.id, node.view, settingsDefaultView, updateView, viewTabId]);

  /**
   * THE CAMERA IS ABOUT A VIEW, and stops meaning anything when that view
   * changes underneath it.
   *
   * The case the effect above cannot see: the default moved while this tile
   * was CLOSED, and it has just reopened over coordinates that addressed a
   * different floor. Nothing in this mount witnessed the change, so the only
   * evidence is the record the camera carries.
   *
   * A `null` record means nobody framed this camera, which is why a tile saved
   * before this field existed keeps its framing rather than being reset on
   * first sight. Equal means the numbers still describe what is drawn. The
   * write carries the new view with it, so this settles in one pass instead of
   * firing on every render.
   *
   * A PICK never reaches here: it writes the camera and the record together,
   * so they already agree by the time this runs.
   *
   * ONE GAP, and it closes itself: a tile persisted before this field existed
   * carries no record, so a default changed while it was closed keeps the old
   * framing once. The alternative - treating "no record" as "reset" - would
   * throw away the framing of every saved tile on the upgrade, which is the
   * worse of the two. It self-heals on first contact: any office camera write
   * records the view, and a default change seen while mounted resets anyway.
   */
  useEffect(() => {
    // NOT while the Graph owns the camera. `resolvedViewId` is derived from
    // the choice and the Settings default, neither of which knows what mode
    // this tile is in - so a stale office record mismatching the current
    // office default would fire here and neutralise the GRAPH's stored
    // camera, with no office canvas even mounted. The render-time decision is
    // gated the same way; this is the store-side half of the same rule, and
    // the mismatch it declines to act on is carried to the next office mount.
    if (node.view.mode !== "office") return;
    if (resolvedViewId === null) return;
    if (node.view.officeCameraView === null) return;
    if (node.view.officeCameraView === resolvedViewId) return;
    updateView(viewTabId, node.id, {
      ...node.view,
      ...NEUTRAL_CAMERA,
      officeCameraView: resolvedViewId,
    });
  }, [node.id, node.view, resolvedViewId, updateView, viewTabId]);

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
        : NEUTRAL_CAMERA;
    updateView(viewTabId, node.id, {
      ...node.view,
      ...camera,
      officeAutoView: decision.view,
      // Whichever arm ran, the camera now frames THIS view - the Floor's
      // because it was already the Floor's, the neutral one because it was
      // just made for it.
      officeCameraView: decision.view,
    });
  }, [choice, inputsReady, node.id, node.view, updateView, viewTabId]);

  /**
   * A pick. Choosing the view you are already on is a no-op - EXCEPT Auto,
   * which is a command rather than a value: an epic that has doubled in size
   * since it was measured is exactly when somebody asks again.
   */
  const handleOfficeViewChange = useCallback(
    (next: OfficeViewChoice) => {
      if (next === "auto") {
        setAutoDecision(null);
        // What makes a re-pick that lands on the SAME view still remount: the
        // key carries this, so the office is re-partitioned from scratch
        // rather than kept because the answer happened not to change.
        setAutoRevision((revision) => revision + 1);
        updateView(viewTabId, node.id, {
          ...node.view,
          ...NEUTRAL_CAMERA,
          officeView: "auto",
          officeAutoView: null,
          // Nothing is drawn until Auto answers, so the neutral camera is
          // about no view yet; Auto's own write names it.
          officeCameraView: null,
        });
        return;
      }
      if (next === node.view.officeView) return;
      // Picking the view that is ALREADY on screen pins it without moving
      // anything: this tile was following the settings default, or Auto had
      // landed here, and the person is nailing that down. The camera frames
      // that same office, so only a view that genuinely changes invalidates
      // it - the same reason the mode toggle guards its own reset.
      const camera: CommGraphTileCamera =
        next === resolvedViewId
          ? { x: node.view.x, y: node.view.y, zoom: node.view.zoom }
          : NEUTRAL_CAMERA;
      updateView(viewTabId, node.id, {
        ...node.view,
        ...camera,
        officeView: next,
        officeCameraView: next,
      });
    },
    [node.id, node.view, resolvedViewId, updateView, viewTabId],
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
    // NOT `node.view`: a camera framed under another office is neutralised
    // before the canvas is built from it, never after.
    view: viewForCanvas,
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
            key={canvasKey}
            {...canvasProps}
            onCameraChange={handleOfficeCameraChange}
            officeView={OFFICE_VIEWS[resolvedViewId ?? MEASURING_VIEW_ID]}
            ready={resolvedViewId !== null && inputsReady}
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
                <OfficeAutoChip
                  decision={autoDecision}
                  restoredView={node.view.officeAutoView}
                />
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
