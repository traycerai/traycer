import { describe, expect, it } from "vitest";
import {
  insertionIndexForTarget,
  insertionIndexFromPointer,
  insertionOffsetsFor,
  stripOffsetsFor,
  overlayLeftForPointer,
  provisionalStripOrder,
  reconstructionErrorPx,
  remapGeometryToSlots,
  resolveStripDragState,
  swapHysteresisPx,
  type StripDragGeometry,
  type StripDragState,
  type StripSlot,
} from "@/components/epic-canvas/dnd/strip-drag-model";

const ORIGIN = 200;

function slots(
  widths: ReadonlyArray<number>,
  mergeable: ReadonlyArray<boolean> | null = null,
  gap = 0,
): ReadonlyArray<StripSlot> {
  let contentLeft = 0;
  return widths.map((width, index) => {
    const isLast = index === widths.length - 1;
    const slot: StripSlot = {
      itemId: `item-${index}`,
      width,
      contentLeft,
      advance: isLast ? width : width + gap,
      isMergeTarget: mergeable === null ? true : (mergeable[index] ?? true),
    };
    contentLeft += width + gap;
    return slot;
  });
}

/** Slots alone, for the functions that do not need a full geometry. */
function slotsFor(widths: ReadonlyArray<number>): ReadonlyArray<StripSlot> {
  return slots(widths);
}

/** Grab offset centred on the source, which is the common real gesture. */
function geometryFor(
  widths: ReadonlyArray<number>,
  sourceIndex: number,
  mergeable: ReadonlyArray<boolean> | null = null,
): StripDragGeometry {
  const built = slots(widths, mergeable);
  if (sourceIndex < 0 || sourceIndex >= built.length) {
    throw new Error("bad source index");
  }
  const source = built[sourceIndex];
  return {
    slots: built,
    sourceIndex,
    grabOffsetX: source.width / 2,
    sourceInitialLeft: ORIGIN + source.contentLeft,
    sourceWidth: source.width,
    stripTop: 0,
    stripBottom: 38,
  };
}

/** Pointer x that puts the dragged tab's centre exactly at `centre`. */
function pointerForCentre(geometry: StripDragGeometry, centre: number): number {
  const sourceWidth = geometry.slots[geometry.sourceIndex]?.width ?? 0;
  return centre + geometry.grabOffsetX - sourceWidth / 2;
}

function sweep(
  geometry: StripDragGeometry,
  xs: ReadonlyArray<number>,
): ReadonlyArray<StripDragState> {
  const states: StripDragState[] = [];
  let previous: StripDragState | null = null;
  for (const pointerX of xs) {
    previous = resolveStripDragState({
      geometry,
      contentOriginX: ORIGIN,
      pointerX,
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
  describe("hysteresis is derived from the swap rule", () => {
    it("depends on the source width alone, not the mean of the pair", () => {
      // The two formulations coincide only for equal widths, which is exactly
      // why the mean is the wrong figure: a split group is one strip item of
      // its own width.
      expect(swapHysteresisPx(191)).toBe(191);
      expect(swapHysteresisPx(382)).toBe(382);
      expect(swapHysteresisPx(120)).toBe(120);
    });

    it("measures the real reversal distance on an asymmetric strip", () => {
      const geometry = geometryFor([120, 300, 200], 0);
      const forward = range(0, 900, 1).map((offset) => ({
        x: ORIGIN + offset,
        index: resolveStripDragState({
          geometry,
          contentOriginX: ORIGIN,
          pointerX: ORIGIN + offset,
          previous: null,
        }).targetIndex,
      }));
      const swapForward = forward.find((entry) => entry.index === 1);
      expect(swapForward).toBeDefined();

      // Now approach the same boundary from the far side and find where it
      // swaps back. The gap between the two crossings is the hysteresis.
      let previous: StripDragState | null = {
        kind: "reorder",
        targetIndex: 1,
      };
      let swapBackX: number | null = null;
      for (let x = swapForward?.x ?? 0; x > ORIGIN - 400; x -= 1) {
        const next = resolveStripDragState({
          geometry,
          contentOriginX: ORIGIN,
          pointerX: x,
          previous,
        });
        previous = next;
        if (next.targetIndex === 0) {
          swapBackX = x;
          break;
        }
      }
      expect(swapBackX).not.toBeNull();
      const measured = (swapForward?.x ?? 0) - (swapBackX ?? 0);
      // Both crossings are at neighbour centres, so the reversal distance is
      // exactly the source width. They are found by walking integer x against a
      // strict inequality, so each lands up to 1px beyond its threshold and the
      // measurement can only ever overshoot by the 2px of sampling granularity.
      const derived = swapHysteresisPx(120);
      expect(derived).toBe(120);
      expect(measured).toBeGreaterThanOrEqual(derived);
      expect(measured).toBeLessThanOrEqual(derived + 2);
    });
  });

  describe("monotonicity", () => {
    it("never decreases the index under a rightward sweep", () => {
      const geometry = geometryFor([191, 191, 191, 191], 0);
      const indices = sweep(geometry, range(ORIGIN, ORIGIN + 800, 3)).map(
        (state) => state.targetIndex,
      );
      for (let i = 1; i < indices.length; i += 1) {
        expect(indices[i]).toBeGreaterThanOrEqual(indices[i - 1] ?? 0);
      }
      expect(indices.at(-1)).toBe(3);
    });

    it("never increases the index under a leftward sweep", () => {
      const geometry = geometryFor([191, 191, 191, 191], 3);
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
      const geometry = geometryFor([191, 191, 191, 191], 0);
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
      const geometry = geometryFor([191, 191, 191, 191], 0);
      const jumped = resolveStripDragState({
        geometry,
        contentOriginX: ORIGIN,
        pointerX: ORIGIN + 700,
        previous: { kind: "reorder", targetIndex: 0 },
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
          const geometry = geometryFor(widths, source);
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
        const geometry = geometryFor(widths, source);
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
  });

  describe("scroll independence", () => {
    it("fires the boundary at the same content position after a scroll", () => {
      const geometry = geometryFor([191, 191, 191], 0);
      const findBoundary = (originX: number): number | null => {
        let previous: StripDragState | null = null;
        for (let offset = 0; offset < 800; offset += 1) {
          previous = resolveStripDragState({
            geometry,
            contentOriginX: originX,
            pointerX: originX + offset,
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

  describe("merge disambiguation", () => {
    it("mirrors merge and reorder halves with the direction of approach", () => {
      const widths = [100, 100, 100];
      const targetCentre = ORIGIN + 150;

      const fromLeft = geometryFor(widths, 0);
      const leftApproach = resolveStripDragState({
        geometry: fromLeft,
        contentOriginX: ORIGIN,
        pointerX: pointerForCentre(fromLeft, targetCentre - 25),
        previous: null,
      });
      expect(leftApproach.kind).toBe("merge");
      expect(
        leftApproach.kind === "merge" ? leftApproach.targetItemId : null,
      ).toBe("item-1");
      // Approaching from the left, the dragged tab takes the pair's left side.
      expect(
        leftApproach.kind === "merge" ? leftApproach.targetSide : null,
      ).toBe("left");
      expect(
        resolveStripDragState({
          geometry: fromLeft,
          contentOriginX: ORIGIN,
          pointerX: pointerForCentre(fromLeft, targetCentre + 1),
          previous: leftApproach,
        }).kind,
      ).toBe("reorder");

      const fromRight = geometryFor(widths, 2);
      const rightApproach = resolveStripDragState({
        geometry: fromRight,
        contentOriginX: ORIGIN,
        pointerX: pointerForCentre(fromRight, targetCentre + 25),
        previous: null,
      });
      expect(rightApproach.kind).toBe("merge");
      expect(
        rightApproach.kind === "merge" ? rightApproach.targetItemId : null,
      ).toBe("item-1");
      // Approaching from the right, the dragged tab takes the pair's right side.
      expect(
        rightApproach.kind === "merge" ? rightApproach.targetSide : null,
      ).toBe("right");
      expect(
        resolveStripDragState({
          geometry: fromRight,
          contentOriginX: ORIGIN,
          pointerX: pointerForCentre(fromRight, targetCentre - 1),
          previous: rightApproach,
        }).kind,
      ).toBe("reorder");
    });

    it("merges the moment the centre reaches a neighbour's half - no dwell", () => {
      // The state is a pure function of position: there is no timer and no
      // arming period, so a single resolve on the neighbour's half IS the
      // merge. (The 400ms dwell this replaced existed to disambiguate a
      // full-tab merge target; the approach-half split killed the ambiguity.)
      const geometry = geometryFor([191, 191, 191], 0);
      const merged = resolveStripDragState({
        geometry,
        contentOriginX: ORIGIN,
        pointerX: pointerForCentre(geometry, ORIGIN + 191 + 191 / 2),
        previous: null,
      });
      expect(merged.kind).toBe("merge");
      expect(merged.kind === "merge" ? merged.targetItemId : null).toBe(
        "item-1",
      );
    });

    it("keeps a merge on the approaching half, then reorders past midpoint", () => {
      const geometry = geometryFor([191, 191, 191], 0);
      const centre = ORIGIN + 191 + 191 / 2;
      const pointerX = pointerForCentre(geometry, centre);
      const merge: StripDragState = {
        kind: "merge",
        targetIndex: 0,
        targetItemId: "item-1",
        targetSide: "left",
      };
      const insideHalf = resolveStripDragState({
        geometry,
        contentOriginX: ORIGIN,
        pointerX: pointerX - 4,
        previous: merge,
      });
      expect(insideHalf.kind).toBe("merge");

      const pastMidpoint = resolveStripDragState({
        geometry,
        contentOriginX: ORIGIN,
        pointerX: pointerX + 4,
        previous: merge,
      });
      expect(pastMidpoint.kind).toBe("reorder");
    });

    it("re-arms merge on a passed neighbour when reversing after a swap", () => {
      // The direction-lock regression: filtering candidates by NET travel
      // (targetIndex vs sourceIndex) made a reversal dead. Drag item-0 right
      // past item-1 (swap), then bring the centre back onto item-1's right
      // half: item-1 now occupies the leading slot, the centre is visibly on
      // it, and the merge must arm - side "right", the approach side.
      const geometry = geometryFor([100, 100, 100], 0);
      const swapped = resolveStripDragState({
        geometry,
        contentOriginX: ORIGIN,
        pointerX: pointerForCentre(geometry, ORIGIN + 151),
        previous: null,
      });
      expect(swapped.kind).toBe("reorder");
      expect(swapped.targetIndex).toBe(1);

      // Provisional order is [1, 0, 2]: item-1's slot spans [0..100] with its
      // centre at 50, so centre 75 is on its right half.
      const reversed = resolveStripDragState({
        geometry,
        contentOriginX: ORIGIN,
        pointerX: pointerForCentre(geometry, ORIGIN + 75),
        previous: swapped,
      });
      expect(reversed.kind).toBe("merge");
      expect(reversed.kind === "merge" ? reversed.targetItemId : null).toBe(
        "item-1",
      );
      expect(reversed.kind === "merge" ? reversed.targetSide : null).toBe(
        "right",
      );
    });

    it("never merges into a split group - it reorders past it", () => {
      const geometry = geometryFor([191, 382, 191], 0, [true, false, true]);
      const splitCentre = ORIGIN + 191 + 382 / 2;
      const pointerX = pointerForCentre(geometry, splitCentre);
      const state = resolveStripDragState({
        geometry,
        contentOriginX: ORIGIN,
        pointerX,
        previous: null,
      });
      expect(state.kind).toBe("reorder");
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
      const centreGrab = geometryFor(widths, 1);
      const edgeGrab: StripDragGeometry = { ...centreGrab, grabOffsetX: 95 };

      for (const geometry of [centreGrab, edgeGrab]) {
        // Dragged tab's centre on the target's near (right) half: merge, with
        // the dragged tab taking the pair's right side. For the edge grab the
        // POINTER is still right of the target's slot here - that must not
        // matter.
        const nearHalf = resolveStripDragState({
          geometry,
          contentOriginX: ORIGIN,
          pointerX: pointerForCentre(geometry, targetCentre + 25),
          previous: null,
        });
        expect(nearHalf.kind).toBe("merge");
        expect(nearHalf.kind === "merge" ? nearHalf.targetSide : null).toBe(
          "right",
        );
        // Centre past the target's midpoint: the swap fires.
        const pastMidpoint = resolveStripDragState({
          geometry,
          contentOriginX: ORIGIN,
          pointerX: pointerForCentre(geometry, targetCentre - 1),
          previous: nearHalf,
        });
        expect(pastMidpoint.kind).toBe("reorder");
        expect(pastMidpoint.targetIndex).toBe(0);
      }
    });

    it("keeps the merge band reachable rather than shadowed by the swap", () => {
      // The regression this guards: if the swap boundary sat AT the neighbour's
      // centre, the band could never be occupied and merge would be unreachable.
      const geometry = geometryFor([191, 191, 191], 0);
      const centre = ORIGIN + 191 + 191 / 2;
      const state = resolveStripDragState({
        geometry,
        contentOriginX: ORIGIN,
        pointerX: pointerForCentre(geometry, centre),
        previous: null,
      });
      expect(state.kind).toBe("merge");
      expect(state.targetIndex).toBe(0);
    });
  });

  describe("degenerate strips", () => {
    it("cannot reorder a single-tab strip", () => {
      const geometry = geometryFor([191], 0);
      const indices = sweep(geometry, range(ORIGIN - 300, ORIGIN + 300, 7)).map(
        (state) => state.targetIndex,
      );
      expect(new Set(indices)).toEqual(new Set([0]));
    });

    it("handles a two-tab strip in both directions", () => {
      const geometry = geometryFor([191, 191], 0);
      expect(
        sweep(geometry, range(ORIGIN, ORIGIN + 400, 4)).at(-1)?.targetIndex,
      ).toBe(1);
    });
  });

  describe("mid-drag strip mutation", () => {
    it("remaps the source by id when neighbours appear", () => {
      const geometry = geometryFor([191, 191], 1);
      const grown = remapGeometryToSlots(geometry, slots([191, 191, 191, 191]));
      // `item-1` is still at index 1 here, but the lookup is by id, not index.
      expect(grown?.sourceIndex).toBe(1);
      expect(grown?.slots).toHaveLength(4);
    });

    it("returns null when the dragged item is gone", () => {
      const geometry = geometryFor([191, 191], 1);
      const removed: ReadonlyArray<StripSlot> = [
        {
          itemId: "item-0",
          width: 191,
          contentLeft: 0,
          advance: 191,
          isMergeTarget: true,
        },
      ];
      expect(remapGeometryToSlots(geometry, removed)).toBeNull();
    });
  });

  describe("layout reconstruction is checked, not assumed", () => {
    it("reconstructs a contiguous strip exactly", () => {
      expect(reconstructionErrorPx(slots([191, 191, 191]))).toBe(0);
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
        sourceIndex: 0,
        grabOffsetX: 60,
        sourceInitialLeft: ORIGIN,
        sourceWidth: 120,
        stripTop: 0,
        stripBottom: 38,
      };
      // Neighbour 1 sits at contentLeft 140, so its centre is ORIGIN + 200.
      // Ignoring the gap would put it at ORIGIN + 180 and every boundary with it.
      const centre = ORIGIN + 200;
      const state = resolveStripDragState({
        geometry,
        contentOriginX: ORIGIN,
        pointerX: pointerForCentre(geometry, centre),
        previous: null,
      });
      expect(state.kind).toBe("merge");
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
      for (const grabOffsetX of [0, 95, W]) {
        for (
          let pointerX = STRIP_LEFT + grabOffsetX;
          pointerX < STRIP_RIGHT - W + grabOffsetX;
          pointerX += 7
        ) {
          const left = overlayLeftForPointer({
            pointerX,
            grabOffsetX,
            sourceWidth: W,
            stripLeft: STRIP_LEFT,
            stripRight: STRIP_RIGHT,
          });
          expect(pointerX - left).toBeCloseTo(grabOffsetX, 6);
        }
      }
    });

    it("never pins at the source's original right edge", () => {
      // 213/404/594.4 are the three source positions whose right edge WAS the
      // observed pin. At pointerX 888 the true answer is the strip's right
      // bound (784.16), which is legitimately clamped - the defect pinned at
      // 404.3, a third of the strip away and unrelated to any bound.
      const left = overlayLeftForPointer({
        pointerX: 888,
        grabOffsetX: 95,
        sourceWidth: W,
        stripLeft: STRIP_LEFT,
        stripRight: STRIP_RIGHT,
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
      const atLeft = overlayLeftForPointer({
        pointerX: 0,
        grabOffsetX: 95,
        sourceWidth: W,
        stripLeft: STRIP_LEFT,
        stripRight: STRIP_RIGHT,
      });
      expect(atLeft).toBe(STRIP_LEFT);
      const atRight = overlayLeftForPointer({
        pointerX: 5000,
        grabOffsetX: 95,
        sourceWidth: W,
        stripLeft: STRIP_LEFT,
        stripRight: STRIP_RIGHT,
      });
      expect(atRight).toBeCloseTo(STRIP_RIGHT - W, 6);
    });

    it("degrades to the strip's left edge when the strip is narrower than the tab", () => {
      expect(
        overlayLeftForPointer({
          pointerX: 900,
          grabOffsetX: 0,
          sourceWidth: 400,
          stripLeft: 100,
          stripRight: 300,
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
      const at = (pointerX: number) =>
        resolveStripDragState({
          geometry,
          contentOriginX: ORIGIN,
          pointerX,
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
      let state = resolveStripDragState({
        geometry,
        contentOriginX: ORIGIN,
        pointerX: pointerForCentre(geometry, centre),
        previous: null,
      });
      expect(state.kind).toBe("reorder");
      state = resolveStripDragState({
        geometry,
        contentOriginX: ORIGIN,
        pointerX: pointerForCentre(geometry, centre),
        previous: state,
      });
      expect(state.kind).toBe("reorder");
    });

    it("gives a tile strip hysteresis of exactly the dragged tile's width", () => {
      // D2.5: the derived gap is w_s alone, and "w_s" means the DRAGGED
      // tile's measured width - tile widths are unequal.
      expect(swapHysteresisPx(130)).toBe(130);
      expect(swapHysteresisPx(192)).toBe(192);
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
      const geometry = geometryFor([130, 101, 192], 1);
      const offsets = stripOffsetsFor(geometry, 1);
      expect([...offsets.values()].every((v) => v === 0)).toBe(true);
    });

    it("swaps exactly two tiles by their widths on a one-boundary move", () => {
      // Unequal widths: tile 0 is 130 wide, tile 1 is 101. Moving 0 past 1
      // shifts 1 left by 130 and 0 right by 101 - not by a shared constant.
      const geometry = geometryFor([130, 101, 192], 0);
      const offsets = stripOffsetsFor(geometry, 1);
      expect(offsets.get("item-1")).toBe(-130);
      expect(offsets.get("item-0")).toBe(101);
      expect(offsets.get("item-2")).toBe(0);
    });

    it("keeps the origin placeholder when the tile has left the strip", () => {
      const geometry = geometryFor([130, 101, 192], 0);
      const offsets = stripOffsetsFor(geometry, null);
      expect(offsets.size).toBe(0);
    });

    it("does not displace either side of a retained origin placeholder", () => {
      const geometry = geometryFor([130, 101, 192], 1);
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
      const at = (pointerX: number) =>
        insertionIndexFromPointer(slots, ORIGIN, pointerX);
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
});
