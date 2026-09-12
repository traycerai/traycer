import { describe, expect, it } from "vitest";
import {
  isTileRefRecordBacked,
  parseTileRef,
  serializeTileRef,
} from "@/stores/epics/canvas/tile-schema";
import {
  commGraphTileId,
  isDefaultCommGraphView,
  makeCommGraphTileRef,
  DEFAULT_COMM_GRAPH_VIEW,
} from "@/stores/epics/canvas/tile-schema/comm-graph-tile";
import {
  updateCommGraphTileCamera,
  updateCommGraphTileOfficeCamera,
  updateCommGraphTileView,
} from "@/stores/epics/canvas/actions";
import { UNKNOWN_HOST_PLACEHOLDER } from "@/lib/host/constants";
import type { EpicCanvasState } from "@/stores/epics/canvas/types";

const EPIC_ID = "epic-1";

describe("comm-graph tile schema", () => {
  it("computes an epic-scoped id so reopening dedups onto one tile", () => {
    expect(makeCommGraphTileRef(EPIC_ID).id).toBe(commGraphTileId(EPIC_ID));
    expect(makeCommGraphTileRef(EPIC_ID).id).not.toBe(
      commGraphTileId("epic-2"),
    );
  });

  it("carries no host binding - the tile fans in across hosts", () => {
    expect(makeCommGraphTileRef(EPIC_ID).hostId).toBe(UNKNOWN_HOST_PLACEHOLDER);
  });

  it("is not record-backed, so a missing artifact never marks it deleted", () => {
    expect(isTileRefRecordBacked(makeCommGraphTileRef(EPIC_ID))).toBe(false);
  });

  it("round-trips through serialize / parse", () => {
    const ref = {
      ...makeCommGraphTileRef(EPIC_ID),
      view: {
        ...DEFAULT_COMM_GRAPH_VIEW,
        x: 12,
        y: -30,
        zoom: 1.5,
        mode: "graph" as const,
      },
    };
    expect(parseTileRef(serializeTileRef(ref))).toEqual(ref);
  });

  it("round-trips a real officeView and officeAutoView choice", () => {
    const ref = {
      ...makeCommGraphTileRef(EPIC_ID),
      view: {
        ...DEFAULT_COMM_GRAPH_VIEW,
        x: 12,
        y: -30,
        zoom: 1.5,
        mode: "office" as const,
        officeView: "towers" as const,
        officeAutoView: "building" as const,
      },
    };
    expect(parseTileRef(serializeTileRef(ref))).toEqual(ref);
  });

  it('round-trips officeView: "auto" as a real choice, not a degrade', () => {
    const ref = {
      ...makeCommGraphTileRef(EPIC_ID),
      view: {
        ...DEFAULT_COMM_GRAPH_VIEW,
        officeView: "auto" as const,
        officeAutoView: "building" as const,
      },
    };
    const parsed = parseTileRef(serializeTileRef(ref));
    expect(parsed?.type).toBe("comm-graph");
    if (parsed === null || parsed.type !== "comm-graph") return;
    expect(parsed.view.officeView).toBe("auto");
    expect(parsed.view.officeAutoView).toBe("building");
  });

  it("degrades an officeView this build does not register, resetting the camera", () => {
    const parsed = parseTileRef({
      id: commGraphTileId(EPIC_ID),
      instanceId: "inst-1",
      type: "comm-graph",
      name: "Agent office",
      hostId: UNKNOWN_HOST_PLACEHOLDER,
      epicId: EPIC_ID,
      view: {
        x: 400,
        y: -220,
        zoom: 3,
        mode: "office",
        // A view id no build ships: the case is about a value from a BUILD
        // this one is older than, and every id in the contract is registered
        // here now.
        officeView: "atrium",
        officeAutoView: "building",
      },
    });
    expect(parsed?.type).toBe("comm-graph");
    if (parsed === null || parsed.type !== "comm-graph") return;
    expect(parsed.view.officeView).toBeNull();
    // A camera saved against a view this build cannot draw would reopen the
    // fallback view scrolled off into empty space, so it resets in the same
    // parse rather than surviving the degrade.
    expect(parsed.view.x).toBe(DEFAULT_COMM_GRAPH_VIEW.x);
    expect(parsed.view.y).toBe(DEFAULT_COMM_GRAPH_VIEW.y);
    expect(parsed.view.zoom).toBe(DEFAULT_COMM_GRAPH_VIEW.zoom);
  });

  it("degrades an officeAutoView this build does not register, resetting the camera", () => {
    const parsed = parseTileRef({
      id: commGraphTileId(EPIC_ID),
      instanceId: "inst-1",
      type: "comm-graph",
      name: "Agent office",
      hostId: UNKNOWN_HOST_PLACEHOLDER,
      epicId: EPIC_ID,
      view: {
        x: 400,
        y: -220,
        zoom: 3,
        mode: "office",
        officeView: "towers",
        officeAutoView: "atrium",
      },
    });
    expect(parsed?.type).toBe("comm-graph");
    if (parsed === null || parsed.type !== "comm-graph") return;
    // The two fields degrade independently; only the auto outcome is gone.
    expect(parsed.view.officeView).toBe("towers");
    expect(parsed.view.officeAutoView).toBeNull();
    expect(parsed.view.x).toBe(DEFAULT_COMM_GRAPH_VIEW.x);
    expect(parsed.view.y).toBe(DEFAULT_COMM_GRAPH_VIEW.y);
    expect(parsed.view.zoom).toBe(DEFAULT_COMM_GRAPH_VIEW.zoom);
  });

  it('degrades "auto" as an officeAutoView, since it is a measured outcome, not a choice', () => {
    const parsed = parseTileRef({
      id: commGraphTileId(EPIC_ID),
      instanceId: "inst-1",
      type: "comm-graph",
      name: "Agent office",
      hostId: UNKNOWN_HOST_PLACEHOLDER,
      epicId: EPIC_ID,
      view: {
        x: 0,
        y: 0,
        zoom: 1,
        mode: "office",
        officeView: "auto",
        officeAutoView: "auto",
      },
    });
    expect(parsed?.type).toBe("comm-graph");
    if (parsed === null || parsed.type !== "comm-graph") return;
    expect(parsed.view.officeView).toBe("auto");
    expect(parsed.view.officeAutoView).toBeNull();
  });

  it("degrades an officeCameraView this build does not register, resetting the camera", () => {
    const parsed = parseTileRef({
      id: commGraphTileId(EPIC_ID),
      instanceId: "inst-1",
      type: "comm-graph",
      name: "Agent office",
      hostId: UNKNOWN_HOST_PLACEHOLDER,
      epicId: EPIC_ID,
      view: {
        x: 400,
        y: -220,
        zoom: 3,
        mode: "office",
        officeView: "towers",
        officeAutoView: "building",
        // Like `officeView` and `officeAutoView`, a value from a build newer
        // than this one degrades to null - and, like them, that degrade
        // resets the camera in the same parse rather than surviving it.
        officeCameraView: "atrium",
      },
    });
    expect(parsed?.type).toBe("comm-graph");
    if (parsed === null || parsed.type !== "comm-graph") return;
    expect(parsed.view.officeCameraView).toBeNull();
    // The other two fields degrade independently.
    expect(parsed.view.officeView).toBe("towers");
    expect(parsed.view.officeAutoView).toBe("building");
    expect(parsed.view.x).toBe(DEFAULT_COMM_GRAPH_VIEW.x);
    expect(parsed.view.y).toBe(DEFAULT_COMM_GRAPH_VIEW.y);
    expect(parsed.view.zoom).toBe(DEFAULT_COMM_GRAPH_VIEW.zoom);
  });

  it("keeps an absent officeView/officeAutoView as null WITHOUT resetting the camera", () => {
    // A tile saved before these fields existed predates the choice entirely -
    // that is not the same thing as a value this build cannot read, and its
    // owner's framing must survive.
    //
    // D68: this IS the migration case. The record predates `officeCamera`
    // entirely, it is in `office` mode, and its camera is not the neutral
    // default - so those numbers are the office's, and the owner's framing
    // still survives, just under the field that now owns it. `x`/`y`/`zoom`
    // are the GRAPH's since D68, and the graph never framed anything here.
    const parsed = parseTileRef({
      id: commGraphTileId(EPIC_ID),
      instanceId: "inst-1",
      type: "comm-graph",
      name: "Agent office",
      hostId: UNKNOWN_HOST_PLACEHOLDER,
      epicId: EPIC_ID,
      view: { x: 4, y: 5, zoom: 2, mode: "office" },
    });
    expect(parsed?.type).toBe("comm-graph");
    if (parsed === null || parsed.type !== "comm-graph") return;
    expect(parsed.view.officeView).toBeNull();
    expect(parsed.view.officeAutoView).toBeNull();
    expect(parsed.view.officeCamera).toEqual({ x: 4, y: 5, zoom: 2 });
    expect(parsed.view.x).toBe(DEFAULT_COMM_GRAPH_VIEW.x);
    expect(parsed.view.y).toBe(DEFAULT_COMM_GRAPH_VIEW.y);
    expect(parsed.view.zoom).toBe(DEFAULT_COMM_GRAPH_VIEW.zoom);
  });

  it("keeps an explicitly persisted null officeView/officeAutoView WITHOUT resetting the camera", () => {
    // A persisted `null` and an absent field are the SAME thing - never
    // chosen - and neither is a degrade; only an unreadable non-null value is.
    //
    // D68: the migration case again, this time with the two fields spelled
    // out as `null` rather than left absent - `officeCamera` is still absent,
    // so the same numbers still migrate to it, untouched by the explicit
    // nulls beside them.
    const parsed = parseTileRef({
      id: commGraphTileId(EPIC_ID),
      instanceId: "inst-1",
      type: "comm-graph",
      name: "Agent office",
      hostId: UNKNOWN_HOST_PLACEHOLDER,
      epicId: EPIC_ID,
      view: {
        x: 4,
        y: 5,
        zoom: 2,
        mode: "office",
        officeView: null,
        officeAutoView: null,
      },
    });
    expect(parsed?.type).toBe("comm-graph");
    if (parsed === null || parsed.type !== "comm-graph") return;
    expect(parsed.view.officeView).toBeNull();
    expect(parsed.view.officeAutoView).toBeNull();
    expect(parsed.view.officeCamera).toEqual({ x: 4, y: 5, zoom: 2 });
    expect(parsed.view.x).toBe(DEFAULT_COMM_GRAPH_VIEW.x);
    expect(parsed.view.y).toBe(DEFAULT_COMM_GRAPH_VIEW.y);
    expect(parsed.view.zoom).toBe(DEFAULT_COMM_GRAPH_VIEW.zoom);
  });

  it("opens a NEWLY CREATED tile on the office floor", () => {
    // The new-tile default and the parse fallback deliberately disagree: the
    // floor is the better first look, but only for a tile that has no history
    // of rendering anything else.
    expect(makeCommGraphTileRef(EPIC_ID).view.mode).toBe("office");
  });

  it("reads a tile persisted before the mode existed as the graph", () => {
    const parsed = parseTileRef({
      id: commGraphTileId(EPIC_ID),
      instanceId: "inst-1",
      type: "comm-graph",
      name: "Agent office",
      hostId: UNKNOWN_HOST_PLACEHOLDER,
      epicId: EPIC_ID,
      view: { x: 4, y: 5, zoom: 2 },
    });
    expect(parsed?.type).toBe("comm-graph");
    if (parsed === null || parsed.type !== "comm-graph") return;
    // The framing the user chose survives, and the missing mode is filled in
    // with what that tile ALWAYS rendered - reopening it on the floor would
    // silently change a surface the person already had set up.
    expect(parsed.view).toEqual({
      ...DEFAULT_COMM_GRAPH_VIEW,
      x: 4,
      y: 5,
      zoom: 2,
      mode: "graph",
    });
  });

  it("degrades an unrecognized mode to the graph rather than a blank tile", () => {
    const parsed = parseTileRef({
      id: commGraphTileId(EPIC_ID),
      instanceId: "inst-1",
      type: "comm-graph",
      name: "Agent office",
      hostId: UNKNOWN_HOST_PLACEHOLDER,
      epicId: EPIC_ID,
      view: { x: 0, y: 0, zoom: 1, mode: "isometric" },
    });
    expect(parsed?.type).toBe("comm-graph");
    if (parsed === null || parsed.type !== "comm-graph") return;
    // A mode from a future build lands on the rendering that has always
    // existed, not on the newest one.
    expect(parsed.view.mode).toBe("graph");
  });

  it("keeps an explicitly persisted office mode", () => {
    const parsed = parseTileRef({
      id: commGraphTileId(EPIC_ID),
      instanceId: "inst-1",
      type: "comm-graph",
      name: "Agent office",
      hostId: UNKNOWN_HOST_PLACEHOLDER,
      epicId: EPIC_ID,
      view: { x: 0, y: 0, zoom: 1, mode: "office" },
    });
    expect(parsed?.type).toBe("comm-graph");
    if (parsed === null || parsed.type !== "comm-graph") return;
    expect(parsed.view.mode).toBe("office");
  });

  it("keeps an explicitly persisted graph mode", () => {
    const parsed = parseTileRef({
      id: commGraphTileId(EPIC_ID),
      instanceId: "inst-1",
      type: "comm-graph",
      name: "Agent office",
      hostId: UNKNOWN_HOST_PLACEHOLDER,
      epicId: EPIC_ID,
      view: { x: 0, y: 0, zoom: 1, mode: "graph" },
    });
    expect(parsed?.type).toBe("comm-graph");
    if (parsed === null || parsed.type !== "comm-graph") return;
    expect(parsed.view.mode).toBe("graph");
  });

  it("renames a tile saved under the old copy on load, by kind not by name", () => {
    const parsed = parseTileRef({
      id: commGraphTileId(EPIC_ID),
      instanceId: "inst-1",
      type: "comm-graph",
      name: "Communication graph",
      hostId: UNKNOWN_HOST_PLACEHOLDER,
      epicId: EPIC_ID,
      view: { x: 0, y: 0, zoom: 1, mode: "office" },
    });
    expect(parsed?.type).toBe("comm-graph");
    if (parsed === null || parsed.type !== "comm-graph") return;
    // Matched on tile kind, not on the persisted name - a comm-graph tile
    // saved under any prior name always renders under the current one.
    expect(parsed.name).toBe("Agent office");
    // The saved office/graph view mode is untouched by the rename.
    expect(parsed.view.mode).toBe("office");
  });

  it("recomputes the id on rehydrate rather than trusting the persisted one", () => {
    const parsed = parseTileRef({
      id: "stale-random-uuid",
      instanceId: "inst-1",
      type: "comm-graph",
      name: "Agent office",
      hostId: UNKNOWN_HOST_PLACEHOLDER,
      epicId: EPIC_ID,
      view: { x: 0, y: 0, zoom: 1 },
    });
    expect(parsed?.id).toBe(commGraphTileId(EPIC_ID));
  });

  it("drops a persisted tile with no epic to scope it to", () => {
    expect(
      parseTileRef({
        instanceId: "inst-1",
        type: "comm-graph",
        name: "Agent office",
        hostId: UNKNOWN_HOST_PLACEHOLDER,
        view: { x: 0, y: 0, zoom: 1 },
      }),
    ).toBeNull();
  });

  it("degrades an unusable persisted viewport instead of failing the tile", () => {
    const parsed = parseTileRef({
      id: commGraphTileId(EPIC_ID),
      instanceId: "inst-1",
      type: "comm-graph",
      name: "Agent office",
      hostId: UNKNOWN_HOST_PLACEHOLDER,
      epicId: EPIC_ID,
      // A zero zoom would render an unrecoverable blank canvas.
      view: { x: "nope", y: null, zoom: 0 },
    });
    expect(parsed).not.toBeNull();
    if (parsed === null || parsed.type !== "comm-graph") return;
    expect(parsed.view).toEqual({
      ...DEFAULT_COMM_GRAPH_VIEW,
      mode: "graph",
    });
  });

  it("isDefaultCommGraphView ignores officeView and officeAutoView", () => {
    // A tile at the neutral camera with a real view choice still reads as
    // unframed - choosing a view is what resets the camera to this default in
    // the first place, so folding the choice into the comparison would make
    // every view pick immediately count as "the user framed this".
    expect(
      isDefaultCommGraphView({
        ...DEFAULT_COMM_GRAPH_VIEW,
        officeView: "building",
        officeAutoView: "towers",
      }),
    ).toBe(true);
  });

  it("isDefaultCommGraphView ignores officeCamera too - it is the graph's/canvas's own question", () => {
    // D68's own field is left out for the same reason as officeView/
    // officeAutoView above: this asks whether the GRAPH's camera (x/y/zoom)
    // is unframed, and folding officeCamera in would make an office pick
    // that never touched x/y/zoom read as "the graph was framed".
    expect(
      isDefaultCommGraphView({
        ...DEFAULT_COMM_GRAPH_VIEW,
        officeCamera: { x: 40, y: -12, zoom: 2.5 },
      }),
    ).toBe(true);
  });

  describe("officeCamera", () => {
    it("round-trips a real officeCamera through serialize / parse", () => {
      const ref = {
        ...makeCommGraphTileRef(EPIC_ID),
        view: {
          ...DEFAULT_COMM_GRAPH_VIEW,
          mode: "office" as const,
          officeCameraView: "building" as const,
          officeCamera: { x: 40, y: -12, zoom: 2.5 },
        },
      };
      expect(parseTileRef(serializeTileRef(ref))).toEqual(ref);
    });

    it("round-trips a null officeCamera - nobody has framed the office", () => {
      const ref = {
        ...makeCommGraphTileRef(EPIC_ID),
        view: { ...DEFAULT_COMM_GRAPH_VIEW, mode: "office" as const },
      };
      const parsed = parseTileRef(serializeTileRef(ref));
      expect(parsed?.type).toBe("comm-graph");
      if (parsed === null || parsed.type !== "comm-graph") return;
      expect(parsed.view.officeCamera).toBeNull();
      expect(parsed).toEqual(ref);
    });

    it("migrates a pre-D68 office-mode record's camera into officeCamera, keeping officeCameraView", () => {
      // Absent `officeCamera`, `office` mode, a non-neutral camera - those
      // numbers were the office's under the old one-camera model, and D68
      // hands them to the field that now owns them.
      const parsed = parseTileRef({
        id: commGraphTileId(EPIC_ID),
        instanceId: "inst-1",
        type: "comm-graph",
        name: "Agent office",
        hostId: UNKNOWN_HOST_PLACEHOLDER,
        epicId: EPIC_ID,
        view: {
          x: 40,
          y: -12,
          zoom: 2.5,
          mode: "office",
          officeCameraView: "building",
        },
      });
      expect(parsed?.type).toBe("comm-graph");
      if (parsed === null || parsed.type !== "comm-graph") return;
      expect(parsed.view.officeCamera).toEqual({ x: 40, y: -12, zoom: 2.5 });
      expect(parsed.view.officeCameraView).toBe("building");
      expect(parsed.view.x).toBe(DEFAULT_COMM_GRAPH_VIEW.x);
      expect(parsed.view.y).toBe(DEFAULT_COMM_GRAPH_VIEW.y);
      expect(parsed.view.zoom).toBe(DEFAULT_COMM_GRAPH_VIEW.zoom);
    });

    it("does not migrate the same record in graph mode - those numbers were always the graph's", () => {
      const parsed = parseTileRef({
        id: commGraphTileId(EPIC_ID),
        instanceId: "inst-1",
        type: "comm-graph",
        name: "Agent office",
        hostId: UNKNOWN_HOST_PLACEHOLDER,
        epicId: EPIC_ID,
        view: {
          x: 40,
          y: -12,
          zoom: 2.5,
          mode: "graph",
          officeCameraView: "building",
        },
      });
      expect(parsed?.type).toBe("comm-graph");
      if (parsed === null || parsed.type !== "comm-graph") return;
      expect(parsed.view.officeCamera).toBeNull();
      expect(parsed.view.x).toBe(40);
      expect(parsed.view.y).toBe(-12);
      expect(parsed.view.zoom).toBe(2.5);
    });

    it("does not migrate a record whose camera is already the neutral default", () => {
      // A neutral camera says nothing to carry - office mode or not.
      const parsed = parseTileRef({
        id: commGraphTileId(EPIC_ID),
        instanceId: "inst-1",
        type: "comm-graph",
        name: "Agent office",
        hostId: UNKNOWN_HOST_PLACEHOLDER,
        epicId: EPIC_ID,
        view: {
          x: DEFAULT_COMM_GRAPH_VIEW.x,
          y: DEFAULT_COMM_GRAPH_VIEW.y,
          zoom: DEFAULT_COMM_GRAPH_VIEW.zoom,
          mode: "office",
        },
      });
      expect(parsed?.type).toBe("comm-graph");
      if (parsed === null || parsed.type !== "comm-graph") return;
      expect(parsed.view.officeCamera).toBeNull();
    });

    it("does not re-migrate a persisted null officeCamera - null is a real answer, not an absence", () => {
      // A view pick can neutralise officeCamera to `null` explicitly; that
      // must not be resurrected on the next load just because the record
      // is in office mode with a non-neutral x/y/zoom (the graph's own,
      // left over from before the person switched modes).
      const parsed = parseTileRef({
        id: commGraphTileId(EPIC_ID),
        instanceId: "inst-1",
        type: "comm-graph",
        name: "Agent office",
        hostId: UNKNOWN_HOST_PLACEHOLDER,
        epicId: EPIC_ID,
        view: {
          x: 40,
          y: -12,
          zoom: 2.5,
          mode: "office",
          officeCameraView: "building",
          officeCamera: null,
        },
      });
      expect(parsed?.type).toBe("comm-graph");
      if (parsed === null || parsed.type !== "comm-graph") return;
      expect(parsed.view.officeCamera).toBeNull();
    });

    it("degrades to null for a stale officeCameraView, whichever field the record's numbers are in", () => {
      const parsed = parseTileRef({
        id: commGraphTileId(EPIC_ID),
        instanceId: "inst-1",
        type: "comm-graph",
        name: "Agent office",
        hostId: UNKNOWN_HOST_PLACEHOLDER,
        epicId: EPIC_ID,
        view: {
          x: 0,
          y: 0,
          zoom: 1,
          mode: "office",
          // A view id no build ships - the same degrade `officeCameraView`
          // already follows.
          officeCameraView: "atrium",
          officeCamera: { x: 40, y: -12, zoom: 2.5 },
        },
      });
      expect(parsed?.type).toBe("comm-graph");
      if (parsed === null || parsed.type !== "comm-graph") return;
      expect(parsed.view.officeCameraView).toBeNull();
      expect(parsed.view.officeCamera).toBeNull();
    });

    it("refuses a persisted officeCamera with a zoom of 0 - a half-usable camera is worse than none", () => {
      const parsed = parseTileRef({
        id: commGraphTileId(EPIC_ID),
        instanceId: "inst-1",
        type: "comm-graph",
        name: "Agent office",
        hostId: UNKNOWN_HOST_PLACEHOLDER,
        epicId: EPIC_ID,
        view: {
          x: 0,
          y: 0,
          zoom: 1,
          mode: "office",
          officeCameraView: "building",
          officeCamera: { x: 40, y: -12, zoom: 0 },
        },
      });
      expect(parsed?.type).toBe("comm-graph");
      if (parsed === null || parsed.type !== "comm-graph") return;
      expect(parsed.view.officeCamera).toBeNull();
    });
  });
});

describe("updateCommGraphTileView", () => {
  function stateWith(): EpicCanvasState {
    const ref = makeCommGraphTileRef(EPIC_ID);
    return {
      root: {
        kind: "pane",
        id: "pane-1",
        tabInstanceIds: [ref.instanceId],
        activeTabId: ref.instanceId,
        previewTabId: null,
        activationHistory: [ref.instanceId],
      },
      activePaneId: "pane-1",
      tilesByInstanceId: { [ref.instanceId]: ref },
      sizesByGroupId: {},
    };
  }

  it("stores the new viewport", () => {
    const state = stateWith();
    const next = updateCommGraphTileView(state, commGraphTileId(EPIC_ID), {
      ...DEFAULT_COMM_GRAPH_VIEW,
      x: 5,
      y: 6,
      zoom: 2,
      mode: "office",
    });
    const ref = Object.values(next.tilesByInstanceId)[0];
    expect(ref?.type).toBe("comm-graph");
    if (ref === undefined || ref.type !== "comm-graph") return;
    expect(ref.view).toEqual({
      ...DEFAULT_COMM_GRAPH_VIEW,
      x: 5,
      y: 6,
      zoom: 2,
      mode: "office",
    });
  });

  it("stores a mode change on its own", () => {
    const state = stateWith();
    const next = updateCommGraphTileView(state, commGraphTileId(EPIC_ID), {
      ...DEFAULT_COMM_GRAPH_VIEW,
      mode: "graph",
    });
    const ref = Object.values(next.tilesByInstanceId)[0];
    expect(ref?.type).toBe("comm-graph");
    if (ref === undefined || ref.type !== "comm-graph") return;
    // The viewport is unchanged here, so a comparison that ignored `mode`
    // would return the previous state and silently drop the toggle.
    expect(ref.view.mode).toBe("graph");
  });

  it("returns the same state for an unchanged view", () => {
    const state = stateWith();
    expect(
      updateCommGraphTileView(
        state,
        commGraphTileId(EPIC_ID),
        DEFAULT_COMM_GRAPH_VIEW,
      ),
    ).toBe(state);
  });

  it("stores a write that changes only officeView", () => {
    const state = stateWith();
    const next = updateCommGraphTileView(state, commGraphTileId(EPIC_ID), {
      ...DEFAULT_COMM_GRAPH_VIEW,
      officeView: "towers",
    });
    const ref = Object.values(next.tilesByInstanceId)[0];
    expect(ref?.type).toBe("comm-graph");
    if (ref === undefined || ref.type !== "comm-graph") return;
    // A compare over x/y/zoom/mode alone would see nothing different here and
    // silently swallow the pick.
    expect(ref.view.officeView).toBe("towers");
    expect(next).not.toBe(state);
  });

  it("stores a write that changes only officeAutoView", () => {
    const state = stateWith();
    const next = updateCommGraphTileView(state, commGraphTileId(EPIC_ID), {
      ...DEFAULT_COMM_GRAPH_VIEW,
      officeAutoView: "building",
    });
    const ref = Object.values(next.tilesByInstanceId)[0];
    expect(ref?.type).toBe("comm-graph");
    if (ref === undefined || ref.type !== "comm-graph") return;
    expect(ref.view.officeAutoView).toBe("building");
    expect(next).not.toBe(state);
  });

  it("stores a write that changes only officeCameraView", () => {
    // R2: this comparison used to cover six fields, dropping a write that
    // changed only the seventh - a whole-view write differing solely in the
    // camera's framing record would compare equal and vanish.
    const state = stateWith();
    const next = updateCommGraphTileView(state, commGraphTileId(EPIC_ID), {
      ...DEFAULT_COMM_GRAPH_VIEW,
      officeCameraView: "towers",
    });
    const ref = Object.values(next.tilesByInstanceId)[0];
    expect(ref?.type).toBe("comm-graph");
    if (ref === undefined || ref.type !== "comm-graph") return;
    expect(ref.view.officeCameraView).toBe("towers");
    expect(next).not.toBe(state);
  });
});

describe("updateCommGraphTileCamera", () => {
  function stateWithChoice(): EpicCanvasState {
    const ref = {
      ...makeCommGraphTileRef(EPIC_ID),
      view: {
        ...DEFAULT_COMM_GRAPH_VIEW,
        mode: "graph" as const,
        officeView: "towers" as const,
        officeAutoView: "building" as const,
        // Non-null on purpose: the case below proves this survives a plain
        // camera write, which a starting value of `null` cannot distinguish
        // from the field simply being absent.
        officeCameraView: "towers" as const,
      },
    };
    return {
      root: {
        kind: "pane",
        id: "pane-1",
        tabInstanceIds: [ref.instanceId],
        activeTabId: ref.instanceId,
        previewTabId: null,
        activationHistory: [ref.instanceId],
      },
      activePaneId: "pane-1",
      tilesByInstanceId: { [ref.instanceId]: ref },
      sizesByGroupId: {},
    };
  }

  it("moves the camera and leaves mode, officeView and officeAutoView untouched", () => {
    // Either renderer's debounced pan writes through this patch, so a pan
    // landing after a pick must not carry the old choice back over it.
    const state = stateWithChoice();
    const next = updateCommGraphTileCamera(state, commGraphTileId(EPIC_ID), {
      x: 40,
      y: -12,
      zoom: 2.5,
    });
    const ref = Object.values(next.tilesByInstanceId)[0];
    expect(ref?.type).toBe("comm-graph");
    if (ref === undefined || ref.type !== "comm-graph") return;
    expect(ref.view).toEqual({
      x: 40,
      y: -12,
      zoom: 2.5,
      // The GRAPH's camera path cannot touch the office's framing record -
      // preserved here, not merely absent, since the fixture starts it
      // non-null.
      officeCameraView: "towers",
      mode: "graph",
      officeView: "towers",
      officeAutoView: "building",
      // D68: nor the office's own camera, a field this action does not even
      // know about - null here since the fixture never framed the office.
      officeCamera: null,
    });
  });

  it("returns the same state object when the camera has not moved", () => {
    const state = stateWithChoice();
    const ref = Object.values(state.tilesByInstanceId)[0];
    if (ref === undefined || ref.type !== "comm-graph") {
      throw new Error("expected a comm-graph tile");
    }
    expect(
      updateCommGraphTileCamera(state, commGraphTileId(EPIC_ID), {
        x: ref.view.x,
        y: ref.view.y,
        zoom: ref.view.zoom,
      }),
    ).toBe(state);
  });

  it("leaves an existing officeCamera and its officeCameraView exactly as they were", () => {
    // The graph's camera path (per D68) cannot reach the office's fields at
    // all - proven here with a REAL office camera in place, not merely
    // `null`, so a write that accidentally touched it would show up.
    const state = stateWithChoice();
    const ref = Object.values(state.tilesByInstanceId)[0];
    if (ref === undefined || ref.type !== "comm-graph") {
      throw new Error("expected a comm-graph tile");
    }
    const seeded: EpicCanvasState = {
      ...state,
      tilesByInstanceId: {
        ...state.tilesByInstanceId,
        [ref.instanceId]: {
          ...ref,
          view: {
            ...ref.view,
            officeCamera: { x: 40, y: -12, zoom: 2.5 },
            officeCameraView: "building",
          },
        },
      },
    };
    const next = updateCommGraphTileCamera(seeded, commGraphTileId(EPIC_ID), {
      x: 155,
      y: 266,
      zoom: 2,
    });
    const nextRef = Object.values(next.tilesByInstanceId)[0];
    expect(nextRef?.type).toBe("comm-graph");
    if (nextRef === undefined || nextRef.type !== "comm-graph") return;
    expect(nextRef.view.officeCamera).toEqual({ x: 40, y: -12, zoom: 2.5 });
    expect(nextRef.view.officeCameraView).toBe("building");
  });
});

describe("updateCommGraphTileOfficeCamera", () => {
  function stateWithChoice(): EpicCanvasState {
    const ref = {
      ...makeCommGraphTileRef(EPIC_ID),
      view: {
        ...DEFAULT_COMM_GRAPH_VIEW,
        mode: "office" as const,
        officeView: "towers" as const,
        officeAutoView: "building" as const,
        officeCameraView: "towers" as const,
      },
    };
    return {
      root: {
        kind: "pane",
        id: "pane-1",
        tabInstanceIds: [ref.instanceId],
        activeTabId: ref.instanceId,
        previewTabId: null,
        activationHistory: [ref.instanceId],
      },
      activePaneId: "pane-1",
      tilesByInstanceId: { [ref.instanceId]: ref },
      sizesByGroupId: {},
    };
  }

  it("moves the camera and writes the framed view, leaving mode, officeView and officeAutoView untouched", () => {
    // D68: a REAL semantic change, not just a fixture edit. The office's
    // write no longer moves x/y/zoom at all - those are the graph's now -
    // it writes `officeCamera` instead, and x/y/zoom stay exactly as they
    // were (the fixture's defaults, since nothing set them).
    const state = stateWithChoice();
    const next = updateCommGraphTileOfficeCamera(
      state,
      commGraphTileId(EPIC_ID),
      { x: 40, y: -12, zoom: 2.5 },
      "building",
    );
    const ref = Object.values(next.tilesByInstanceId)[0];
    expect(ref?.type).toBe("comm-graph");
    if (ref === undefined || ref.type !== "comm-graph") return;
    expect(ref.view).toEqual({
      x: DEFAULT_COMM_GRAPH_VIEW.x,
      y: DEFAULT_COMM_GRAPH_VIEW.y,
      zoom: DEFAULT_COMM_GRAPH_VIEW.zoom,
      officeCamera: { x: 40, y: -12, zoom: 2.5 },
      officeCameraView: "building",
      mode: "office",
      officeView: "towers",
      officeAutoView: "building",
    });
  });

  it("returns the same state object when neither the camera nor the framed view has changed", () => {
    // D68: the no-op path compares `officeCamera` now, not x/y/zoom - the
    // shared fixture starts that field `null`, so a state actually AT the
    // camera being written has to seed it first, rather than reading back
    // whatever x/y/zoom already held (those say nothing about the office
    // any more).
    const state = stateWithChoice();
    const ref = Object.values(state.tilesByInstanceId)[0];
    if (ref === undefined || ref.type !== "comm-graph") {
      throw new Error("expected a comm-graph tile");
    }
    const seeded: EpicCanvasState = {
      ...state,
      tilesByInstanceId: {
        ...state.tilesByInstanceId,
        [ref.instanceId]: {
          ...ref,
          view: { ...ref.view, officeCamera: { x: 40, y: -12, zoom: 2.5 } },
        },
      },
    };
    expect(
      updateCommGraphTileOfficeCamera(
        seeded,
        commGraphTileId(EPIC_ID),
        { x: 40, y: -12, zoom: 2.5 },
        ref.view.officeCameraView,
      ),
    ).toBe(seeded);
  });

  it("writes a new state when only the framed view changed, even with an unmoved camera", () => {
    // `officeCameraView` was added to this action's own comparison - a camera
    // that stayed put but is now framing a DIFFERENT view (the re-pick that
    // lands on the same numbers) must still produce a new ref, not the
    // no-op path above.
    const state = stateWithChoice();
    const ref = Object.values(state.tilesByInstanceId)[0];
    if (ref === undefined || ref.type !== "comm-graph") {
      throw new Error("expected a comm-graph tile");
    }
    const next = updateCommGraphTileOfficeCamera(
      state,
      commGraphTileId(EPIC_ID),
      { x: ref.view.x, y: ref.view.y, zoom: ref.view.zoom },
      "building",
    );
    expect(next).not.toBe(state);
    const nextRef = Object.values(next.tilesByInstanceId)[0];
    expect(nextRef?.type).toBe("comm-graph");
    if (nextRef === undefined || nextRef.type !== "comm-graph") return;
    expect(nextRef.view.officeCameraView).toBe("building");
  });
});
