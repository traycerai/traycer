import { describe, expect, it } from "vitest";
import {
  provisionalStripOrder,
  resolveStripDragState,
  stripLayoutFor,
  stripOffsetsFor,
  type StripDragGeometry,
  type StripDragState,
  type StripGroupExtent,
  type StripSlot,
} from "@/components/epic-canvas/dnd/strip-drag-model";

/** A 32px row of the sidebar, with the strip's 2px gap, at `start`. */
interface Row {
  readonly id: string;
  readonly start: number;
  readonly groupId: string | null;
}

const ROW = 32;
const RUN_GAP = 2;
/** A block's header, its gap and its top padding before the first row, and its bottom padding. */
const LEAD = 34;
const TAIL = 4;

function group(
  groupId: string,
  start: number,
  end: number,
  lane: string | null,
): StripGroupExtent {
  return { groupId, start, end, lane, rowGap: 2, locked: false };
}

function geometryOf(
  rows: ReadonlyArray<Row>,
  groups: ReadonlyArray<StripGroupExtent>,
  sourceId: string,
): StripDragGeometry {
  const slots = rows.map((row, index): StripSlot => ({
    itemId: row.id,
    extent: ROW,
    contentStart: row.start,
    advance: index + 1 < rows.length ? rows[index + 1].start - row.start : ROW,
    isMergeTarget: true,
    lane: null,
    groupId: row.groupId,
  }));
  return {
    slots,
    groups,
    runGap: RUN_GAP,
    sourceIndex: rows.findIndex((row) => row.id === sourceId),
    grabOffset: ROW / 2,
    sourceInitialStart: 0,
    sourceExtent: ROW,
    bandStart: 0,
    bandEnd: 200,
  };
}

/**
 * An ungrouped row `u`, a block of `f` and `m` (header 34px, 4px under the last
 * row), and an ungrouped row `v`: the sidebar's Layered view as measured.
 */
const BLOCK_STRIP: ReadonlyArray<Row> = [
  { id: "u", start: 0, groupId: null },
  { id: "f", start: 68, groupId: "g" },
  { id: "m", start: 102, groupId: "g" },
  { id: "v", start: 140, groupId: null },
];
const BLOCK = group("g", 34, 138, null);

describe("stripLayoutFor", () => {
  it("leaves every tab and every group where it is when nothing moves", () => {
    const layout = stripLayoutFor(
      geometryOf(BLOCK_STRIP, [BLOCK], "m"),
      2,
      "g",
    );

    expect([...layout.offsets.values()]).toEqual([0, 0, 0, 0]);
    expect(layout.groups).toEqual([
      { groupId: "g", lane: null, offset: 0, grow: 0, visible: true },
    ]);
  });

  it("moves a block's header with its tabs and grows the block, for a tab dragged in from above", () => {
    // `u` dropped between `f` and `m`: the block is now the first thing in the
    // strip, `u` having left the space above it, and holds three rows.
    const geometry = geometryOf(BLOCK_STRIP, [BLOCK], "u");
    const layout = stripLayoutFor(geometry, 1, "g");

    expect(Object.fromEntries(layout.offsets)).toEqual({
      f: -34,
      u: 68,
      m: 0,
      v: 0,
    });
    const placed = layout.groups[0];
    expect(placed).toMatchObject({ offset: -34, grow: 34, visible: true });
    // The first row sits a whole header below the block's top, where it was:
    // no row slides over the header it should have carried along.
    const blockTop = BLOCK.start + placed.offset;
    const firstRow = BLOCK_STRIP[1].start + (layout.offsets.get("f") ?? 0);
    expect(firstRow - blockTop).toBe(LEAD);
    // The block ends a padding below its last row.
    const lastRow = BLOCK_STRIP[2].start + (layout.offsets.get("m") ?? 0);
    expect(blockTop + BLOCK.end - BLOCK.start + placed.grow).toBe(
      lastRow + ROW + TAIL,
    );
  });

  it("shrinks the block and moves its header down, for a tab dragged out of its top", () => {
    const layout = stripLayoutFor(
      geometryOf(BLOCK_STRIP, [BLOCK], "f"),
      0,
      null,
    );

    expect(Object.fromEntries(layout.offsets)).toEqual({
      f: -68,
      u: 34,
      m: 0,
      v: 0,
    });
    expect(layout.groups[0]).toMatchObject({ offset: 34, grow: -34 });
  });

  it("draws a group nothing of when its last tab is dragged out", () => {
    const single: ReadonlyArray<Row> = [
      { id: "u", start: 0, groupId: null },
      { id: "f", start: 68, groupId: "g" },
      { id: "v", start: 106, groupId: null },
    ];
    const layout = stripLayoutFor(
      geometryOf(single, [group("g", 34, 104, null)], "f"),
      2,
      null,
    );

    expect(layout.groups[0].visible).toBe(false);
    expect(Object.fromEntries(layout.offsets)).toEqual({ u: 0, v: -72, f: 0 });
  });

  it("carries a collapsed group's header with the tabs around it", () => {
    // `p`, a header only (34..62), `r`: `p` dragged below `r` leaves the header
    // first in the strip, which is where it moves to.
    const rows: ReadonlyArray<Row> = [
      { id: "p", start: 0, groupId: null },
      { id: "r", start: 64, groupId: null },
    ];
    const layout = stripLayoutFor(
      geometryOf(rows, [group("g", 34, 62, null)], "p"),
      1,
      null,
    );

    expect(layout.groups[0]).toMatchObject({ offset: -34, visible: true });
    expect(Object.fromEntries(layout.offsets)).toEqual({ r: -34, p: 64 });
  });

  it("displaces a strip with no groups by the tabs' own advance, as before", () => {
    const rows: ReadonlyArray<Row> = [
      { id: "a", start: 0, groupId: null },
      { id: "b", start: 34, groupId: null },
      { id: "c", start: 68, groupId: null },
    ];
    const geometry = geometryOf(rows, [], "a");

    expect(stripLayoutFor(geometry, 2, null)).toEqual({
      offsets: stripOffsetsFor(geometry, 2),
      groups: [],
    });
  });

  it("ignores the blocks of another section, which the drag never touches", () => {
    const geometry = geometryOf(
      BLOCK_STRIP,
      [group("g", 34, 138, "idle")],
      "u",
    );

    expect(stripLayoutFor(geometry, 1, null).groups).toEqual([]);
  });
});

describe("the swap rule in a strip with groups", () => {
  /** The integer centres from `from` to `to`, either direction. */
  function path(from: number, to: number): ReadonlyArray<number> {
    const step = from <= to ? 1 : -1;
    return Array.from(
      { length: Math.abs(to - from) + 1 },
      (_, i) => from + i * step,
    );
  }

  /** The index after each dragged centre in turn, the previous frame carried over. */
  function sweep(
    geometry: StripDragGeometry,
    centres: ReadonlyArray<number>,
  ): ReadonlyArray<{ readonly centre: number; readonly index: number }> {
    const states: Array<{ readonly centre: number; readonly index: number }> =
      [];
    let previous: StripDragState | null = null;
    for (const centre of centres) {
      previous = resolveStripDragState({
        geometry,
        contentOrigin: 0,
        // The grab offset is half the row, so the dragged centre is the pointer.
        pointer: centre,
        now: 0,
        canSplit: false,
        previous,
      });
      states.push({ centre, index: previous.targetIndex });
    }
    return states;
  }

  const geometry = geometryOf(BLOCK_STRIP, [BLOCK], "u");
  const indexAt = (
    states: ReadonlyArray<{ readonly centre: number; readonly index: number }>,
    centre: number,
  ): number | undefined => states.find((s) => s.centre === centre)?.index;

  it("swaps with a tab exactly when the dragged centre crosses where that tab is drawn, dragging down into a block", () => {
    const down = sweep(geometry, path(-20, 250));

    for (const index of [0, 1, 2]) {
      // The tab beside the dragged one in the provisional order, and where the
      // layout the preview draws puts it.
      const neighbour = provisionalStripOrder(geometry.slots, 0, index)[
        index + 1
      ];
      const layout = stripLayoutFor(geometry, index, "g");
      const drawnCentre =
        neighbour.contentStart +
        (layout.offsets.get(neighbour.itemId) ?? 0) +
        neighbour.extent / 2;

      expect(indexAt(down, drawnCentre), neighbour.itemId).toBe(index);
      expect(indexAt(down, drawnCentre + 1), neighbour.itemId).toBe(index + 1);
    }
  });

  it("reverses a swap exactly when the dragged centre recrosses where the passed tab is drawn now, a header further up", () => {
    // `u` dragged into the block after `f`: `f` moves up a whole header to the
    // top of the strip, where the block now begins, and that - not the row it
    // was measured on - is the line the pointer has to come back across.
    const sweptBack = sweep(geometry, [...path(-20, 100), ...path(100, -20)]);
    const back = sweptBack.slice(path(-20, 100).length);
    const passed = provisionalStripOrder(geometry.slots, 0, 1)[0];
    const layout = stripLayoutFor(geometry, 1, "g");
    const drawnCentre =
      passed.contentStart +
      (layout.offsets.get(passed.itemId) ?? 0) +
      passed.extent / 2;

    expect(drawnCentre).toBe(50);
    expect(indexAt(back, drawnCentre)).toBe(1);
    expect(indexAt(back, drawnCentre - 1)).toBe(0);
  });

  it("keeps the index monotone, never alternating, and a swap's reversal a row away, through a block", () => {
    const down = sweep(geometry, path(-20, 250));
    const up = sweep(geometry, path(250, -20));
    for (let i = 1; i < down.length; i += 1) {
      expect(down[i].index).toBeGreaterThanOrEqual(down[i - 1].index);
      expect(up[i].index).toBeLessThanOrEqual(up[i - 1].index);
    }
    for (const states of [down, up]) {
      for (let i = 2; i < states.length; i += 1) {
        const alternating =
          states[i].index === states[i - 2].index &&
          states[i].index !== states[i - 1].index;
        expect(alternating).toBe(false);
      }
    }
    // The swap with the block's first tab, and its reversal: the reversal is
    // at least the dragged row's height back, so a pointer at rest on the
    // boundary cannot flip it.
    const forward = down.find((s) => s.index >= 1)?.centre ?? Number.NaN;
    const back = up.find((s) => s.index < 1)?.centre ?? Number.NaN;
    expect(forward - back).toBeGreaterThanOrEqual(ROW);
  });
});
