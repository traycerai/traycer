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

  it("clears a degraded officeView's dormant Auto outcome too, not just the choice (Finding 20)", () => {
    // Codex: an explicit office view this build cannot honour degrades to
    // null - "inherit the Settings default". The Auto outcome recorded under
    // that now-unknown pick is dormant, but if the inherited default is Auto
    // at the same generation the renderer trusts it and skips measurement,
    // reopening an arbitrarily old decision the degraded pick never stood
    // for. Both the outcome and its generation stamp must go with it.
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
        // A view id no build ships - degrades to null.
        officeView: "penthouse",
        officeAutoView: "towers",
        officeAutoGeneration: 7,
      },
    });
    expect(parsed?.type).toBe("comm-graph");
    if (parsed === null || parsed.type !== "comm-graph") return;
    expect(parsed.view.officeView).toBeNull();
    expect(parsed.view.officeAutoView).toBeNull();
    expect(parsed.view.officeAutoGeneration).toBeNull();
  });

  it("keeps a dormant Auto outcome when officeView is ABSENT - inherited from the start, not a degrade (Finding 20)", () => {
    // Non-vacuous contrast: an ABSENT officeView is "inherit from the
    // start", not a value this build failed to read, so it must not trigger
    // the same clear the unreadable-value case above does.
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
        officeAutoView: "towers",
        officeAutoGeneration: 7,
      },
    });
    expect(parsed?.type).toBe("comm-graph");
    if (parsed === null || parsed.type !== "comm-graph") return;
    expect(parsed.view.officeView).toBeNull();
    expect(parsed.view.officeAutoView).toBe("towers");
    expect(parsed.view.officeAutoGeneration).toBe(7);
  });

  it('keeps a dormant Auto outcome when officeView is "auto" - a read value, not a degrade (Finding 20)', () => {
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
        officeAutoView: "towers",
        officeAutoGeneration: 7,
      },
    });
    expect(parsed?.type).toBe("comm-graph");
    if (parsed === null || parsed.type !== "comm-graph") return;
    expect(parsed.view.officeView).toBe("auto");
    expect(parsed.view.officeAutoView).toBe("towers");
    expect(parsed.view.officeAutoGeneration).toBe(7);
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

  it("stamps a MIGRATED camera's framed view as Floor, so a Settings default that has since moved on can neutralise it", () => {
    // Codex: a pre-split record's shared x/y/zoom were always the OFFICE's
    // and only ever addressed the Floor (the only office that existed then).
    // Leaving `officeCameraView` null on migration read as "nobody framed
    // this" and let the numbers ride through unchallenged under whatever
    // view a newly-defaulted Settings choice (Towers, Building, ...)
    // resolves to now - Floor-space coordinates read as that view's own,
    // opening the tile off-screen. Stamping "floor" is what lets the
    // record-mismatch effect do its job the moment the current view
    // disagrees.
    const parsed = parseTileRef({
      id: commGraphTileId(EPIC_ID),
      instanceId: "inst-1",
      type: "comm-graph",
      name: "Agent office",
      hostId: UNKNOWN_HOST_PLACEHOLDER,
      epicId: EPIC_ID,
      // No `officeCamera`, no `officeCameraView` - a genuinely pre-split
      // record, the shape `migrates` alone gates on.
      view: { x: 12, y: -8, zoom: 1.5, mode: "office" },
    });
    expect(parsed?.type).toBe("comm-graph");
    if (parsed === null || parsed.type !== "comm-graph") return;
    expect(parsed.view.officeCamera).toEqual({ x: 12, y: -8, zoom: 1.5 });
    expect(parsed.view.officeCameraView).toBe("floor");
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

    it("migrates a pre-D68 office-mode record's camera into officeCamera, stamped Floor regardless of a stray officeCameraView", () => {
      // Absent `officeCamera`, `office` mode, a non-neutral camera - those
      // numbers were the office's under the old one-camera model, and D68
      // hands them to the field that now owns them.
      //
      // Codex (Finding 2): `officeCameraView: "building"` here is a shape no
      // real persisted record can carry - every writer sets `officeCamera`
      // and `officeCameraView` together in the same write (see the two
      // `updateCommGraphTileOfficeCamera*` call sites), and `officeCameraView`
      // did not exist before `officeCamera` did, so a genuinely pre-split
      // record has neither. `migrates` gates purely on `officeCamera` being
      // absent, and now unconditionally stamps a migrated camera "floor" -
      // the one view its coordinates could have addressed under the old
      // one-camera model - rather than trusting a stray stamp that could not
      // have been written by this application.
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
      expect(parsed.view.officeCameraView).toBe("floor");
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

    it("keeps a Graph-mode camera when the office record is stale - x/y/zoom are the Graph's since D68, not the office's to zero (fixup 12, Finding B)", () => {
      // The case above seeds GRAPH-NEUTRAL coordinates (`x: 0, y: 0, zoom:
      // 1`) alongside its stale id, so it cannot see this defect at all:
      // zeroing a camera that already reads as zero is invisible. This one
      // seeds the Graph's own NON-NEUTRAL framing instead - the reviewer's
      // own reproduction - so the zeroing actually shows up as a lost pan
      // rather than a no-op.
      //
      // `stale` here degrades from an unknown `officeView` ("atrium" ships
      // in no build), which is unrelated to the mode this record is in: a
      // GRAPH-mode tile has never had an office view of its own, so a
      // degraded `officeView` says nothing about whether this tile's
      // camera is trustworthy. Before D68 the shared x/y/zoom were the
      // OFFICE's, so wiping them on any staleness was correct; after D68
      // they are the Graph's alone, and a stale office field has no claim
      // on them.
      const parsed = parseTileRef({
        id: commGraphTileId(EPIC_ID),
        instanceId: "inst-1",
        type: "comm-graph",
        name: "Agent office",
        hostId: UNKNOWN_HOST_PLACEHOLDER,
        epicId: EPIC_ID,
        view: {
          x: 155,
          y: 266,
          zoom: 2,
          mode: "graph",
          officeView: "atrium",
          officeCamera: null,
        },
      });
      expect(parsed?.type).toBe("comm-graph");
      if (parsed === null || parsed.type !== "comm-graph") return;
      // THE CLAIM: the Graph's own framing survives an unrelated stale
      // OFFICE record untouched. Red at `2240afa89` by exactly the
      // zeroing the `stale` branch still applies unconditionally.
      expect(parsed.view.x).toBe(155);
      expect(parsed.view.y).toBe(266);
      expect(parsed.view.zoom).toBe(2);
      // The office's own fields still retire exactly as the stale branch
      // always meant them to - this half of the claim is unchanged by the
      // fix and stays green throughout.
      expect(parsed.view.officeView).toBeNull();
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

    it("keeps a framed camera when a DORMANT Auto outcome is stale, and the tile is not on Auto", () => {
      // `officeAutoView` lingers as a record even after the owner picks a
      // concrete view - "towers" here - so its own unreadability ("skyline",
      // an id no build ships) must not wipe the camera framed for the view
      // the tile actually shows. Only the fields that DO describe this
      // record's camera - `officeView` and `officeCameraView`, both
      // readable "towers" - govern whether it survives.
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
          officeView: "towers",
          officeAutoView: "skyline",
          officeCameraView: "towers",
          officeCamera: { x: 40, y: -12, zoom: 2.5 },
        },
      });
      expect(parsed?.type).toBe("comm-graph");
      if (parsed === null || parsed.type !== "comm-graph") return;
      expect(parsed.view.officeCamera).toEqual({ x: 40, y: -12, zoom: 2.5 });
      expect(parsed.view.officeCameraView).toBe("towers");
    });

    it("still retires the camera when the ACTIVE Auto outcome is stale", () => {
      // Control (a): the tile IS on Auto (`officeView: "auto"`) this time, so
      // the dormant-outcome exception does not apply - `officeAutoView` is
      // the camera's only source of a framed view, and its unreadability
      // still degrades it.
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
          officeAutoView: "skyline",
          officeCamera: { x: 40, y: -12, zoom: 2.5 },
        },
      });
      expect(parsed?.type).toBe("comm-graph");
      if (parsed === null || parsed.type !== "comm-graph") return;
      expect(parsed.view.officeCamera).toBeNull();
    });

    it("still retires the camera when its OWN framed-view id is stale, even beside a healthy dormant outcome", () => {
      // Control (b): `officeCameraView` - the id the camera itself names -
      // is the one that is unreadable here, not `officeAutoView`. That term
      // is unconditional, so the dormant-outcome gate on the OTHER term
      // changes nothing about it.
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
          officeView: "towers",
          officeCameraView: "skyline",
          officeCamera: { x: 40, y: -12, zoom: 2.5 },
        },
      });
      expect(parsed?.type).toBe("comm-graph");
      if (parsed === null || parsed.type !== "comm-graph") return;
      expect(parsed.view.officeCamera).toBeNull();
    });

    it("keeps a framed camera when officeView is null (inheriting a concrete default), even with a stale dormant outcome", () => {
      // `officeView: null` means "inherit the Settings default", which the
      // renderer resolves to `agentOfficeDefaultView` and may be a concrete
      // view like Towers - the parser cannot know which, so it must not
      // treat `null` as Auto and let the dormant, unreadable `officeAutoView`
      // wipe a camera that frames the resolved concrete view.
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
          officeView: null,
          officeAutoView: "skyline",
          officeCameraView: "towers",
          officeCamera: { x: 40, y: -12, zoom: 2.5 },
        },
      });
      expect(parsed?.type).toBe("comm-graph");
      if (parsed === null || parsed.type !== "comm-graph") return;
      expect(parsed.view.officeCamera).toEqual({ x: 40, y: -12, zoom: 2.5 });
      expect(parsed.view.officeCameraView).toBe("towers");
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

  function stateWithGeneration(officeAutoGeneration: number): EpicCanvasState {
    const ref = {
      ...makeCommGraphTileRef(EPIC_ID),
      view: { ...DEFAULT_COMM_GRAPH_VIEW, officeAutoGeneration },
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

  it("stores a write that changes only officeAutoGeneration (a stamp-only refresh)", () => {
    // Finding 5: a re-measurement that lands on the same view and camera but
    // under a newer default generation is a STAMP-ONLY write - every other
    // field is unchanged, so an eight-field comparison sees nothing different
    // and drops it, leaving the stored generation stale and the tile
    // re-measuring on every remount instead of settling on the refresh.
    const seeded = stateWithGeneration(3);
    const next = updateCommGraphTileView(seeded, commGraphTileId(EPIC_ID), {
      ...DEFAULT_COMM_GRAPH_VIEW,
      officeAutoGeneration: 5,
    });
    const ref = Object.values(next.tilesByInstanceId)[0];
    expect(ref?.type).toBe("comm-graph");
    if (ref === undefined || ref.type !== "comm-graph") return;
    expect(ref.view.officeAutoGeneration).toBe(5);
    expect(next).not.toBe(seeded);
  });

  it("still dedupes an unchanged view when officeAutoGeneration also matches", () => {
    // Mirror of the case above: a truly identical view - generation included -
    // is still recognised as a no-op and returns the same state.
    const seeded = stateWithGeneration(3);
    expect(
      updateCommGraphTileView(seeded, commGraphTileId(EPIC_ID), {
        ...DEFAULT_COMM_GRAPH_VIEW,
        officeAutoGeneration: 3,
      }),
    ).toBe(seeded);
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
      // The generation field, another one this action does not know about -
      // null since the fixture never measured Auto.
      officeAutoGeneration: null,
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
      officeAutoGeneration: null,
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

  it("collapses a neutral camera to officeCamera: null, the armed auto-fit sentinel", () => {
    // The canvas re-arms auto-fit by persisting the NEUTRAL camera (its
    // `onCameraChange` patch has no vocabulary for `null`) - this reducer is
    // where that neutral patch becomes the one canonical armed value every
    // other office read already checks for.
    const state = stateWithChoice();
    const next = updateCommGraphTileOfficeCamera(
      state,
      commGraphTileId(EPIC_ID),
      { x: 0, y: 0, zoom: 1 },
      "floor",
    );
    const ref = Object.values(next.tilesByInstanceId)[0];
    expect(ref?.type).toBe("comm-graph");
    if (ref === undefined || ref.type !== "comm-graph") return;
    expect(ref.view.officeCamera).toBeNull();
    expect(ref.view.officeCameraView).toBe("floor");
  });

  it("still stores a non-neutral camera as-is", () => {
    const state = stateWithChoice();
    const next = updateCommGraphTileOfficeCamera(
      state,
      commGraphTileId(EPIC_ID),
      { x: 5, y: 6, zoom: 2 },
      "floor",
    );
    const ref = Object.values(next.tilesByInstanceId)[0];
    expect(ref?.type).toBe("comm-graph");
    if (ref === undefined || ref.type !== "comm-graph") return;
    expect(ref.view.officeCamera).toEqual({ x: 5, y: 6, zoom: 2 });
    expect(ref.view.officeCameraView).toBe("floor");
  });

  it("is a no-op when a tile already armed (officeCamera: null) is written with the neutral camera again", () => {
    // Proves the normalize happens BEFORE the sameOfficeCamera dedup compare:
    // a naive compare of the raw {0,0,1} patch against a stored `null` would
    // never match and would produce a needless new ref every persist tick
    // while auto-fit stays on.
    const state = stateWithChoice();
    const ref = Object.values(state.tilesByInstanceId)[0];
    if (ref === undefined || ref.type !== "comm-graph") {
      throw new Error("expected a comm-graph tile");
    }
    const armed: EpicCanvasState = {
      ...state,
      tilesByInstanceId: {
        ...state.tilesByInstanceId,
        [ref.instanceId]: {
          ...ref,
          view: { ...ref.view, officeCamera: null, officeCameraView: "floor" },
        },
      },
    };
    expect(
      updateCommGraphTileOfficeCamera(
        armed,
        commGraphTileId(EPIC_ID),
        { x: 0, y: 0, zoom: 1 },
        "floor",
      ),
    ).toBe(armed);
  });
});
