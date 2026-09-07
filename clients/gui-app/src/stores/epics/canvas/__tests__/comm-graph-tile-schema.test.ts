import { describe, expect, it } from "vitest";
import {
  isTileRefRecordBacked,
  parseTileRef,
  serializeTileRef,
} from "@/stores/epics/canvas/tile-schema";
import {
  commGraphTileId,
  makeCommGraphTileRef,
  DEFAULT_COMM_GRAPH_VIEW,
} from "@/stores/epics/canvas/tile-schema/comm-graph-tile";
import { updateCommGraphTileView } from "@/stores/epics/canvas/actions";
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
      view: { x: 12, y: -30, zoom: 1.5, mode: "graph" as const },
    };
    expect(parseTileRef(serializeTileRef(ref))).toEqual(ref);
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
      name: "Communication graph",
      hostId: UNKNOWN_HOST_PLACEHOLDER,
      epicId: EPIC_ID,
      view: { x: 4, y: 5, zoom: 2 },
    });
    expect(parsed?.type).toBe("comm-graph");
    if (parsed === null || parsed.type !== "comm-graph") return;
    // The framing the user chose survives, and the missing mode is filled in
    // with what that tile ALWAYS rendered - reopening it on the floor would
    // silently change a surface the person already had set up.
    expect(parsed.view).toEqual({ x: 4, y: 5, zoom: 2, mode: "graph" });
  });

  it("degrades an unrecognized mode to the graph rather than a blank tile", () => {
    const parsed = parseTileRef({
      id: commGraphTileId(EPIC_ID),
      instanceId: "inst-1",
      type: "comm-graph",
      name: "Communication graph",
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
      name: "Communication graph",
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
      name: "Communication graph",
      hostId: UNKNOWN_HOST_PLACEHOLDER,
      epicId: EPIC_ID,
      view: { x: 0, y: 0, zoom: 1, mode: "graph" },
    });
    expect(parsed?.type).toBe("comm-graph");
    if (parsed === null || parsed.type !== "comm-graph") return;
    expect(parsed.view.mode).toBe("graph");
  });

  it("recomputes the id on rehydrate rather than trusting the persisted one", () => {
    const parsed = parseTileRef({
      id: "stale-random-uuid",
      instanceId: "inst-1",
      type: "comm-graph",
      name: "Communication graph",
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
        name: "Communication graph",
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
      name: "Communication graph",
      hostId: UNKNOWN_HOST_PLACEHOLDER,
      epicId: EPIC_ID,
      // A zero zoom would render an unrecoverable blank canvas.
      view: { x: "nope", y: null, zoom: 0 },
    });
    expect(parsed).not.toBeNull();
    if (parsed === null || parsed.type !== "comm-graph") return;
    expect(parsed.view).toEqual({ x: 0, y: 0, zoom: 1, mode: "graph" });
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
      x: 5,
      y: 6,
      zoom: 2,
      mode: "office",
    });
    const ref = Object.values(next.tilesByInstanceId)[0];
    expect(ref?.type).toBe("comm-graph");
    if (ref === undefined || ref.type !== "comm-graph") return;
    expect(ref.view).toEqual({ x: 5, y: 6, zoom: 2, mode: "office" });
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
});
