import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cancelLayoutDrag,
  layoutDragActive,
} from "@/components/layout-editor/canvas/drag-engine";
import {
  armCanvasDrag,
  LAYOUT_CLUSTER_ATTRIBUTE,
  LAYOUT_MEMBER_ATTRIBUTE,
} from "@/components/layout-editor/canvas/region-drag";
import { DEFAULT_DOCK_ORDER } from "@/lib/layout/layout-arrangement";
import {
  DEFAULT_RAIL,
  leftPanelIdForRailRegion,
  railDividerId,
  type RailEntry,
} from "@/lib/layout/rail";
import type { RegionId, ToolbarRegionId } from "@/lib/layout/region-id";
import { useLayoutEditorStore } from "@/stores/layout/layout-editor-store";
import {
  DEFAULT_LAYOUT_SNAPSHOT,
  useLayoutStore,
} from "@/stores/layout/layout-store";

/**
 * The canvas half of a reorder, end to end: an element picked up, and the
 * arrangement it leaves behind.
 *
 * The toolbar is built here rather than rendered, for the same reason the
 * engine's own test stubs rects - jsdom lays nothing out - but everything
 * between the pointer and the store is the real thing: the registry decides
 * which group the element is in, the engine decides which slot it landed in,
 * and `layout-gestures.ts` writes it as one recorded gesture.
 */

const CHIP_WIDTH = 30;
const CHIP_GAP = 4;

/** The composer's own shape: each member inside a `display: contents` span. */
function mountToolbar(
  regionIds: ReadonlyArray<RegionId>,
): ReadonlyArray<HTMLElement> {
  const cluster = document.createElement("div");
  cluster.setAttribute(LAYOUT_CLUSTER_ATTRIBUTE, "");
  document.body.append(cluster);
  const clusterWidth = regionIds.length * (CHIP_WIDTH + CHIP_GAP) - CHIP_GAP;
  cluster.getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    right: clusterWidth,
    bottom: 24,
    width: clusterWidth,
    height: 24,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  return regionIds.map((regionId, index) => {
    const wrapper = document.createElement("span");
    cluster.append(wrapper);
    const node = document.createElement("div");
    node.setAttribute("data-layout-region", regionId);
    node.setAttribute("data-layout-group", "toolbarLeft");
    node.setAttribute("data-layout-draggable", "1");
    const left = index * (CHIP_WIDTH + CHIP_GAP);
    node.getBoundingClientRect = () => ({
      left,
      top: 0,
      right: left + CHIP_WIDTH,
      bottom: 24,
      width: CHIP_WIDTH,
      height: 24,
      x: left,
      y: 0,
      toJSON: () => ({}),
    });
    node.setPointerCapture = () => undefined;
    node.releasePointerCapture = () => undefined;
    node.hasPointerCapture = () => true;
    wrapper.append(node);
    return node;
  });
}

/**
 * A left cluster with a member on each side of the one being dragged.
 *
 * The shipped default is two members (`attachImage`, `access`) since the Agent
 * label left the composer (L-136), and `mic` is a toolbar region a user can
 * move across - which is the arrangement these cases describe.
 */
function setToolbarLeft(ids: ReadonlyArray<ToolbarRegionId>): void {
  const arrangement = useLayoutStore.getState().arrangement;
  useLayoutStore.setState({
    arrangement: {
      ...arrangement,
      toolbarLeft: ids,
      toolbarRight: arrangement.toolbarRight.filter((id) => !ids.includes(id)),
    },
  });
}

const ROW_HEIGHT = 40;
// Far enough below the dock that the two containers are unmistakably apart on
// the vertical axis, which is the axis the engine infers from the first two
// boxes - and near enough that a drag can still reach a chip, so a build that
// took the split cluster really would write something.
const CHIP_STRIP_TOP = 160;

/**
 * The dock's own shape, with the chip-sized rows drawn WHERE THE APP DRAWS
 * THEM - in the composer's compact strip, a container of its own with the
 * whole transcript between it and the dock (G3-01).
 */
function mountDock(
  rows: ReadonlyArray<{
    readonly regionId: RegionId;
    readonly chip: boolean;
  }>,
): ReadonlyArray<HTMLElement> {
  const tile = document.createElement("div");
  document.body.append(tile);
  const dock = box(tile, 0, rows.length * ROW_HEIGHT);
  const strip = box(tile, CHIP_STRIP_TOP, 24);
  let dockTop = 0;
  let chipLeft = 0;
  const nodes: HTMLElement[] = [];
  for (const row of rows) {
    const node = document.createElement("div");
    node.setAttribute("data-layout-region", row.regionId);
    node.setAttribute("data-layout-group", "dock");
    node.setAttribute("data-layout-draggable", "1");
    node.setPointerCapture = () => undefined;
    node.releasePointerCapture = () => undefined;
    node.hasPointerCapture = () => true;
    if (row.chip) {
      strip.append(node);
      stubRect(node, {
        left: chipLeft,
        top: CHIP_STRIP_TOP,
        width: 30,
        height: 24,
      });
      chipLeft += 34;
    } else {
      dock.append(node);
      stubRect(node, { left: 0, top: dockTop, width: 300, height: ROW_HEIGHT });
      dockTop += ROW_HEIGHT;
    }
    nodes.push(node);
  }
  return nodes;
}

const RAIL_TILE = 36;
const RAIL_DIVIDER = 8;
const RAIL_GAP = 4;

/**
 * The sidebar's icon column: one element per rail ENTRY, panels and dividers
 * alike, in one cluster (L-115). A divider carries its entry id as a member id
 * rather than a region id, which is the whole of what makes it draggable
 * without being a region.
 */
function mountRail(
  entries: ReadonlyArray<RailEntry>,
): ReadonlyArray<HTMLElement> {
  const column = document.createElement("div");
  column.setAttribute(LAYOUT_CLUSTER_ATTRIBUTE, "");
  document.body.append(column);
  let top = 0;
  const nodes = entries.map((entry) => {
    const node = document.createElement("div");
    if (entry.kind === "panel")
      node.setAttribute("data-layout-region", entry.id);
    else node.setAttribute(LAYOUT_MEMBER_ATTRIBUTE, entry.id);
    node.setAttribute("data-layout-group", "rail");
    node.setAttribute("data-layout-draggable", "1");
    node.setPointerCapture = () => undefined;
    node.releasePointerCapture = () => undefined;
    node.hasPointerCapture = () => true;
    const height = entry.kind === "panel" ? RAIL_TILE : RAIL_DIVIDER;
    stubRect(node, { left: 0, top, width: RAIL_TILE, height });
    top += height + RAIL_GAP;
    column.append(node);
    return node;
  });
  stubRect(column, {
    left: 0,
    top: 0,
    width: RAIL_TILE,
    height: top - RAIL_GAP,
  });
  return nodes;
}

/** The stored rail, flattened to one id per entry (L-155: no groups). */
function railOrder(): ReadonlyArray<string> {
  return useLayoutStore
    .getState()
    .arrangement.rail.map((entry) =>
      entry.kind === "panel" ? leftPanelIdForRailRegion(entry.id) : entry.id,
    );
}

/** Seeds the stored rail directly, the same way `setToolbarLeft` does for the
 * toolbar - so a test can mount a rail (with a divider the shipped default no
 * longer carries) that matches what the drop is actually placed against. */
function setRail(rail: ReadonlyArray<RailEntry>): void {
  const arrangement = useLayoutStore.getState().arrangement;
  useLayoutStore.setState({ arrangement: { ...arrangement, rail } });
}

/** One surface's own laid-out box, marked the way the real surfaces mark it. */
function box(parent: HTMLElement, top: number, height: number): HTMLElement {
  const node = document.createElement("div");
  node.setAttribute(LAYOUT_CLUSTER_ATTRIBUTE, "");
  parent.append(node);
  stubRect(node, { left: 0, top, width: 300, height });
  return node;
}

function stubRect(
  node: HTMLElement,
  rect: {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
  },
): void {
  node.getBoundingClientRect = () => ({
    left: rect.left,
    top: rect.top,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
    width: rect.width,
    height: rect.height,
    x: rect.left,
    y: rect.top,
    toJSON: () => ({}),
  });
}

function dragBy(
  node: HTMLElement,
  to: { readonly clientX?: number; readonly clientY?: number },
): void {
  const arm = (event: Event): void => {
    if (!(event instanceof PointerEvent)) return;
    armCanvasDrag({ event, node });
  };
  node.addEventListener("pointerdown", arm);
  node.dispatchEvent(
    new PointerEvent("pointerdown", {
      bubbles: true,
      pointerId: 1,
      button: 0,
      clientX: 0,
      clientY: 0,
    }),
  );
  node.removeEventListener("pointerdown", arm);
  window.dispatchEvent(
    new PointerEvent("pointermove", {
      bubbles: true,
      pointerId: 1,
      clientX: to.clientX === undefined ? 0 : 8,
      clientY: to.clientY === undefined ? 0 : 8,
    }),
  );
  window.dispatchEvent(
    new PointerEvent("pointermove", {
      bubbles: true,
      pointerId: 1,
      clientX: to.clientX ?? 0,
      clientY: to.clientY ?? 0,
    }),
  );
  window.dispatchEvent(
    new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }),
  );
}

beforeEach(() => {
  // Reduced motion, so the release is placed rather than thrown and the drop
  // lands in the same tick as the pointer leaving.
  document.documentElement.setAttribute("data-reduce-panel-motion", "");
  window.localStorage.clear();
  useLayoutStore.setState({
    ...DEFAULT_LAYOUT_SNAPSHOT,
  });
  useLayoutEditorStore.getState().endSession();
  useLayoutEditorStore.getState().beginSession({
    entry: "pointer",
    source: "direct_ui",
    startedAt: 0,
    origin: { kind: "tab" },
  });
});

afterEach(() => {
  cancelLayoutDrag();
  useLayoutEditorStore.getState().endSession();
  document.documentElement.removeAttribute("data-reduce-panel-motion");
  document.body.replaceChildren();
});

describe("dragging a region on the canvas", () => {
  it("reorders its cluster as ONE history entry, and undo puts it back", () => {
    setToolbarLeft(["attachImage", "access", "mic"]);
    const nodes = mountToolbar(["attachImage", "access", "mic"]);

    // Far enough right for the first chip's LEADING EDGE to pass the second's
    // centre (L-143): the chips are 30 wide and 4 apart, so that centre is at
    // 49 and the edge starts at 30, which is 19px of travel.
    dragBy(nodes[0], { clientX: 60 });

    expect(useLayoutStore.getState().arrangement.toolbarLeft).toEqual([
      "access",
      "attachImage",
      "mic",
    ]);
    expect(useLayoutEditorStore.getState().history.past).toHaveLength(1);

    useLayoutEditorStore.getState().undo();

    expect(useLayoutStore.getState().arrangement.toolbarLeft).toEqual([
      "attachImage",
      "access",
      "mic",
    ]);
  });

  it("keeps a member that is not on the canvas beside its own neighbours", () => {
    setToolbarLeft(["attachImage", "access", "mic"]);
    // `access` is hidden, so the canvas shows two of the three.
    const nodes = mountToolbar(["attachImage", "mic"]);

    dragBy(nodes[0], { clientX: 60 });

    expect(useLayoutStore.getState().arrangement.toolbarLeft).toEqual([
      "access",
      "mic",
      "attachImage",
    ]);
    expect(useLayoutEditorStore.getState().history.past).toHaveLength(1);
  });

  it("does not pick up a region that has no order of its own", () => {
    // No `data-layout-group`, because `useLayoutRegion` stamps one only for a
    // region a canvas drag can reorder.
    const node = document.createElement("div");
    node.setAttribute("data-layout-region", "minimap");
    document.body.append(node);

    armCanvasDrag({
      event: new PointerEvent("pointerdown", { pointerId: 1, button: 0 }),
      node,
    });

    expect(layoutDragActive()).toBe(false);
  });
});

/**
 * The sidebar rail, which L-115 restored to the canvas: one cluster, and a
 * drop placed by an entry's id. A stacked pair draws as ONE icon (G3) - the
 * top's - so the members a press reorders against are the panels that stand
 * alone, whatever dividers the user placed, and one member per pair.
 */
/**
 * The nine panels with no link and no divider.
 *
 * What most of these cases are about is the drag ENGINE's geometry, so they
 * use this flat list rather than the shipped rail's own stack - the "carries
 * a pair whole" claim gets its own case below instead of complicating every
 * one of these with a member that has no node of its own.
 */
const FLAT_RAIL: ReadonlyArray<RailEntry> = DEFAULT_RAIL.filter(
  (entry) => entry.kind === "panel",
);

describe("dragging in the sidebar rail", () => {
  it("moves a panel past its neighbour, placed by id", () => {
    // Artifacts sits at 40..76 and Files at 80..116 (centre 98). A slot is
    // claimed when the leading edge passes the neighbour's centre (L-143).
    // The engine's grab point is the move that crosses the 6px activation
    // distance, which this helper sends at clientY:8, so a final clientY:40
    // travels 32 past that grab point - carrying Artifacts' bottom edge to
    // 40 + 32 + 36 = 108, past Files' centre at 98 and short of Terminals'
    // at 138.
    setRail(FLAT_RAIL);
    const nodes = mountRail(FLAT_RAIL);

    dragBy(nodes[1], { clientY: 40 });

    expect(railOrder()).toEqual([
      "chats",
      "files",
      "artifacts",
      "terminals",
      "browsers",
      "git-diff",
      "pull-requests",
      "file-tree",
      "sharing",
      "comments",
    ]);
    expect(useLayoutEditorStore.getState().history.past).toHaveLength(1);
  });

  it("carries a stacked pair whole and lands it beside a target's whole pair, never between (G3)", () => {
    // Two joined pairs: the shipped Agents+Artifacts, and a second one made up
    // for this case - Terminals+Browsers - so the DROP TARGET is a pair too.
    // Neither bottom member (Artifacts, Browsers) draws a canvas node, so the
    // press only ever sees the two tops.
    const rail: ReadonlyArray<RailEntry> = [
      { kind: "panel", id: "railAgents" },
      { kind: "stack", id: "stack:railAgents+railArtifacts" },
      { kind: "panel", id: "railArtifacts" },
      { kind: "panel", id: "railTerminals" },
      { kind: "stack", id: "stack:railTerminals+railBrowsers" },
      { kind: "panel", id: "railBrowsers" },
      ...FLAT_RAIL.slice(4),
    ];
    setRail(rail);
    const nodes = mountRail([
      { kind: "panel", id: "railAgents" },
      { kind: "panel", id: "railTerminals" },
      ...FLAT_RAIL.slice(4),
    ]);

    dragBy(nodes[0], { clientY: 40 });

    // The Agents pair lands AFTER the whole Terminals+Browsers pair - not
    // wedged between Terminals and Browsers, even though the press only ever
    // targeted Terminals' own icon.
    expect(
      useLayoutStore.getState().arrangement.rail.map((entry) => entry.id),
    ).toEqual([
      "railTerminals",
      "stack:railTerminals+railBrowsers",
      "railBrowsers",
      "railAgents",
      "stack:railAgents+railArtifacts",
      "railArtifacts",
      "railFiles",
      "railGitDiff",
      "railPullRequests",
      "railFileTree",
      "railSharing",
      "railComments",
    ]);
    expect(useLayoutEditorStore.getState().history.past).toHaveLength(1);
  });

  it("moves a DIVIDER, placed the same way a panel is", () => {
    // A divider the user added between Chats and Artifacts (which the drop
    // pushes to 52..88, centre 70). The same clientY:40 (32px past the
    // clientY:8 grab point) carries the divider's leading edge to 80, past
    // Artifacts' centre and short of Files' at 110, so it settles right
    // after Artifacts instead of before it.
    const entries: ReadonlyArray<RailEntry> = [
      ...FLAT_RAIL.slice(0, 1),
      { kind: "divider", id: railDividerId(1) },
      ...FLAT_RAIL.slice(1),
    ];
    setRail(entries);
    const nodes = mountRail(entries);

    dragBy(nodes[1], { clientY: 40 });

    expect(railOrder()).toEqual([
      "chats",
      "artifacts",
      railDividerId(1),
      "files",
      "terminals",
      "browsers",
      "git-diff",
      "pull-requests",
      "file-tree",
      "sharing",
      "comments",
    ]);
    expect(useLayoutEditorStore.getState().history.past).toHaveLength(1);
  });
});

/**
 * The dock is the one group the app draws in TWO containers: a chip-sized row
 * stands in the composer's compact strip while its full-size siblings stay in
 * the dock, with the whole transcript between them (G3-01).
 */
describe("a dock whose members are not all the same size", () => {
  it("reorders the rows drawn in the dock, leaving the chip where it stands", () => {
    // One chip in the strip, two full rows in the dock: the pair on screen in
    // the dock is `changedFiles` then `background`, which is NOT their stored
    // pair, so an index into the drawn order picks the wrong member out of the
    // stored one.
    const nodes = mountDock([
      { regionId: "changedFiles", chip: false },
      { regionId: "runningAgents", chip: true },
      { regionId: "background", chip: false },
    ]);

    // `background` is the second dock row; pulled a row and a half up, its
    // centre passes the first row's.
    dragBy(nodes[2], { clientY: -60 });

    // `background` moved; `runningAgents`, drawn in the other container and no
    // part of this gesture, keeps its place after `changedFiles`. `todo` keeps
    // the front of the stored order although this scene draws nothing for it
    // (L-142), which is the same claim one step further: a drop writes back
    // the WHOLE stored order, and a member the canvas never showed cannot be
    // moved by one.
    expect(useLayoutStore.getState().arrangement.dock).toEqual([
      "todo",
      "background",
      "changedFiles",
      "runningAgents",
    ]);
    expect(useLayoutEditorStore.getState().history.past).toHaveLength(1);
  });

  it("reorders the chips drawn in the strip, leaving the row where it stands", () => {
    const nodes = mountDock([
      { regionId: "changedFiles", chip: true },
      { regionId: "runningAgents", chip: false },
      { regionId: "background", chip: true },
    ]);

    // The chips sit side by side, so this cluster runs on the other axis:
    // `background` is the second chip, pulled left past the first.
    dragBy(nodes[2], { clientX: -40 });

    expect(useLayoutStore.getState().arrangement.dock).toEqual([
      "todo",
      "background",
      "changedFiles",
      "runningAgents",
    ]);
    expect(useLayoutEditorStore.getState().history.past).toHaveLength(1);
  });

  it("picks up nothing from a container holding one member", () => {
    // The one full row has no sibling drawn beside it; the two chips are in
    // the strip, and reaching across to them would infer the axis over the
    // whole transcript and clamp against the tile. The inspector's list still
    // reorders the whole group (L-68).
    const nodes = mountDock([
      { regionId: "changedFiles", chip: true },
      { regionId: "runningAgents", chip: false },
      { regionId: "background", chip: true },
    ]);

    dragBy(nodes[1], { clientY: 200 });

    expect(useLayoutStore.getState().arrangement.dock).toEqual(
      DEFAULT_DOCK_ORDER,
    );
    expect(useLayoutEditorStore.getState().history.past).toHaveLength(0);
  });
});
