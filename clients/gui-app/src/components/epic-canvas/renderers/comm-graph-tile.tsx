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
 * WHAT THIS MOUNT WATCHED HAPPEN: the resolved view its last render handed the
 * canvas a camera for, the Settings default it resolved through, and the
 * stored view as it stood when a default change moved that resolved view.
 *
 * The record on the view state answers the change NOBODY saw. It cannot answer
 * the change this tile watched happen over a camera saved before the record
 * existed: that camera carries `null`, which at render is indistinguishable
 * from a tile whose default never moved. The two differ by a fact about this
 * mount, so this mount is what holds it.
 *
 * `armed` IS A PLAIN FLAG, and the release is something a writer says rather
 * than something the stored value implies. It used to hold the stored view
 * OBJECT and release on identity: a writer had replaced it, and the record
 * named the arriving view. Both can be true with no office writer having run -
 * a mode switch replaces the object for free, and a record can have named that
 * view since long before the move (a tile saved under a Settings default of
 * Towers, reopened while the default is Auto, carries
 * `officeCameraView: "towers"` over a camera nothing has touched). That was
 * fixup 12's defect, and no cleverer key fixes it: a camera-object key leaks
 * on the two the reviewer named - `officeCamera: null` is a legitimate armed
 * value, so `null` cannot also be the unarmed sentinel, and a write the store
 * collapses by value produces no new reference to notice.
 *
 * So every writer that can speak FOR the arriving view calls `releaseWitness`
 * after its own write, and nothing else can release. A flag is enough once the
 * release is explicit, which is why there is no camera token here to wrap.
 */
interface OfficeCameraWitness {
  readonly view: OfficeViewId | null;
  readonly defaultChoice: OfficeViewChoice;
  readonly armed: boolean;
}

/**
 * WHICH WRITER moved the resolved view, which is the whole question.
 *
 * Auto's answer, a re-pick of Auto and an explicit pick each write the camera
 * they mean in the SAME store write, so nothing is owed once one of them has
 * landed. A Settings default change is not a write to this tile: it moves the
 * resolved view from outside, and the reset that follows is an effect - a
 * commit too late for the runtime it was meant for. So the default moving is
 * what arms this, and it is not inferred from the shape of the value (whether
 * the record differs, whether either side of the move is `null`), which is
 * what the two previous versions of this rule got wrong.
 */
function nextArmed(
  witness: OfficeCameraWitness,
  resolvedViewId: OfficeViewId | null,
  defaultChoice: OfficeViewChoice,
): boolean {
  // ARMING ONLY. This used to decide the release too, by INFERRING it from the
  // stored value: a writer had replaced the view object AND the record named
  // the arriving view. Both halves can be true with no office writer having
  // run - a mode switch replaces the object for free, and the record can have
  // named the view since long before the move - which is the defect this
  // replaces. A release is now something a writer SAYS (`releaseWitness`),
  // never something the store's shape implies.
  if (witness.view === resolvedViewId) return witness.armed;
  // The DEFAULT moving is what arms this, and it is not inferred from the
  // shape of the value (whether the record differs, whether either side of the
  // move is `null`), which is what earlier versions of this rule got wrong. An
  // Auto outcome resolving `null -> concrete` under an unchanged default is
  // not a default move and must not arm.
  return witness.defaultChoice !== defaultChoice;
}

/**
 * The witness after a render at `resolvedViewId`, or the SAME OBJECT when
 * nothing about it moved - the identity is what keeps the render-phase update
 * below conditional rather than a loop.
 */
function nextOfficeCameraWitness(
  witness: OfficeCameraWitness,
  resolvedViewId: OfficeViewId | null,
  defaultChoice: OfficeViewChoice,
): OfficeCameraWitness {
  const armed = nextArmed(witness, resolvedViewId, defaultChoice);
  if (
    witness.view === resolvedViewId &&
    witness.defaultChoice === defaultChoice &&
    witness.armed === armed
  ) {
    return witness;
  }
  return { view: resolvedViewId, defaultChoice, armed };
}

/**
 * Adjusting state DURING RENDER, which is the only place this can live.
 *
 * The replacement canvas builds its one-time runtime from the camera it is
 * handed on its first render, so evidence of a transition has to be in hand in
 * that same render: an effect is a frame too late, and a ref is not something
 * React lets a render read. React re-runs this component with the adjusted
 * state before committing, which is exactly the ordering wanted - the canvas
 * that actually mounts is the one built from the adjusted decision.
 */
function useWitnessedOfficeViewMove(
  resolvedViewId: OfficeViewId | null,
  defaultChoice: OfficeViewChoice,
): { readonly witnessedMove: boolean; readonly releaseWitness: () => void } {
  const [witness, setWitness] = useState<OfficeCameraWitness>(() => ({
    view: resolvedViewId,
    defaultChoice,
    // A fresh mount watched nothing happen: what its camera frames is the
    // record's question, and D52 answers a `null` one by keeping the framing.
    armed: false,
  }));
  const next = nextOfficeCameraWitness(witness, resolvedViewId, defaultChoice);
  if (next !== witness) setWitness(next);
  // Called by each writer that speaks FOR the arriving view, after its write.
  // A no-op when nothing is armed, and - the point of constraint 2 - it runs
  // even when the write itself was a by-value no-op in the store, so a release
  // never depends on the store growing a new object.
  const releaseWitness = useCallback(() => {
    setWitness((current) =>
      current.armed ? { ...current, armed: false } : current,
    );
  }, []);
  return { witnessedMove: next.armed, releaseWitness };
}

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
 * TWO KINDS OF EVIDENCE, because there are two ways a camera comes to frame
 * the wrong office. The record names the view a camera was saved under and is
 * what a tile reopened after a default moved has; the witness is what a tile
 * that watched the default move has, and is the only evidence a camera saved
 * before the record existed leaves behind. A `null` record on its own still
 * means "nobody framed this", which D52 keeps rather than reset.
 *
 * They are read as an OR rather than folded together on purpose: the witness
 * fires on a default change whatever the record says, including a record that
 * already names the arriving view, because a record is about the camera's past
 * and the witness is about a writer that has not run yet.
 *
 * OFFICE ONLY. The same view object is handed to the Graph canvas, where the
 * camera belongs to the Graph - neutralising it there would erase a framing
 * the office has no claim on. A witnessed move made while the Graph is up
 * stays owed and is spent on the next office render instead.
 */
function officeViewForCanvas(
  view: CommGraphTileViewState,
  resolvedViewId: OfficeViewId | null,
  witnessedMove: boolean,
): CommGraphTileViewState {
  // The Graph reads `x`, `y`, `zoom` as its own, which since D68 is exactly
  // what they are. Nothing to project.
  if (view.mode !== "office") return view;
  // Auto has not answered yet, so there is no view for a camera to be about.
  // Still projected, and deliberately: the office canvas IS mounted here (on
  // the measuring view, withheld by `ready`), and `createOfficeRuntime` reads
  // the three fields once on its first render - so handing it the raw view
  // would seat the office in the GRAPH's camera for the life of that runtime.
  if (resolvedViewId === null) return { ...view, ...NEUTRAL_CAMERA };
  const framesAnotherView =
    witnessedMove ||
    (view.officeCameraView !== null &&
      view.officeCameraView !== resolvedViewId);
  if (framesAnotherView) {
    // `officeCamera` is cleared alongside the three projected fields even
    // though the canvas never reads it: "this camera frames another view"
    // means there is no office camera for THIS one, and a projection whose
    // two halves disagreed would be a trap for the next reader. The STORE is
    // untouched - this is the value handed to the canvas, and the effect
    // below is what settles the record.
    return {
      ...view,
      ...NEUTRAL_CAMERA,
      officeCamera: null,
      officeCameraView: resolvedViewId,
    };
  }
  // THE PROJECTION. `officeCamera` is where the office's framing lives; the
  // canvas reads a plain camera and is told nothing about the split. `null`
  // becomes the neutral camera, which is what that canvas reads as "fit
  // yourself" - and what `isDefaultCommGraphView` then answers `true` for,
  // so an unframed office still arms auto-fit exactly as it always has.
  return { ...view, ...(view.officeCamera ?? NEUTRAL_CAMERA) };
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

  // The live half of the evidence below: a `null` record cannot carry a
  // default change this tile is watching happen, so the tile remembers it.
  // The raw Settings value, not `choice`: a tile with its own pick does not
  // resolve through the default, so a default that moves under one never
  // reaches the branch that arms this.
  const { witnessedMove, releaseWitness } = useWitnessedOfficeViewMove(
    resolvedViewId,
    settingsDefaultView,
  );

  // The OFFICE's camera write, which also records the view it frames. Safe to
  // close over the resolved view despite the 150ms debounce: a view change
  // remounts the canvas, and that unmount cancels the pending write - the
  // shipped "cancels a pending camera persist on unmount" case is exactly
  // this guarantee.
  const handleOfficeCameraChange = useCallback(
    (camera: CommGraphTileCamera) => {
      updateOfficeCamera(viewTabId, node.id, camera, resolvedViewId);
      // The office has framed the arriving view with its own hands, which is
      // the strongest release there is: whatever the witness was holding out
      // for has now happened.
      releaseWitness();
    },
    [node.id, releaseWitness, resolvedViewId, updateOfficeCamera, viewTabId],
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
   * DRAW READY: there is an office to draw, and a box to draw it in.
   *
   * The agent snapshot has loaded (a non-empty set: `EmptyCommGraph` below is
   * what distinguishes an empty epic from a pending one), the canvas has
   * reported a probe - which it only does once it is eligible and laid out,
   * after the directory and any panel have taken their width - and the office
   * is the mode this tile is in.
   *
   * The CAUGHT-UP FEED is deliberately NOT one of them. It was, and an office
   * that waits for it is only as available as the feed: when the local server
   * lost its database the tile drew nothing in any view for twenty-five
   * minutes while the Graph beside it drew every node from this same snapshot.
   * The office is a drawing of the AGENT LIST, which is a different input with
   * a different owner - the events decide who is busy, not who exists - so a
   * feed that is behind is a fact to say out loud (the chip below), not a
   * reason to draw nothing. Auto's own gate is the one the feed belongs to,
   * and it keeps it.
   */
  const drawReady =
    agents.length > 0 &&
    // Derived, not stored: the moment the mounted canvas changes, the old
    // canvas's measurement stops being about anything on screen.
    probeKey === canvasKey &&
    // The office is what is being measured; a tile showing the Graph has no
    // office canvas, and the last one's numbers describe a box that is gone.
    node.view.mode === "office";

  /**
   * MEASURE READY: drawable, and the population Auto measures is the settled
   * one.
   *
   * Auto partitions the office to measure how much of it fits, so a partition
   * built while the feed is still replaying would choose a view by the shape
   * of an office that is about to change - and the outcome is PERSISTED, so it
   * would outlive the half-replayed statuses it was taken from. The chip reads
   * `measuring…` for as long as this is false, which is the state the plan
   * asks for.
   */
  const measureReady = drawReady && snapshot.initialHistoryCaughtUp;

  const viewForCanvas = useMemo(
    () => officeViewForCanvas(node.view, resolvedViewId, witnessedMove),
    [node.view, resolvedViewId, witnessedMove],
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
   * This is the STORE side of that move; the witness above has already handed
   * the arriving canvas a neutral camera, so what lands here is the store
   * agreeing with a runtime that was built right, not a correction to one that
   * was not.
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
      officeCamera: null,
      officeCameraView: after,
    });
    releaseWitness();
  }, [
    node.id,
    node.view,
    releaseWitness,
    settingsDefaultView,
    updateView,
    viewTabId,
  ]);

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
    // NO MODE GATE, deliberately. This used to skip while the Graph was up,
    // because the camera it retired was the one BOTH renderers shared and
    // neutralising it would have thrown away a framing the office had no
    // claim on. D68 removed the sharing: the two fields written below are the
    // office's alone and the Graph reads neither, so this can settle its own
    // fields with the Graph on screen and no office canvas mounted at all.
    // That is what stops the Graph-mode default move from reaching the office
    // as a stale camera in the first place.
    // The RECORD arm needs a destination to compare the stamp against, so it
    // still waits for one. The WITNESS arm below does not - see there.
    const recordNamesAnotherView =
      resolvedViewId !== null &&
      node.view.officeCameraView !== null &&
      node.view.officeCameraView !== resolvedViewId;
    // The case the record cannot answer: the default moved under this tile
    // while the record ALREADY named the arriving view, so the stamp agrees
    // and the camera is stale anyway. The stamp is about the camera's past;
    // the witness is about a writer that has not run yet.
    //
    // Gated on there BEING a camera: this arm exists to retire a stale one,
    // and a witnessed move over a `null` camera has nothing to retire - the
    // projection is neutral regardless, and a stale stamp with no camera is
    // the arm above's business.
    //
    // AND IT DOES NOT WAIT FOR A DESTINATION. A default that moves to Auto
    // leaves `resolvedViewId` null until Auto answers, and this used to
    // return there - so the stale camera stayed persisted across the whole
    // interval, and Auto's keep arm then preserved it on a Floor outcome and
    // stamped the result (Finding D). A held move over a real camera is stale
    // whatever the destination turns out to be, so it is retired now and
    // stamped `null`: nobody has framed a view that has not been chosen yet.
    //
    // Settling the STORE rather than teaching the keep arm to decline is the
    // sufficient direction, and for the reason requirement 3 exists: a reload
    // in that interval loses the witness entirely, and any rule that depends
    // on it surviving is defeated by the reload the interval invites.
    const witnessDistrustsTheCamera =
      witnessedMove && node.view.officeCamera !== null;
    if (!recordNamesAnotherView && !witnessDistrustsTheCamera) return;
    updateView(viewTabId, node.id, {
      ...node.view,
      officeCamera: null,
      officeCameraView: resolvedViewId,
    });
    // This write is what RELEASES the witness, and the two are load-bearing
    // on each other: the release is explicit (a by-value no-op in the store
    // must still release), and because it always sets a camera that was
    // non-null to `null`, it always terminates rather than re-firing.
    releaseWitness();
  }, [
    node.id,
    node.view,
    releaseWitness,
    resolvedViewId,
    updateView,
    viewTabId,
    witnessedMove,
  ]);

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
    if (!measureReady) return;
    const probe = probeRef.current;
    if (probe === null) return;
    const decision = decideOfficeView(probe.input, probe.canvas);
    setAutoDecision(decision);
    // A FIRST measurement that lands anywhere but the Floor neutralises the
    // camera in the same write: a tile that predates this choice carries a
    // camera framed for the Floor, and reopening it on a Building through
    // those numbers is a view of empty space. An outcome of Floor is the view
    // that camera was for, so it keeps it.
    //
    // AND ONLY A CAMERA NOTHING DISTRUSTS. Under shape (b) the held-witness
    // arm has always retired a stale camera before Auto can answer - the move
    // that arms it also sends `resolvedViewId` to `null`, which changes the
    // canvas key, and Auto cannot decide until the remounted canvas reports a
    // fresh probe a commit later. So this guard closes nothing today; it is
    // here so the arm states the rule it relies on instead of resting on that
    // ordering, which a change to the effect's gates would silently undo.
    const camera: CommGraphTileCamera | null =
      decision.view === "floor" && !witnessedMove
        ? node.view.officeCamera
        : null;
    updateView(viewTabId, node.id, {
      ...node.view,
      officeCamera: camera,
      officeAutoView: decision.view,
      // Whichever arm ran, the camera now frames THIS view - the Floor's
      // because it was already the Floor's, the neutral one because it was
      // just made for it.
      officeCameraView: decision.view,
    });
    releaseWitness();
  }, [
    choice,
    measureReady,
    node.id,
    node.view,
    releaseWitness,
    updateView,
    witnessedMove,
    viewTabId,
  ]);

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
          officeCamera: null,
          officeView: "auto",
          officeAutoView: null,
          // Nothing is drawn until Auto answers, so the neutral camera is
          // about no view yet; Auto's own write names it.
          officeCameraView: null,
        });
        // A pick is the person naming the view themselves, which settles
        // whatever a default move left owed.
        releaseWitness();
        return;
      }
      if (next === node.view.officeView) return;
      // Picking the view that is ALREADY on screen pins it without moving
      // anything: this tile was following the settings default, or Auto had
      // landed here, and the person is nailing that down. The camera frames
      // that same office, so only a view that genuinely changes invalidates
      // it - the same reason the mode toggle guards its own reset.
      // Same rule as Auto's keep arm above, and safe by the same ordering: a
      // held witness over a real camera is retired by the effect before any
      // pick can run. Stated rather than relied upon.
      const camera: CommGraphTileCamera | null =
        next === resolvedViewId && !witnessedMove
          ? node.view.officeCamera
          : null;
      updateView(viewTabId, node.id, {
        ...node.view,
        officeCamera: camera,
        officeView: next,
        officeCameraView: next,
      });
      releaseWitness();
    },
    [
      node.id,
      node.view,
      releaseWitness,
      resolvedViewId,
      updateView,
      viewTabId,
      witnessedMove,
    ],
  );

  const handleModeChange = useCallback(
    (mode: CommGraphTileViewState["mode"]) => {
      // Pressing the mode you are already in is not a mode change.
      if (mode === node.view.mode) return;
      // D68: A MODE SWITCH IS NOT A CAMERA EVENT. Nothing is reset, in either
      // direction - the mode is the only thing that moves.
      //
      // This used to neutralise the viewport, and had to: there was one camera
      // for both renderers, measured in flow units by one and sprite pixels by
      // the other, so carrying it across would have opened the incoming mode
      // off-screen while still counting as user-framed. The reset was standing
      // in for ownership. Now each renderer HAS a camera - `x`/`y`/`zoom` are
      // the graph's, `officeCamera` the office's - so there is nothing left
      // for a switch to protect, and the reset only destroyed the framing the
      // person was going to come back to (the live re-run's N10).
      updateView(viewTabId, node.id, { ...node.view, mode });
    },
    [node.id, node.view, updateView, viewTabId],
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
            ready={resolvedViewId !== null && drawReady}
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
