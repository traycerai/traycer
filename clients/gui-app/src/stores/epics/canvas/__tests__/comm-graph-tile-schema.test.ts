import { describe, expect, it } from "vitest";
import {
  isTileRefRecordBacked,
  parseTileRef,
  serializeTileRef,
} from "@/stores/epics/canvas/tile-schema";
import {
  commGraphTileId,
  makeCommGraphTileRef,
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
      view: { x: 12, y: -30, zoom: 1.5 },
    };
    expect(parseTileRef(serializeTileRef(ref))).toEqual(ref);
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
    expect(parsed.view).toEqual({ x: 0, y: 0, zoom: 1 });
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
    });
    const ref = Object.values(next.tilesByInstanceId)[0];
    expect(ref?.type).toBe("comm-graph");
    if (ref === undefined || ref.type !== "comm-graph") return;
    expect(ref.view).toEqual({ x: 5, y: 6, zoom: 2 });
  });

  it("returns the same state for an unchanged viewport", () => {
    const state = stateWith();
    expect(
      updateCommGraphTileView(state, commGraphTileId(EPIC_ID), {
        x: 0,
        y: 0,
        zoom: 1,
      }),
    ).toBe(state);
  });
});
