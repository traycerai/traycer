import { describe, expect, it } from "vitest";
import {
  insertionIndexForTarget,
  insertionIndexFromPointer,
  insertionOffsetsFor,
  laneBoundsOf,
  laneSlotsOf,
  stripOffsetsFor,
  overlayStartForPointer,
  provisionalStripOrder,
  reconstructionErrorPx,
  remapGeometryToSlots,
  resolveStripDragState,
  type ResolveStripDragInput,
  type StripDragGeometry,
  type StripDragState,
  type StripGroupExtent,
  type StripSlot,
} from "@/components/epic-canvas/dnd/strip-drag-model";

const ORIGIN = 200;

/** One frame of a pointer drag, which can split. */
function resolve(
  input: Omit<ResolveStripDragInput, "canSplit">,
): StripDragState {
  return resolveStripDragState({ ...input, canSplit: true });
}

/** The state with the dragged centre at `centre`, from `previous`. */
function resolveCentre(
  geometry: StripDragGeometry,
  centre: number,
  previous: StripDragState | null,
): StripDragState {
  return resolve({
    geometry,
    contentOrigin: ORIGIN,
    pointer: pointerForCentre(geometry, centre),
    previous,
  });
}

/** A reorder state at `targetIndex`, the carry-over a frame resolves from. */
function reorderAt(targetIndex: number): StripDragState {
  return { kind: "reorder", targetIndex, groupId: null, joinsGroup: false };
}

/** What a frame shows: a split on a task, or the gap at an index. */
function shown(state: StripDragState): string {
  return state.kind === "merge"
    ? `split ${state.targetItemId}`
    : `gap ${state.targetIndex}`;
}

/**
 * Whether any shown state comes back after another one replaced it, which is
 * what a flicker is: under a monotone sweep each state is shown in one run.
 */
function flickers(states: ReadonlyArray<StripDragState>): boolean {
  const ended = new Set<string>();
  let current: string | null = null;
  for (const state of states) {
    const next = shown(state);
    if (next === current) continue;
    if (ended.has(next)) return true;
    if (current !== null) ended.add(current);
    current = next;
  }
  return false;
}

function slots(
  widths: ReadonlyArray<number>,
  mergeable: ReadonlyArray<boolean> | null,
  gap: number,
): ReadonlyArray<StripSlot> {
  let contentStart = 0;
  return widths.map((width, index) => {
    const isLast = index === widths.length - 1;
    const slot: StripSlot = {
      itemId: `item-${index}`,
      extent: width,
      contentStart,
      advance: isLast ? width : width + gap,
      isMergeTarget: mergeable === null ? true : (mergeable[index] ?? true),
      lane: null,
      groupId: null,
    };
    contentStart += width + gap;
    return slot;
  });
}

/** Slots alone, for the functions that do not need a full geometry. */
function slotsFor(widths: ReadonlyArray<number>): ReadonlyArray<StripSlot> {
  return slots(widths, null, 0);
}

/** Grab offset centred on the source, which is the common real gesture. */
function geometryFor(
  widths: ReadonlyArray<number>,
  sourceIndex: number,
  mergeable: ReadonlyArray<boolean> | null,
): StripDragGeometry {
  return gappedGeometryFor(widths, sourceIndex, mergeable, 0);
}

/** `geometryFor` over a strip whose measured advance carries `gap`. */
function gappedGeometryFor(
  widths: ReadonlyArray<number>,
  sourceIndex: number,
  mergeable: ReadonlyArray<boolean> | null,
  gap: number,
): StripDragGeometry {
  const built = slots(widths, mergeable, gap);
  if (sourceIndex < 0 || sourceIndex >= built.length) {
    throw new Error("bad source index");
  }
  const source = built[sourceIndex];
  return {
    slots: built,
    groups: [],
    runGap: gap,
    sourceIndex,
    grabOffset: source.extent / 2,
    sourceInitialStart: ORIGIN + source.contentStart,
    sourceExtent: source.extent,
    bandStart: 0,
    bandEnd: 38,
  };
}

/** A group drawn from `start` to `end`, with no gap between its tabs, unlocked. */
function extentOf(
  groupId: string,
  start: number,
  end: number,
): StripGroupExtent {
  return { groupId, start, end, lane: null, rowGap: 0, locked: false };
}

/**
 * A strip of equal 100-wide tabs, `groupIds` giving each tab's group, with the
 * groups drawn as `extents` (content-box ranges) and the source at `sourceIndex`.
 */
function groupedGeometryFor(
  groupIds: ReadonlyArray<string | null>,
  extents: ReadonlyArray<StripGroupExtent>,
  sourceIndex: number,
): StripDragGeometry {
  const plain = geometryFor(
    groupIds.map(() => 100),
    sourceIndex,
    null,
  );
  return {
    ...plain,
    slots: plain.slots.map((slot, index) => ({
      ...slot,
      groupId: groupIds[index] ?? null,
    })),
    groups: extents,
  };
}

/** Pointer x that puts the dragged tab's centre exactly at `centre`. */
function pointerForCentre(geometry: StripDragGeometry, centre: number): number {
  const sourceExtent = geometry.slots[geometry.sourceIndex]?.extent ?? 0;
  return centre + geometry.grabOffset - sourceExtent / 2;
}

function sweep(
  geometry: StripDragGeometry,
  xs: ReadonlyArray<number>,
): ReadonlyArray<StripDragState> {
  const states: StripDragState[] = [];
  let previous: StripDragState | null = null;
  for (const pointer of xs) {
    previous = resolve({
      geometry,
      contentOrigin: ORIGIN,
      pointer,
      previous,
    });
    states.push(previous);
  }
  return states;
}

function range(from: number, to: number, step: number): ReadonlyArray<number> {
  const out: number[] = [];
  for (let x = from; x <= to; x += step) out.push(x);
  return out;
}

describe("header strip drag model", () => {
  describe("monotonicity", () => {
    it("never decreases the index under a rightward sweep", () => {
      const geometry = geometryFor([191, 191, 191, 191], 0, null);
      const indices = sweep(geometry, range(ORIGIN, ORIGIN + 800, 3)).map(
        (state) => state.targetIndex,
      );
      for (let i = 1; i < indices.length; i += 1) {
        expect(indices[i]).toBeGreaterThanOrEqual(indices[i - 1] ?? 0);
      }
      expect(indices.at(-1)).toBe(3);
    });

    it("never increases the index under a leftward sweep", () => {
      const geometry = geometryFor([191, 191, 191, 191], 3, null);
      const xs = range(ORIGIN, ORIGIN + 800, 3)
        .slice()
        .reverse();
      const indices = sweep(geometry, xs).map((state) => state.targetIndex);
      for (let i = 1; i < indices.length; i += 1) {
        expect(indices[i]).toBeLessThanOrEqual(indices[i - 1] ?? 0);
      }
      expect(indices.at(-1)).toBe(0);
    });

    it("moves at most one boundary per sample even on a fast sweep", () => {
      // A frame that spans three tabs must still land three single-boundary
      // swaps rather than one jump, so every displaced tab animates.
      const geometry = geometryFor([191, 191, 191, 191], 0, null);
      const indices = sweep(geometry, range(ORIGIN, ORIGIN + 800, 3)).map(
        (state) => state.targetIndex,
      );
      for (let i = 1; i < indices.length; i += 1) {
        expect(
          Math.abs((indices[i] ?? 0) - (indices[i - 1] ?? 0)),
        ).toBeLessThanOrEqual(1);
      }
    });

    it("settles a multi-tab jump deterministically in one resolution", () => {
      const geometry = geometryFor([191, 191, 191, 191], 0, null);
      // Into the last tab's far quarter (from 716.25 of content).
      const jumped = resolve({
        geometry,
        contentOrigin: ORIGIN,
        pointer: ORIGIN + 740,
        previous: reorderAt(0),
      });
      expect(jumped.targetIndex).toBe(3);
    });
  });

  describe("no alternation (the oscillation property)", () => {
    const geometries: ReadonlyArray<ReadonlyArray<number>> = [
      [191, 191, 191, 191],
      [120, 300, 200, 260],
      [382, 191, 191],
      [64, 64],
      [191],
      [40, 900, 40],
    ];

    for (const widths of geometries) {
      for (let source = 0; source < widths.length; source += 1) {
        it(`never alternates for widths ${widths.join("/")} from index ${source}`, () => {
          const geometry = geometryFor(widths, source, null);
          const total = widths.reduce((sum, width) => sum + width, 0);
          const states = sweep(
            geometry,
            range(ORIGIN - 200, ORIGIN + total + 200, 2),
          );
          const indices = states.map((state) => state.targetIndex);
          for (let i = 2; i < indices.length; i += 1) {
            const alternating =
              indices[i] === indices[i - 2] && indices[i] !== indices[i - 1];
            expect(alternating).toBe(false);
          }
        });
      }
    }

    it("holds under a randomised sequence of geometries", () => {
      let seed = 20260827;
      const random = () => {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return seed / 2147483648;
      };
      for (let trial = 0; trial < 200; trial += 1) {
        const count = 1 + Math.floor(random() * 5);
        const widths = Array.from(
          { length: count },
          () => 40 + Math.floor(random() * 400),
        );
        const source = Math.floor(random() * count);
        const geometry = geometryFor(widths, source, null);
        const total = widths.reduce((sum, width) => sum + width, 0);
        const indices = sweep(
          geometry,
          range(ORIGIN - 100, ORIGIN + total + 100, 5),
        ).map((state) => state.targetIndex);
        for (let i = 2; i < indices.length; i += 1) {
          const alternating =
            indices[i] === indices[i - 2] && indices[i] !== indices[i - 1];
          expect(alternating).toBe(false);
        }
        for (let i = 1; i < indices.length; i += 1) {
          expect(indices[i]).toBeGreaterThanOrEqual(indices[i - 1] ?? 0);
        }
      }
    });

    // The model is one-dimensional: a side strip feeds it y positions and row
    // heights. What it adds over the tables above is a measured gap in every
    // advance (the strip's 2px row gap) and a split pair as one taller item.
    it("holds on a gapped strip of rows, from every source", () => {
      const heights = [32, 32, 66, 32, 32];
      for (let source = 0; source < heights.length; source += 1) {
        const geometry = gappedGeometryFor(heights, source, null, 2);
        const indices = sweep(
          geometry,
          range(ORIGIN - 100, ORIGIN + 350, 1),
        ).map((state) => state.targetIndex);
        for (let i = 2; i < indices.length; i += 1) {
          const alternating =
            indices[i] === indices[i - 2] && indices[i] !== indices[i - 1];
          expect(alternating).toBe(false);
        }
      }
      const fromTop = sweep(
        gappedGeometryFor(heights, 0, null, 2),
        range(ORIGIN, ORIGIN + 300, 1),
      ).map((state) => state.targetIndex);
      for (let i = 1; i < fromTop.length; i += 1) {
        expect(fromTop[i]).toBeGreaterThanOrEqual(fromTop[i - 1] ?? 0);
        expect(
          Math.abs((fromTop[i] ?? 0) - (fromTop[i - 1] ?? 0)),
        ).toBeLessThanOrEqual(1);
      }
      expect(fromTop.at(-1)).toBe(heights.length - 1);
    });
  });

  describe("scroll independence", () => {
    it("fires the boundary at the same content position after a scroll", () => {
      const geometry = geometryFor([191, 191, 191], 0, null);
      const findBoundary = (originX: number): number | null => {
        let previous: StripDragState | null = null;
        for (let offset = 0; offset < 800; offset += 1) {
          previous = resolve({
            geometry,
            contentOrigin: originX,
            pointer: originX + offset,
            previous,
          });
          if (previous.targetIndex === 1) return offset;
        }
        return null;
      };
      // Scrolling shifts the content origin; the boundary must not move
      // relative to the content.
      expect(findBoundary(ORIGIN)).toBe(findBoundary(ORIGIN - 137));
      expect(findBoundary(ORIGIN)).not.toBeNull();
    });
  });

  describe("the zones", () => {
    // Three 100-wide tabs; the middle one spans 100..200 of content. From the
    // left its near quarter is 100..125, its middle half 125..175 and its far
    // quarter 175..200; from the right the quarters are the mirror.
    const fromLeft = geometryFor([100, 100, 100], 0, null);
    const fromRight = geometryFor([100, 100, 100], 2, null);
    const at = (geometry: StripDragGeometry, centre: number) =>
      resolveCentre(geometry, ORIGIN + centre, null);

    it("splits at once in a task's middle half, on the side it approaches from", () => {
      for (const centre of [125, 150, 175]) {
        expect(at(fromLeft, centre)).toEqual({
          kind: "merge",
          targetIndex: 0,
          groupId: null,
          targetItemId: "item-1",
          targetSide: "left",
        });
        expect(at(fromRight, centre)).toEqual({
          kind: "merge",
          targetIndex: 2,
          groupId: null,
          targetItemId: "item-1",
          targetSide: "right",
        });
      }
    });

    it("stays on the near side in a task's near quarter", () => {
      expect(at(fromLeft, 124)).toEqual(reorderAt(0));
      expect(at(fromRight, 176)).toEqual(reorderAt(2));
    });

    it("passes a task in its far quarter, opening the gap beyond it", () => {
      expect(at(fromLeft, 176)).toEqual(reorderAt(1));
      expect(at(fromRight, 124)).toEqual(reorderAt(1));
    });

    it("never splits on a keyboard drag, which passes a task at its centre", () => {
      const keyboard = (centre: number) =>
        resolveStripDragState({
          geometry: fromLeft,
          contentOrigin: ORIGIN,
          pointer: pointerForCentre(fromLeft, ORIGIN + centre),
          previous: null,
          canSplit: false,
        });
      expect(keyboard(150)).toEqual(reorderAt(0));
      expect(keyboard(151)).toEqual(reorderAt(1));
    });

    it("splits with a passed task again only once the centre is back in its middle", () => {
      // Filtering by net travel once made a reversal dead. item-1, passed, is
      // drawn at 0..100: its near quarter is 75..100, its middle 25..75, and the
      // quarter that passes it back 0..25.
      const passed = at(fromLeft, 176);
      expect(resolveCentre(fromLeft, ORIGIN + 76, passed)).toEqual(
        reorderAt(1),
      );
      expect(resolveCentre(fromLeft, ORIGIN + 75, passed)).toEqual({
        kind: "merge",
        targetIndex: 1,
        groupId: null,
        targetItemId: "item-1",
        targetSide: "right",
      });
      expect(resolveCentre(fromLeft, ORIGIN + 24, passed)).toEqual(
        reorderAt(0),
      );
    });

    it("never splits with a split pair, and passes it at its centre", () => {
      const geometry = geometryFor([191, 382, 191], 0, [true, false, true]);
      const pairCentre = ORIGIN + 191 + 382 / 2;
      expect(resolveCentre(geometry, pairCentre, null)).toEqual(reorderAt(0));
      expect(resolveCentre(geometry, pairCentre + 1, null)).toEqual(
        reorderAt(1),
      );
    });

    it("follows the dragged tab's centre, so an edge grab cannot dead-zone a neighbour", () => {
      // The reported regression: zones resolved against the raw POINTER. Grab
      // the second tab by its trailing (right) edge and drag left, and the
      // tab visibly sits on top of the first tab while the pointer is still
      // back over the source slot - the pointer never enters the target, so
      // nothing highlighted and nothing swapped. The user watches the tab in
      // their hand; the zones must follow its centre, wherever it was grabbed.
      const widths = [100, 100, 100];
      const targetCentre = ORIGIN + 50;
      const centreGrab = geometryFor(widths, 1, null);
      const edgeGrab: StripDragGeometry = { ...centreGrab, grabOffset: 95 };

      for (const geometry of [centreGrab, edgeGrab]) {
        // Dragged tab's centre in the target's middle: split, with the dragged
        // tab taking the pair's right side. For the edge grab the POINTER is
        // still right of the target's slot here - that must not matter.
        const middle = resolveCentre(geometry, targetCentre + 20, null);
        expect(middle).toMatchObject({ kind: "merge", targetSide: "right" });
        // Centre in the target's far quarter: it is passed.
        expect(resolveCentre(geometry, targetCentre - 26, middle)).toEqual(
          reorderAt(0),
        );
      }
    });
  });

  describe("the zones on mixed rows, in both strips", () => {
    // The top bar's tabs of unequal widths; the sidebar's 52px two-line rows,
    // 32px rows and a 66px split pair (which cannot be split with) a 2px gap
    // apart; and the sidebar with a group block around the 32px row and the
    // pair, its header and padding 24px above them and 4px below.
    const sidebarWithBlock = (sourceIndex: number): StripDragGeometry => {
      const plain = gappedGeometryFor(
        [52, 32, 66, 52, 32],
        sourceIndex,
        [true, true, false, true, true],
        2,
      );
      const starts = [0, 78, 112, 184, 238];
      const built = plain.slots.map((slot, index) => ({
        ...slot,
        contentStart: starts[index] ?? 0,
        advance:
          index + 1 < starts.length
            ? (starts[index + 1] ?? 0) - (starts[index] ?? 0)
            : slot.extent,
        groupId: index === 1 || index === 2 ? "g" : null,
      }));
      const source = built[sourceIndex];
      return {
        ...plain,
        slots: built,
        groups: [{ ...extentOf("g", 54, 182), rowGap: 2 }],
        sourceInitialStart: ORIGIN + source.contentStart,
      };
    };
    const strips: ReadonlyArray<{
      readonly name: string;
      readonly geometryFor: (sourceIndex: number) => StripDragGeometry;
    }> = [
      {
        name: "the top bar",
        geometryFor: (source) =>
          geometryFor([191, 120, 240, 160], source, null),
      },
      {
        name: "the sidebar",
        geometryFor: (source) =>
          gappedGeometryFor(
            [52, 32, 66, 52, 32],
            source,
            [true, true, false, true, true],
            2,
          ),
      },
      { name: "the sidebar with a block", geometryFor: sidebarWithBlock },
    ];

    for (const strip of strips) {
      const count = strip.geometryFor(0).slots.length;
      for (let source = 0; source < count; source += 1) {
        const geometry = strip.geometryFor(source);
        const own = geometry.slots[source];
        const ownCentre = ORIGIN + own.contentStart + own.extent / 2;
        const last = geometry.slots[count - 1];
        const end = ORIGIN + last.contentStart + last.extent;
        const down = range(ownCentre, end + 40, 1).map((centre) =>
          pointerForCentre(geometry, centre),
        );
        const up = range(ORIGIN - 40, ownCentre, 1)
          .toReversed()
          .map((centre) => pointerForCentre(geometry, centre));
        const mergeable = (index: number) =>
          index !== source && (geometry.slots[index]?.isMergeTarget ?? false);

        it(`moves monotonically and never flickers in ${strip.name}, from row ${source}`, () => {
          for (const [sweepOf, sign] of [
            [down, 1],
            [up, -1],
          ] as const) {
            const states = sweep(geometry, sweepOf);
            for (let i = 1; i < states.length; i += 1) {
              const step =
                (states[i]?.targetIndex ?? 0) -
                (states[i - 1]?.targetIndex ?? 0);
              expect(step * sign).toBeGreaterThanOrEqual(0);
            }
            expect(flickers(states)).toBe(false);
          }
        });

        it(`reaches the whole of every task's middle half in ${strip.name}, dragging down and up from row ${source}`, () => {
          // Sampled every 1px, so a middle half of h px shows its split on
          // about h samples, whichever way it is approached.
          const shownOn = new Map<string, number>();
          for (const state of [
            ...sweep(geometry, down),
            ...sweep(geometry, up),
          ]) {
            if (state.kind !== "merge") continue;
            shownOn.set(shown(state), (shownOn.get(shown(state)) ?? 0) + 1);
          }
          const expected = geometry.slots.flatMap((slot, index) =>
            mergeable(index) ? [`split ${slot.itemId}`] : [],
          );
          expect([...shownOn.keys()].sort()).toEqual(expected.sort());
          for (const [index, slot] of geometry.slots.entries()) {
            if (!mergeable(index)) continue;
            expect(shownOn.get(`split ${slot.itemId}`)).toBeGreaterThanOrEqual(
              slot.extent / 2 - 1,
            );
          }
        });
      }
    }
  });

  describe("group membership", () => {
    // Five 100-wide tabs: t1 and t2 are group "g", drawn as one block that
    // reaches 4px past them (content 96..304).
    const grouped = (sourceIndex: number): StripDragGeometry =>
      groupedGeometryFor(
        [null, "g", "g", null, null],
        [extentOf("g", 96, 304)],
        sourceIndex,
      );
    const dropAt = (geometry: StripDragGeometry, centre: number) =>
      resolve({
        geometry,
        contentOrigin: ORIGIN,
        pointer: pointerForCentre(geometry, ORIGIN + centre),
        previous: null,
      });
    const groupOf = (state: StripDragState): string | null =>
      state.kind === "reorder" ? state.groupId : null;

    it("joins a drop between two tabs of one group, and shows it as a join", () => {
      // t0 dragged past t1's centre (150) and short of t2's (250).
      const state = dropAt(grouped(0), 210);
      expect(state).toMatchObject({
        kind: "reorder",
        targetIndex: 1,
        groupId: "g",
        joinsGroup: true,
      });
    });

    it("keeps a grouped tab in its group while it rests, and when it moves inside it", () => {
      expect(dropAt(grouped(2), 250)).toMatchObject({
        groupId: "g",
        joinsGroup: false,
      });
      expect(dropAt(grouped(1), 280)).toMatchObject({
        targetIndex: 2,
        groupId: "g",
        joinsGroup: false,
      });
    });

    it("lets the side of the group's edge the centre is on decide, at its end", () => {
      // t2, the group's last tab, at the same slot (index 2): the block ends
      // at 304.
      expect(groupOf(dropAt(grouped(2), 303))).toBe("g");
      expect(groupOf(dropAt(grouped(2), 305))).toBeNull();
      // An ungrouped t3 dragged up to the same boundary joins on the group's
      // side of it and does not on the other.
      expect(dropAt(grouped(3), 290)).toMatchObject({
        groupId: "g",
        joinsGroup: true,
      });
      expect(dropAt(grouped(3), 310)).toMatchObject({
        groupId: null,
        joinsGroup: false,
      });
    });

    it("lets the side of the group's edge decide, at its start, and takes the header", () => {
      // t0 stays before t1 (centre under t1's 150) the whole way: over the
      // block's top 4px and its first tab it joins, above it it does not.
      expect(dropAt(grouped(0), 100)).toMatchObject({
        groupId: "g",
        joinsGroup: true,
      });
      expect(groupOf(dropAt(grouped(0), 90))).toBeNull();
    });

    it("joins a collapsed group, which has no tab to be a neighbour of, by its header", () => {
      // The group draws no tab, only its header band (100..130).
      const geometry = groupedGeometryFor(
        [null, null, null],
        [extentOf("h", 100, 130)],
        0,
      );
      expect(dropAt(geometry, 115)).toMatchObject({
        groupId: "h",
        joinsGroup: true,
      });
      // Past the next tab's far quarter (175): beside it, out of the header.
      expect(dropAt(geometry, 180)).toMatchObject({
        targetIndex: 1,
        groupId: null,
      });
    });

    it("measures the group in the strip's content box, so a scroll cannot move it", () => {
      const geometry = grouped(3);
      const input = {
        geometry,
        pointer: pointerForCentre(geometry, ORIGIN + 290),
        previous: null,
      };
      expect(groupOf(resolve({ ...input, contentOrigin: ORIGIN }))).toBe("g");
      // Scrolled 137px: the same content position is 137px further left, and
      // so is the pointer that is on it.
      expect(
        groupOf(
          resolve({
            ...input,
            contentOrigin: ORIGIN - 137,
            pointer: input.pointer - 137,
          }),
        ),
      ).toBe("g");
    });
  });

  describe("a locked group", () => {
    // The group "g" of t1 and t2 is an organization's: block 96..304, and the
    // drag never changes who is in it.
    const locked = (sourceIndex: number): StripDragGeometry =>
      groupedGeometryFor(
        [null, "g", "g", null, null],
        [{ ...extentOf("g", 96, 304), locked: true }],
        sourceIndex,
      );
    const dropAt = (geometry: StripDragGeometry, centre: number) =>
      resolve({
        geometry,
        contentOrigin: ORIGIN,
        pointer: pointerForCentre(geometry, ORIGIN + centre),
        previous: null,
      });

    it("is never joined, though the drop is inside its block, and is crossed whole", () => {
      // t0 beside the group, over its block: next to it, not in it.
      expect(dropAt(locked(0), 100)).toMatchObject({
        targetIndex: 0,
        groupId: null,
        joinsGroup: false,
      });
      // The group's centre (200) is crossed once, with both its tabs, so the
      // dragged tab is never left between them.
      expect(dropAt(locked(0), 190).targetIndex).toBe(0);
      expect(dropAt(locked(0), 210).targetIndex).toBe(2);
    });

    it("keeps its tab in its group and in the group's run, however far it is dragged", () => {
      expect(dropAt(locked(1), 450)).toMatchObject({
        targetIndex: 2,
        groupId: "g",
        joinsGroup: false,
      });
      expect(dropAt(locked(2), -50)).toMatchObject({
        targetIndex: 1,
        groupId: "g",
        joinsGroup: false,
      });
    });
  });

  describe("degenerate strips", () => {
    it("cannot reorder a single-tab strip", () => {
      const geometry = geometryFor([191], 0, null);
      const indices = sweep(geometry, range(ORIGIN - 300, ORIGIN + 300, 7)).map(
        (state) => state.targetIndex,
      );
      expect(new Set(indices)).toEqual(new Set([0]));
    });

    it("handles a two-tab strip in both directions", () => {
      const geometry = geometryFor([191, 191], 0, null);
      expect(
        sweep(geometry, range(ORIGIN, ORIGIN + 400, 4)).at(-1)?.targetIndex,
      ).toBe(1);
    });
  });

  describe("mid-drag strip mutation", () => {
    it("remaps the source by id when neighbours appear", () => {
      const geometry = geometryFor([191, 191], 1, null);
      const grown = remapGeometryToSlots(
        geometry,
        slots([191, 191, 191, 191], null, 0),
        [],
      );
      // `item-1` is still at index 1 here, but the lookup is by id, not index.
      expect(grown?.sourceIndex).toBe(1);
      expect(grown?.slots).toHaveLength(4);
    });

    it("returns null when the dragged item is gone", () => {
      const geometry = geometryFor([191, 191], 1, null);
      const removed: ReadonlyArray<StripSlot> = [
        {
          itemId: "item-0",
          extent: 191,
          contentStart: 0,
          advance: 191,
          isMergeTarget: true,
          lane: null,
          groupId: null,
        },
      ];
      expect(remapGeometryToSlots(geometry, removed, [])).toBeNull();
    });
  });

  describe("layout reconstruction is checked, not assumed", () => {
    it("reconstructs a contiguous strip exactly", () => {
      expect(reconstructionErrorPx(slots([191, 191, 191], null, 0))).toBe(0);
    });

    it("reconstructs a gapped strip exactly, because advance is measured", () => {
      // Prefix-summing raw widths would drift by `gap` per slot and be worst at
      // the right end - the accumulating bias the measured advance removes.
      expect(reconstructionErrorPx(slots([191, 191, 191], null, 7))).toBe(0);
    });

    it("puts boundaries in the right place on a gapped strip", () => {
      const built = slots([120, 120, 120], null, 20);
      const geometry: StripDragGeometry = {
        slots: built,
        groups: [],
        runGap: 20,
        sourceIndex: 0,
        grabOffset: 60,
        sourceInitialStart: ORIGIN,
        sourceExtent: 120,
        bandStart: 0,
        bandEnd: 38,
      };
      // Neighbour 1 sits at contentStart 140, so its centre is ORIGIN + 200.
      // Ignoring the gap would put it at ORIGIN + 180 and every boundary with it.
      const centre = ORIGIN + 200;
      expect(resolveCentre(geometry, centre, null).kind).toBe("merge");
    });
  });

  describe("overlay position (round-1 F1 regression)", () => {
    const STRIP_LEFT = 213;
    const STRIP_RIGHT = 975.16;
    const W = 191;

    it("tracks the pointer with a constant grab offset across the strip", () => {
      // The defect: the overlay pinned at the source's ORIGINAL right edge
      // partway through a drag and stopped tracking, because the clamp was
      // computed against a rect that follows the sliding placeholder while the
      // transform was measured from the original position.
      for (const grabOffset of [0, 95, W]) {
        for (
          let pointer = STRIP_LEFT + grabOffset;
          pointer < STRIP_RIGHT - W + grabOffset;
          pointer += 7
        ) {
          const left = overlayStartForPointer({
            pointer,
            grabOffset,
            sourceExtent: W,
            stripStart: STRIP_LEFT,
            stripEnd: STRIP_RIGHT,
          });
          expect(pointer - left).toBeCloseTo(grabOffset, 6);
        }
      }
    });

    it("never pins at the source's original right edge", () => {
      // 213/404/594.4 are the three source positions whose right edge WAS the
      // observed pin. At pointer 888 the true answer is the strip's right
      // bound (784.16), which is legitimately clamped - the defect pinned at
      // 404.3, a third of the strip away and unrelated to any bound.
      const left = overlayStartForPointer({
        pointer: 888,
        grabOffset: 95,
        sourceExtent: W,
        stripStart: STRIP_LEFT,
        stripEnd: STRIP_RIGHT,
      });
      expect(left).toBeCloseTo(STRIP_RIGHT - W, 6);
      for (const sourceLeft of [213, 404]) {
        expect(left).not.toBeCloseTo(sourceLeft + W, 0);
      }
      // Index 2 is the trap, and it is worth stating numerically: that tab is
      // 190.25 wide, so its original right edge (784.91) EQUALS its own correct
      // bound. Verifying on that one position cannot distinguish a correct
      // build from the broken one.
      const trapWidth = 190.25;
      expect(594.66 + trapWidth).toBeCloseTo(STRIP_RIGHT - trapWidth, 1);
    });

    it("clamps to the strip at both ends and nowhere else", () => {
      const atLeft = overlayStartForPointer({
        pointer: 0,
        grabOffset: 95,
        sourceExtent: W,
        stripStart: STRIP_LEFT,
        stripEnd: STRIP_RIGHT,
      });
      expect(atLeft).toBe(STRIP_LEFT);
      const atRight = overlayStartForPointer({
        pointer: 5000,
        grabOffset: 95,
        sourceExtent: W,
        stripStart: STRIP_LEFT,
        stripEnd: STRIP_RIGHT,
      });
      expect(atRight).toBeCloseTo(STRIP_RIGHT - W, 6);
    });

    it("degrades to the strip's left edge when the strip is narrower than the tab", () => {
      expect(
        overlayStartForPointer({
          pointer: 900,
          grabOffset: 0,
          sourceExtent: 400,
          stripStart: 100,
          stripEnd: 300,
        }),
      ).toBe(100);
    });
  });

  describe("tile strips (no merge)", () => {
    it("puts a tile strip's swap boundary exactly at the neighbour's centre", () => {
      const geometry = geometryFor([130, 101, 192], 0, [false, false, false]);
      const neighbourCentre = ORIGIN + 130 + 101 / 2;
      const justBefore = pointerForCentre(geometry, neighbourCentre - 1);
      const justAfter = pointerForCentre(geometry, neighbourCentre + 1);
      const at = (pointer: number) =>
        resolve({
          geometry,
          contentOrigin: ORIGIN,
          pointer,
          previous: null,
        });
      expect(at(justBefore).targetIndex).toBe(0);
      expect(at(justAfter).targetIndex).toBe(1);
    });

    it("makes merge unreachable on a tile strip", () => {
      // `readTileStripSlots` marks every tile `isMergeTarget: false`: no
      // pointer position can produce a merge state.
      const geometry = geometryFor([130, 101, 192], 0, [false, false, false]);
      const centre = ORIGIN + 130 + 101 / 2;
      let state = resolve({
        geometry,
        contentOrigin: ORIGIN,
        pointer: pointerForCentre(geometry, centre),
        previous: null,
      });
      expect(state.kind).toBe("reorder");
      state = resolve({
        geometry,
        contentOrigin: ORIGIN,
        pointer: pointerForCentre(geometry, centre),
        previous: state,
      });
      expect(state.kind).toBe("reorder");
    });

    it("gives a tile strip hysteresis of exactly the dragged tile's width", () => {
      // Both swaps are at the neighbour's centre, and after the swap that
      // neighbour sits where the dragged tile was: the way back is the DRAGGED
      // tile's width, not the mean of the two.
      const geometry = geometryFor([120, 300, 200], 0, [false, false, false]);
      const indexAt = (pointer: number, previous: StripDragState | null) =>
        resolve({ geometry, contentOrigin: ORIGIN, pointer, previous })
          .targetIndex;
      const forward = range(ORIGIN, ORIGIN + 900, 1).find(
        (pointer) => indexAt(pointer, null) === 1,
      );
      if (forward === undefined) throw new Error("never swapped");
      const back = range(ORIGIN - 400, forward, 1)
        .toReversed()
        .find((pointer) => indexAt(pointer, reorderAt(1)) === 0);
      if (back === undefined) throw new Error("never swapped back");
      // Integer steps against strict thresholds overshoot each by up to 1px.
      expect(forward - back).toBeGreaterThanOrEqual(120);
      expect(forward - back).toBeLessThanOrEqual(122);
    });

    it("stays non-alternating on unequal tile widths", () => {
      const widths = [130, 101, 192, 118];
      for (let source = 0; source < widths.length; source += 1) {
        const geometry = geometryFor(widths, source, [
          false,
          false,
          false,
          false,
        ]);
        const total = widths.reduce((sum, w) => sum + w, 0);
        const indices = sweep(
          geometry,
          range(ORIGIN - 100, ORIGIN + total + 100, 3),
        ).map((st) => st.targetIndex);
        for (let i = 2; i < indices.length; i += 1) {
          const alternating =
            indices[i] === indices[i - 2] && indices[i] !== indices[i - 1];
          expect(alternating).toBe(false);
        }
        for (let i = 1; i < indices.length; i += 1) {
          expect(indices[i]).toBeGreaterThanOrEqual(indices[i - 1] ?? 0);
        }
      }
    });
  });

  describe("explicit displacement offsets", () => {
    it("is all-zero when the item sits at its own index", () => {
      const geometry = geometryFor([130, 101, 192], 1, null);
      const offsets = stripOffsetsFor(geometry, 1);
      expect([...offsets.values()].every((v) => v === 0)).toBe(true);
    });

    it("swaps exactly two tiles by their widths on a one-boundary move", () => {
      // Unequal widths: tile 0 is 130 wide, tile 1 is 101. Moving 0 past 1
      // shifts 1 left by 130 and 0 right by 101 - not by a shared constant.
      const geometry = geometryFor([130, 101, 192], 0, null);
      const offsets = stripOffsetsFor(geometry, 1);
      expect(offsets.get("item-1")).toBe(-130);
      expect(offsets.get("item-0")).toBe(101);
      expect(offsets.get("item-2")).toBe(0);
    });

    it("keeps the origin placeholder when the tile has left the strip", () => {
      const geometry = geometryFor([130, 101, 192], 0, null);
      const offsets = stripOffsetsFor(geometry, null);
      expect(offsets.size).toBe(0);
    });

    it("does not displace either side of a retained origin placeholder", () => {
      const geometry = geometryFor([130, 101, 192], 1, null);
      const offsets = stripOffsetsFor(geometry, null);
      expect(offsets.size).toBe(0);
    });

    it("opens a gap of the arriving tile's width at the insertion point", () => {
      const slots = slotsFor([130, 101, 192]);
      const offsets = insertionOffsetsFor(slots, 1, 77);
      expect(offsets.get("item-0")).toBe(0);
      expect(offsets.get("item-1")).toBe(77);
      expect(offsets.get("item-2")).toBe(77);
    });

    it("opens the gap at the end when inserting past the last tile", () => {
      const slots = slotsFor([130, 101]);
      const offsets = insertionOffsetsFor(slots, 2, 77);
      expect([...offsets.values()].every((v) => v === 0)).toBe(true);
    });
  });

  describe("cross-group insertion index", () => {
    it("counts slot centres passed, with no source slot to skip", () => {
      const slots = slotsFor([130, 101, 192]);
      const at = (pointer: number) =>
        insertionIndexFromPointer(slots, ORIGIN, pointer);
      expect(at(ORIGIN + 1)).toBe(0);
      expect(at(ORIGIN + 64)).toBe(0);
      expect(at(ORIGIN + 66)).toBe(1);
      expect(at(ORIGIN + 130 + 50)).toBe(1);
      expect(at(ORIGIN + 130 + 52)).toBe(2);
      expect(at(ORIGIN + 5000)).toBe(3);
    });

    it("is monotone in the pointer", () => {
      const slots = slotsFor([130, 101, 192, 118]);
      let previous = -1;
      for (let x = ORIGIN - 50; x < ORIGIN + 700; x += 3) {
        const index = insertionIndexFromPointer(slots, ORIGIN, x);
        expect(index).toBeGreaterThanOrEqual(previous);
        previous = index;
      }
    });

    it("returns 0 for an empty strip", () => {
      expect(insertionIndexFromPointer([], ORIGIN, ORIGIN + 400)).toBe(0);
    });
  });

  describe("insertion index conversion", () => {
    it("round-trips every source/target pair through reorderStripItem's rule", () => {
      // `reorderStripItem` removes the item, then inserts at
      // `from < target ? target - 1 : target`. Feed it our insertion index and
      // the result must equal our own provisional order - for every pair.
      const items = ["a", "b", "c", "d", "e"];
      for (let source = 0; source < items.length; source += 1) {
        for (let target = 0; target < items.length; target += 1) {
          const insertion = insertionIndexForTarget(source, target);
          const clamped = Math.max(0, Math.min(insertion, items.length));
          const reducerIndex = source < clamped ? clamped - 1 : clamped;
          const without = items.filter((_entry, index) => index !== source);
          const reducerResult = [
            ...without.slice(0, reducerIndex),
            items[source] ?? "",
            ...without.slice(reducerIndex),
          ];
          expect(reducerResult).toEqual(
            provisionalStripOrder(items, source, target),
          );
        }
      }
    });
  });

  describe("provisionalStripOrder", () => {
    it("moves the source to the target index", () => {
      expect(provisionalStripOrder(["a", "b", "c", "d"], 0, 2)).toEqual([
        "b",
        "c",
        "a",
        "d",
      ]);
      expect(provisionalStripOrder(["a", "b", "c", "d"], 3, 1)).toEqual([
        "a",
        "d",
        "b",
        "c",
      ]);
    });

    it("is identity for a no-op or an out-of-range move", () => {
      expect(provisionalStripOrder(["a", "b"], 0, 0)).toEqual(["a", "b"]);
      expect(provisionalStripOrder(["a", "b"], 0, 5)).toEqual(["a", "b"]);
      expect(provisionalStripOrder(["a", "b"], -1, 1)).toEqual(["a", "b"]);
    });
  });

  describe("a sectioned strip's lanes", () => {
    const ROW = 30;
    const GAP = 2;
    const HEADER = 28;

    /**
     * Two sections under headers: Working holds w0 and w1, Idle holds i0, i1
     * and i2. Each slot's `advance` is measured to the next slot of the whole
     * strip, so w1's takes in Idle's header.
     */
    function sectioned(): ReadonlyArray<StripSlot> {
      const starts: ReadonlyArray<readonly [string, string, number]> = [
        ["w0", "working", 0],
        ["w1", "working", ROW + GAP],
        ["i0", "idle", 2 * (ROW + GAP) + HEADER],
        ["i1", "idle", 3 * (ROW + GAP) + HEADER],
        ["i2", "idle", 4 * (ROW + GAP) + HEADER],
      ];
      return starts.map(([itemId, lane, contentStart], index) => ({
        itemId,
        extent: ROW,
        contentStart,
        advance:
          index + 1 < starts.length ? starts[index + 1][2] - contentStart : ROW,
        isMergeTarget: true,
        lane,
        groupId: null,
      }));
    }

    function geometryOver(
      laneSlots: ReadonlyArray<StripSlot>,
      sourceItemId: string,
    ): StripDragGeometry {
      const sourceIndex = laneSlots.findIndex(
        (slot) => slot.itemId === sourceItemId,
      );
      return {
        slots: laneSlots,
        groups: [],
        runGap: GAP,
        sourceIndex,
        grabOffset: ROW / 2,
        sourceInitialStart: ORIGIN + laneSlots[sourceIndex].contentStart,
        sourceExtent: ROW,
        bandStart: 0,
        bandEnd: 240,
      };
    }

    it("keeps the source's lane, each slot's advance measured to the next slot of that lane", () => {
      const lane = laneSlotsOf(sectioned(), "i1");

      expect(lane.map((slot) => slot.itemId)).toEqual(["i0", "i1", "i2"]);
      // w1's advance, which reached across the header, is not in play here.
      expect(lane.map((slot) => slot.advance)).toEqual([
        ROW + GAP,
        ROW + GAP,
        ROW,
      ]);
    });

    it("leaves a strip with no lanes as measured", () => {
      const flat = slotsFor([191, 191, 191]);

      expect(laneSlotsOf(flat, "item-1")).toBe(flat);
    });

    it("keeps a fresh full measurement to the lane the drag began in", () => {
      const began = geometryOver(laneSlotsOf(sectioned(), "i1"), "i1");

      const remapped = remapGeometryToSlots(began, sectioned(), []);

      expect(remapped?.slots.map((slot) => slot.itemId)).toEqual([
        "i0",
        "i1",
        "i2",
      ]);
      expect(remapped?.sourceIndex).toBe(1);
    });

    it("reorders among the lane's slots however far the pointer goes, and displaces only them", () => {
      // Working draws w0 and w1 as group "g"'s block, which a drag in Idle
      // never joins, though the pointer strays over it.
      const geometry: StripDragGeometry = {
        ...geometryOver(laneSlotsOf(sectioned(), "i1"), "i1"),
        groups: [
          {
            ...extentOf("g", 0, 2 * (ROW + GAP)),
            lane: "working",
            rowGap: GAP,
          },
        ],
      };
      const overOtherLane = resolve({
        geometry,
        contentOrigin: ORIGIN,
        pointer: ORIGIN + ROW,
        previous: null,
      });
      expect(overOtherLane).toMatchObject({ targetIndex: 0, groupId: null });
      const above = resolve({
        geometry,
        contentOrigin: ORIGIN,
        pointer: ORIGIN - 500,
        previous: null,
      });
      const below = resolve({
        geometry,
        contentOrigin: ORIGIN,
        pointer: ORIGIN + 5_000,
        previous: null,
      });

      expect(above.targetIndex).toBe(0);
      expect(below.targetIndex).toBe(2);
      expect([...stripOffsetsFor(geometry, 2).keys()].sort()).toEqual([
        "i0",
        "i1",
        "i2",
      ]);
    });

    it("bounds the lane by its first and last slot", () => {
      const geometry = geometryOver(laneSlotsOf(sectioned(), "i1"), "i1");

      expect(laneBoundsOf(geometry, ORIGIN)).toEqual({
        start: ORIGIN + 2 * (ROW + GAP) + HEADER,
        end: ORIGIN + 4 * (ROW + GAP) + HEADER + ROW,
      });
      expect(laneBoundsOf(geometryFor([191, 191], 0, null), ORIGIN)).toBeNull();
    });
  });
});
