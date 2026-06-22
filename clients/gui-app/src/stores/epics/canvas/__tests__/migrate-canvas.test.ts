/**
 * Safety net for the canvas (de)serializer.
 *
 * `parseEpicCanvasState` is the single parse entry point for BOTH persist
 * paths (zustand localStorage merge and the desktop per-window projection),
 * over the current N-ary shape: `{kind:"pane", tabInstanceIds}` leaves under
 * `{kind:"group", direction, children}` containers, with `activePaneId` /
 * `tilesByInstanceId` / `sizesByGroupId` at the state level.
 *
 * These tests assert parsing is total (returns `null` only for non-object
 * input), the result always satisfies the tiles/tree/sizes invariants, and the
 * current-shape round-trip (`parse(serialize(state))`) deep-equals the input.
 */
import { describe, expect, it } from "vitest";
import {
  parseCanvasByTabId,
  parseEpicCanvasState,
  serializeEpicCanvasState,
  serializeTileNode,
} from "@/stores/epics/canvas/migrate-canvas";
import { serializeTileRef } from "@/stores/epics/canvas/tile-schema";
import type {
  EpicCanvasState,
  EpicCanvasTileRef,
} from "@/stores/epics/canvas/types";
import type { DesktopJsonValue } from "@/lib/windows/types";
import type { TileGroup, TilePane } from "@/stores/epics/canvas/tile-tree";
import {
  CHAT_A,
  GIT_FILE_B,
  SPEC_B,
  TICKET_C,
  expectCanvasInvariants,
  reachableInstanceIds,
} from "./canvas-test-fixtures";

// Serialized tile ref in the exact shape the tile-schema writes.
function ser(ref: EpicCanvasTileRef): DesktopJsonValue {
  return serializeTileRef(ref);
}

function requireParse(value: unknown): EpicCanvasState {
  const parsed = parseEpicCanvasState(value);
  if (parsed === null) throw new Error("expected a parsed canvas");
  return parsed;
}

describe("parseEpicCanvasState", () => {
  it("returns null only for non-object input", () => {
    expect(parseEpicCanvasState(null)).toBeNull();
    expect(parseEpicCanvasState(42)).toBeNull();
    expect(parseEpicCanvasState("nope")).toBeNull();
    expect(parseEpicCanvasState([1, 2])).toBeNull();
  });

  it("returns an empty canvas when the root resolves to nothing", () => {
    const state = requireParse({
      root: {
        kind: "pane",
        id: "pane-dead",
        // References an instanceId with no tile payload -> resolves to none.
        tabInstanceIds: ["missing-instance"],
        activeTabId: null,
        previewTabId: null,
      },
      activePaneId: "pane-dead",
      tilesByInstanceId: {},
      sizesByGroupId: {},
    });
    expect(state.root).toBeNull();
    expect(state.activePaneId).toBeNull();
    expect(state.tilesByInstanceId).toEqual({});
    expect(state.sizesByGroupId).toEqual({});
  });

  it("drops only an unparsable tab inside a pane, keeping its siblings", () => {
    const state = requireParse({
      root: {
        kind: "pane",
        // The pane references the malformed tab between two valid siblings, so the
        // parser must drop the unparsable entry and keep the rest.
        id: "pane-1",
        tabInstanceIds: [
          CHAT_A.instanceId,
          "broken-instance",
          SPEC_B.instanceId,
        ],
        activeTabId: CHAT_A.instanceId,
        previewTabId: null,
      },
      activePaneId: "pane-1",
      tilesByInstanceId: {
        [CHAT_A.instanceId]: ser(CHAT_A),
        // A malformed tile payload (invalid type) is dropped; its siblings survive.
        "broken-instance": {
          id: "broken",
          instanceId: "broken-instance",
          type: "???",
        },
        [SPEC_B.instanceId]: ser(SPEC_B),
      },
      sizesByGroupId: {},
    });
    expect(reachableInstanceIds(state)).toEqual([
      CHAT_A.instanceId,
      SPEC_B.instanceId,
    ]);
    expect(state.tilesByInstanceId[CHAT_A.instanceId]).toEqual(CHAT_A);
    expect(state.tilesByInstanceId[SPEC_B.instanceId]).toEqual(SPEC_B);
    expectCanvasInvariants(state);
  });
});

describe("parseEpicCanvasState current N-ary round-trip", () => {
  it("round-trips a representative state (2 groups / 3 panes / preview / sizes)", () => {
    const paneA: TilePane = {
      kind: "pane",
      id: "pane-a",
      tabInstanceIds: [CHAT_A.instanceId, SPEC_B.instanceId],
      activeTabId: CHAT_A.instanceId,
      previewTabId: SPEC_B.instanceId,
    };
    const paneB: TilePane = {
      kind: "pane",
      id: "pane-b",
      tabInstanceIds: [TICKET_C.instanceId],
      activeTabId: TICKET_C.instanceId,
      previewTabId: null,
    };
    const paneC: TilePane = {
      kind: "pane",
      id: "pane-c",
      tabInstanceIds: [GIT_FILE_B.instanceId],
      activeTabId: GIT_FILE_B.instanceId,
      previewTabId: null,
    };
    const innerGroup: TileGroup = {
      kind: "group",
      id: "group-inner",
      direction: "vertical",
      children: [paneB, paneC],
    };
    const rootGroup: TileGroup = {
      kind: "group",
      id: "group-root",
      direction: "horizontal",
      children: [paneA, innerGroup],
    };
    const state: EpicCanvasState = {
      root: rootGroup,
      activePaneId: "pane-b",
      tilesByInstanceId: {
        [CHAT_A.instanceId]: CHAT_A,
        [SPEC_B.instanceId]: SPEC_B,
        [TICKET_C.instanceId]: TICKET_C,
        [GIT_FILE_B.instanceId]: GIT_FILE_B,
      },
      sizesByGroupId: {
        "group-root": [0.6, 0.4],
        "group-inner": [0.7, 0.3],
      },
    };

    const roundTripped = requireParse(serializeEpicCanvasState(state));
    expect(roundTripped).toEqual(state);
    expectCanvasInvariants(roundTripped);
  });

  it("reconciles a current-shape state with a stale activePaneId to the first pane", () => {
    const pane: TilePane = {
      kind: "pane",
      id: "pane-only",
      tabInstanceIds: [CHAT_A.instanceId],
      activeTabId: CHAT_A.instanceId,
      previewTabId: null,
    };
    const serialized = {
      root: serializeTileNode(pane),
      activePaneId: "does-not-exist",
      tilesByInstanceId: { [CHAT_A.instanceId]: ser(CHAT_A) },
      sizesByGroupId: {},
    };
    const state = requireParse(serialized);
    expect(state.activePaneId).toBe("pane-only");
    expectCanvasInvariants(state);
  });
});

describe("parseCanvasByTabId", () => {
  it("keeps valid entries and drops invalid ones", () => {
    const pane: TilePane = {
      kind: "pane",
      id: "pane-1",
      tabInstanceIds: [CHAT_A.instanceId],
      activeTabId: CHAT_A.instanceId,
      previewTabId: null,
    };
    const valid = serializeEpicCanvasState({
      root: pane,
      activePaneId: "pane-1",
      tilesByInstanceId: { [CHAT_A.instanceId]: CHAT_A },
      sizesByGroupId: {},
    });

    const parsed = parseCanvasByTabId({
      "tab-valid": valid,
      // Non-object canvas -> parseEpicCanvasState returns null, entry dropped.
      "tab-invalid": 123,
    });

    expect(Object.keys(parsed)).toEqual(["tab-valid"]);
    const canvas = parsed["tab-valid"];
    expect(reachableInstanceIds(canvas)).toEqual([CHAT_A.instanceId]);
    expectCanvasInvariants(canvas);
  });
});
