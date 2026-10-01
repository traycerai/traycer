/**
 * The `comm-graph` tile body: the per-epic communication graph CANVAS.
 *
 * Cloud history is authoritative. One relay carries the epic's events,
 * preferring the epic session host among available relay candidates.
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
import {
  DEFAULT_COMM_GRAPH_VIEW,
  isNeutralCamera,
} from "@/stores/epics/canvas/tile-schema/comm-graph-tile";
import type {
  CommGraphTileCamera,
  CommGraphTileRef,
  CommGraphTileViewState,
  OfficeViewChoice,
} from "@/stores/epics/canvas/types";
import { CommGraphCanvas } from "@/components/epic-canvas/comm-graph/comm-graph-canvas";
import { CommGraphOfficeCanvas } from "@/components/epic-canvas/comm-graph/office/comm-graph-office-canvas";
import { OFFICE_VIEWS } from "@/lib/comm-graph/office/views/office-view";
import type { OfficeViewId } from "@/lib/comm-graph/office/office-types";
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
 * Building, reopened while the default is Floor, carries
 * `officeCameraView: "building"` over a camera nothing has touched). That was
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
 * An explicit view pick writes the camera
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
  resolvedViewId: OfficeViewId,
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
  return witness.defaultChoice !== defaultChoice;
}

/**
 * The witness after a render at `resolvedViewId`, or the SAME OBJECT when
 * nothing about it moved - the identity is what keeps the render-phase update
 * below conditional rather than a loop.
 */
function nextOfficeCameraWitness(
  witness: OfficeCameraWitness,
  resolvedViewId: OfficeViewId,
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
  resolvedViewId: OfficeViewId,
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
  resolvedViewId: OfficeViewId,
  witnessedMove: boolean,
): CommGraphTileViewState {
  // The Graph reads `x`, `y`, `zoom` as its own, which since D68 is exactly
  // what they are. Nothing to project.
  if (view.mode !== "office") return view;
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
  const resolvedViewId: OfficeViewId = choice;

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

  const canvasKey = `${node.view.mode}:${resolvedViewId}`;
  const drawReady = agents.length > 0 && node.view.mode === "office";

  // Only the cloud relay can declare its initial history caught up.
  const feedSettled = snapshot.initialHistoryCaughtUp;

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
    // Only a tile still FOLLOWING the default moves; an explicit pick owns its
    // own framing.
    if (node.view.officeView !== null) return;
    if (node.view.mode !== "office") return;
    const before = previous;
    if (before === settingsDefaultView) return;
    updateView(viewTabId, node.id, {
      ...node.view,
      officeCamera: null,
      officeCameraView: settingsDefaultView,
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
      node.view.officeCameraView !== null &&
      node.view.officeCameraView !== resolvedViewId;
    const witnessDistrustsTheCamera =
      witnessedMove && node.view.officeCamera !== null;
    if (!recordNamesAnotherView && !witnessDistrustsTheCamera) return;
    updateOfficeCamera(viewTabId, node.id, NEUTRAL_CAMERA, resolvedViewId);
    // The write above RELEASES the witness with it, and the two are
    // load-bearing on each other: the release is explicit (a by-value no-op in
    // the store must still release), and because it always sets a camera that
    // was non-null to `null`, it always terminates rather than re-firing.
    releaseWitness();
  }, [
    node.id,
    node.view,
    releaseWitness,
    resolvedViewId,
    updateOfficeCamera,
    viewTabId,
    witnessedMove,
  ]);

  const handleOfficeViewChange = useCallback(
    (next: OfficeViewChoice) => {
      if (next === node.view.officeView) return;
      const recordVouchesForTheCamera =
        node.view.officeCameraView === null ||
        node.view.officeCameraView === next;
      const camera: CommGraphTileCamera | null =
        next === resolvedViewId && recordVouchesForTheCamera && !witnessedMove
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

  // The office canvas registers a way to TAKE its pending, debounced framing
  // here (see `onRegisterFlush` on the canvas); `null` whenever the office is
  // not mounted or has nothing pending. A ref, not state: it is read only from
  // an event handler, and holding it in state would re-render on every
  // register.
  const officeFlushRef = useRef<(() => CommGraphTileCamera | null) | null>(
    null,
  );
  const registerOfficeFlush = useCallback(
    (take: (() => CommGraphTileCamera | null) | null) => {
      officeFlushRef.current = take;
    },
    [],
  );

  const handleModeChange = useCallback(
    (mode: CommGraphTileViewState["mode"]) => {
      // Pressing the mode you are already in is not a mode change.
      if (mode === node.view.mode) return;
      const pending =
        mode === "graph" ? (officeFlushRef.current?.() ?? null) : null;
      updateView(viewTabId, node.id, {
        ...node.view,
        ...(pending === null
          ? {}
          : {
              officeCamera: isNeutralCamera(pending) ? null : pending,
              officeCameraView: resolvedViewId,
            }),
        mode,
      });
    },
    [node.id, node.view, resolvedViewId, updateView, viewTabId],
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
    initialHistoryCaughtUp: feedSettled,
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
            key={canvasKey}
            {...canvasProps}
            onCameraChange={handleOfficeCameraChange}
            officeView={OFFICE_VIEWS[resolvedViewId]}
            ready={drawReady}
            onRegisterFlush={registerOfficeFlush}
            viewPicker={
              <OfficeViewPicker
                choice={choice}
                onChoose={handleOfficeViewChange}
              />
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
