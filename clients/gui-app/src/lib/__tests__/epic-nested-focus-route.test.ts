import { describe, expect, it } from "vitest";
import {
  areNestedFocusTargetsEqual,
  buildNestedFocusSearchPatch,
  getCurrentNestedFocusTarget,
  isNestedFocusTargetValid,
  parseNestedFocusTargetFromHref,
  parseNestedFocusTargetFromSearch,
  resolveNestedFocusTarget,
} from "@/lib/epic-nested-focus-route";
import type { EpicNodeRef } from "@/stores/epics/canvas/types";
import type {
  TileGroup,
  TileLayoutNode,
  TilePane,
} from "@/stores/epics/canvas/tile-tree";

const HOST_ID = "host-1";

function tile(instanceId: string): EpicNodeRef {
  return {
    id: `artifact-${instanceId}`,
    instanceId,
    type: "spec",
    name: instanceId,
    hostId: HOST_ID,
  };
}

function pane(
  id: string,
  tabInstanceIds: ReadonlyArray<string>,
  activeTabId: string | null,
): TilePane {
  return {
    kind: "pane",
    id,
    tabInstanceIds,
    activeTabId,
    previewTabId: null,
    activationHistory: activeTabId === null ? [] : [activeTabId],
  };
}

function group(id: string, children: ReadonlyArray<TileLayoutNode>): TileGroup {
  return {
    kind: "group",
    id,
    direction: "horizontal",
    children,
  };
}

function canvas(root: TileLayoutNode | null, activePaneId: string | null) {
  const tileRefs = collectTileIds(root).map(tile);
  return {
    root,
    activePaneId,
    tilesByInstanceId: Object.fromEntries(
      tileRefs.map((ref) => [ref.instanceId, ref]),
    ),
    sizesByGroupId: {},
  };
}

function collectTileIds(node: TileLayoutNode | null): ReadonlyArray<string> {
  if (node === null) return [];
  if (node.kind === "pane") return node.tabInstanceIds;
  return node.children.flatMap(collectTileIds);
}

describe("nested epic focus route helpers", () => {
  it("parses absent and blank nested search params as no target", () => {
    expect(parseNestedFocusTargetFromSearch({})).toBeNull();
    expect(
      parseNestedFocusTargetFromSearch({
        focusPaneId: " ",
        focusTileInstanceId: "tile-1",
      }),
    ).toBeNull();
  });

  it("parses pane-only and blank-tile targets", () => {
    expect(
      parseNestedFocusTargetFromSearch({
        focusPaneId: " pane-1 ",
      }),
    ).toEqual({
      paneId: "pane-1",
      tileInstanceId: undefined,
    });
    expect(
      parseNestedFocusTargetFromSearch({
        focusPaneId: "pane-1",
        focusTileInstanceId: "\t",
      }),
    ).toEqual({
      paneId: "pane-1",
      tileInstanceId: undefined,
    });
  });

  it("reads the explicit active pane and active tab from canvas state", () => {
    const state = canvas(
      group("root", [
        pane("pane-1", ["tile-1"], "tile-1"),
        pane("pane-2", ["tile-2"], "tile-2"),
      ]),
      "pane-2",
    );

    expect(getCurrentNestedFocusTarget(state)).toEqual({
      paneId: "pane-2",
      tileInstanceId: "tile-2",
    });
  });

  it("falls back to the first pane tab when activeTabId is null", () => {
    const state = canvas(pane("pane-1", ["tile-1", "tile-2"], null), "pane-1");

    expect(getCurrentNestedFocusTarget(state)).toEqual({
      paneId: "pane-1",
      tileInstanceId: "tile-1",
    });
  });

  it("returns pane-only current focus for an empty active pane", () => {
    const state = canvas(pane("pane-1", [], null), "pane-1");

    expect(getCurrentNestedFocusTarget(state)).toEqual({
      paneId: "pane-1",
      tileInstanceId: undefined,
    });
  });

  it("validates pane-only targets and rejects stale pane or tile targets", () => {
    const state = canvas(pane("pane-1", ["tile-1"], "tile-1"), "pane-1");

    expect(
      isNestedFocusTargetValid(state, {
        paneId: "pane-1",
        tileInstanceId: undefined,
      }),
    ).toBe(true);
    expect(
      resolveNestedFocusTarget(state, {
        paneId: "stale-pane",
        tileInstanceId: undefined,
      }),
    ).toBeNull();
    expect(
      resolveNestedFocusTarget(state, {
        paneId: "pane-1",
        tileInstanceId: "stale-tile",
      }),
    ).toBeNull();
  });

  it("compares route targets by pane and tile identity", () => {
    expect(
      areNestedFocusTargetsEqual(
        { paneId: "pane-1", tileInstanceId: "tile-1" },
        { paneId: "pane-1", tileInstanceId: "tile-1" },
      ),
    ).toBe(true);
    expect(
      areNestedFocusTargetsEqual(
        { paneId: "pane-1", tileInstanceId: "tile-1" },
        { paneId: "pane-1", tileInstanceId: undefined },
      ),
    ).toBe(false);
  });

  it("builds search patches that set or clear nested focus params", () => {
    expect(
      buildNestedFocusSearchPatch({
        paneId: "pane-1",
        tileInstanceId: "tile-1",
      }),
    ).toEqual({
      focusPaneId: "pane-1",
      focusTileInstanceId: "tile-1",
    });
    expect(buildNestedFocusSearchPatch(null)).toEqual({
      focusPaneId: undefined,
      focusTileInstanceId: undefined,
    });
  });

  it("parses nested params from persisted history hrefs", () => {
    expect(
      parseNestedFocusTargetFromHref(
        "/epics/epic-1/tab-1?focusPaneId=pane-1&focusTileInstanceId=tile-1#tail",
      ),
    ).toEqual({
      paneId: "pane-1",
      tileInstanceId: "tile-1",
    });
    expect(parseNestedFocusTargetFromHref("/epics/epic-1/tab-1")).toBeNull();
  });
});
