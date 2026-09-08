import { describe, expect, it } from "vitest";
import {
  resolveStripDragState,
  resolveStripReorderState,
  stripOffsetsFor,
  swapHysteresisPx,
  type StripDragGeometry,
  type StripDragState,
  type StripSlot,
} from "@/components/epic-canvas/dnd/strip-drag-model";

const ORIGIN = 200;

function slots(
  widths: ReadonlyArray<number>,
  mergeable: ReadonlyArray<boolean> | null,
  gap: number,
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

type GrabOffset = "centred" | number;

function geometryFor(
  widths: ReadonlyArray<number>,
  sourceIndex: number,
  mergeable: ReadonlyArray<boolean> | null,
  grabOffset: GrabOffset,
): StripDragGeometry {
  const built = slots(widths, mergeable, 0);
  if (sourceIndex < 0 || sourceIndex >= built.length)
    throw new Error("bad source index");
  const source = built[sourceIndex];
  return {
    slots: built,
    sourceIndex,
    grabOffsetX: grabOffset === "centred" ? source.width / 2 : grabOffset,
    sourceInitialLeft: ORIGIN + source.contentLeft,
    sourceWidth: source.width,
    stripTop: 0,
    stripBottom: 38,
  };
}

/** Pointer x that puts the dragged tab's centre exactly at `centre`. */
function pointerForCentre(geometry: StripDragGeometry, centre: number): number {
  return centre + geometry.grabOffsetX - geometry.sourceWidth / 2;
}

function sweepReorder(
  geometry: StripDragGeometry,
  xs: ReadonlyArray<number>,
): ReadonlyArray<StripDragState> {
  const states: StripDragState[] = [];
  let previous: StripDragState | null = null;
  for (const pointerX of xs) {
    previous = resolveStripReorderState({
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

describe("header strip reorder model (resolveStripReorderState)", () => {
  describe("never a merge", () => {
    it("stays a reorder even centred exactly on a mergeable neighbour", () => {
      // Same geometry/pointer that make `resolveStripDragState` report a
      // merge - this resolver has no merge arm, so it must settle a plain
      // swap instead.
      const geometry = geometryFor([191, 191, 191], 0, null, "centred");
      const centre = ORIGIN + 191 + 191 / 2;
      const pointerX = pointerForCentre(geometry, centre);
      const dragResult = resolveStripDragState({
        geometry,
        contentOriginX: ORIGIN,
        pointerX,
        previous: null,
      });
      expect(dragResult.kind).toBe("merge");

      const reorderResult = resolveStripReorderState({
        geometry,
        contentOriginX: ORIGIN,
        pointerX,
        previous: null,
      });
      expect(reorderResult.kind).toBe("reorder");
    });

    it("never reports merge across a full sweep, mergeable neighbours included", () => {
      const widths = [120, 300, 200, 260];
      const geometry = geometryFor(widths, 0, null, "centred");
      const total = widths.reduce((sum, w) => sum + w, 0);
      const states = sweepReorder(
        geometry,
        range(ORIGIN - 100, ORIGIN + total + 100, 3),
      );
      for (const state of states) expect(state.kind).toBe("reorder");
    });
  });

  describe("mid-drag displacement, both directions", () => {
    it("never decreases the index under a rightward sweep", () => {
      const geometry = geometryFor([191, 191, 191, 191], 0, null, "centred");
      const indices = sweepReorder(
        geometry,
        range(ORIGIN, ORIGIN + 800, 3),
      ).map((state) => state.targetIndex);
      for (let i = 1; i < indices.length; i += 1) {
        expect(indices[i]).toBeGreaterThanOrEqual(indices[i - 1] ?? 0);
      }
      expect(indices.at(-1)).toBe(3);
    });

    it("never increases the index under a leftward sweep", () => {
      const geometry = geometryFor([191, 191, 191, 191], 3, null, "centred");
      const xs = range(ORIGIN, ORIGIN + 800, 3)
        .slice()
        .reverse();
      const indices = sweepReorder(geometry, xs).map(
        (state) => state.targetIndex,
      );
      for (let i = 1; i < indices.length; i += 1) {
        expect(indices[i]).toBeLessThanOrEqual(indices[i - 1] ?? 0);
      }
      expect(indices.at(-1)).toBe(0);
    });

    it("swaps well before the dragged tab's centre reaches the neighbour, unlike the centre-based resolver", () => {
      // The whole point of the edge-crossing rule: the neighbour starts
      // sliding as soon as the tabs visibly overlap, instead of making the
      // user drag a further half tab-width for `resolveStripDragState`'s
      // centre rule to fire.
      const geometry = geometryFor([200, 200, 200], 0, null, "centred");
      const findFirstSwap = (
        resolve: typeof resolveStripReorderState,
      ): number => {
        let previous: StripDragState | null = null;
        for (let offset = 0; offset < 400; offset += 1) {
          previous = resolve({
            geometry,
            contentOriginX: ORIGIN,
            pointerX: ORIGIN + offset,
            previous,
          });
          if (previous.targetIndex === 1) return offset;
        }
        throw new Error("never swapped");
      };
      const reorderSwapOffset = findFirstSwap(resolveStripReorderState);
      const dragSwapOffset = findFirstSwap(resolveStripDragState);
      expect(reorderSwapOffset).toBeLessThan(dragSwapOffset);
      // 200px tab: the documented 6px-inset rule fires 94px earlier.
      expect(dragSwapOffset - reorderSwapOffset).toBeCloseTo(94, 0);
    });

    it("shows the real per-tab pixel displacement once a swap settles, not just the index", () => {
      const geometry = geometryFor([130, 101, 192], 0, null, "centred");
      // Small range: stays inside the first boundary only, so the sweep
      // settles at exactly one swap.
      const settled = sweepReorder(geometry, range(ORIGIN, ORIGIN + 250, 3));
      const last = settled.at(-1);
      expect(last?.targetIndex).toBe(1);
      const offsets = stripOffsetsFor(geometry, last?.targetIndex ?? 0);
      expect(offsets.get("item-0")).toBe(101);
      expect(offsets.get("item-1")).toBe(-130);
      expect(offsets.get("item-2")).toBe(0);
    });
  });

  describe("reversal hysteresis is a small fixed band, not the full tab width", () => {
    it("holds roughly a 12px band on a wide tab, independent of its exact width", () => {
      for (const sourceWidth of [120, 191, 382]) {
        const geometry = geometryFor(
          [sourceWidth, 300, 200],
          0,
          null,
          "centred",
        );
        const forward = range(0, 900, 1).map((offset) => ({
          x: ORIGIN + offset,
          index: resolveStripReorderState({
            geometry,
            contentOriginX: ORIGIN,
            pointerX: ORIGIN + offset,
            previous: null,
          }).targetIndex,
        }));
        const swapForward = forward.find((entry) => entry.index === 1);
        expect(swapForward).toBeDefined();

        let previous: StripDragState | null = {
          kind: "reorder",
          targetIndex: 1,
        };
        let swapBackX: number | null = null;
        for (let x = swapForward?.x ?? 0; x > ORIGIN - 400; x -= 1) {
          const next = resolveStripReorderState({
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
        // A one-pixel sweep can cross each strict boundary by one extra pixel.
        expect(measured).toBeGreaterThanOrEqual(12);
        expect(measured).toBeLessThanOrEqual(14);
        // Contrast with the full-width band `resolveStripDragState` carries.
        expect(measured).toBeLessThan(swapHysteresisPx(sourceWidth));
      }
    });

    it("degrades to the full tab width - the same band `resolveStripDragState` uses - once the tab is under 12px", () => {
      const sourceWidth = 8;
      const geometry = geometryFor([sourceWidth, 300, 200], 0, null, "centred");
      const forward = range(0, 900, 1).map((offset) => ({
        x: ORIGIN + offset,
        index: resolveStripReorderState({
          geometry,
          contentOriginX: ORIGIN,
          pointerX: ORIGIN + offset,
          previous: null,
        }).targetIndex,
      }));
      const swapForward = forward.find((entry) => entry.index === 1);
      expect(swapForward).toBeDefined();

      let previous: StripDragState | null = { kind: "reorder", targetIndex: 1 };
      let swapBackX: number | null = null;
      for (let x = swapForward?.x ?? 0; x > ORIGIN - 400; x -= 1) {
        const next = resolveStripReorderState({
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
      const derived = swapHysteresisPx(sourceWidth);
      expect(measured).toBeGreaterThanOrEqual(derived);
      expect(measured).toBeLessThanOrEqual(derived + 2);
    });

    it("does not reverse a fresh swap while jittering back within the band", () => {
      const geometry = geometryFor([200, 200], 0, null, "centred");
      const forward = resolveStripReorderState({
        geometry,
        contentOriginX: ORIGIN,
        pointerX: pointerForCentre(geometry, ORIGIN + 260),
        previous: null,
      });
      expect(forward.targetIndex).toBe(1);

      // A small jitter back toward (but not past) the reversal threshold must
      // hold the swapped state.
      const smallJitterBack = resolveStripReorderState({
        geometry,
        contentOriginX: ORIGIN,
        pointerX: pointerForCentre(geometry, ORIGIN + 255),
        previous: forward,
      });
      expect(smallJitterBack.targetIndex).toBe(1);

      // Continuing well past the band does reverse it.
      const pastBand = resolveStripReorderState({
        geometry,
        contentOriginX: ORIGIN,
        pointerX: pointerForCentre(geometry, ORIGIN + 100),
        previous: smallJitterBack,
      });
      expect(pastBand.targetIndex).toBe(0);
    });
  });

  describe("fast sweeps settle one boundary at a time", () => {
    it("moves at most one boundary per sample even on a fast sweep", () => {
      const geometry = geometryFor([191, 191, 191, 191], 0, null, "centred");
      const indices = sweepReorder(
        geometry,
        range(ORIGIN, ORIGIN + 800, 3),
      ).map((state) => state.targetIndex);
      for (let i = 1; i < indices.length; i += 1) {
        expect(
          Math.abs((indices[i] ?? 0) - (indices[i - 1] ?? 0)),
        ).toBeLessThanOrEqual(1);
      }
    });

    it("settles a multi-tab jump deterministically in one resolution", () => {
      const geometry = geometryFor([191, 191, 191, 191], 0, null, "centred");
      const jumped = resolveStripReorderState({
        geometry,
        contentOriginX: ORIGIN,
        pointerX: ORIGIN + 700,
        previous: { kind: "reorder", targetIndex: 0 },
      });
      expect(jumped.targetIndex).toBe(3);
    });
  });

  describe("grab offset does not move the reorder threshold", () => {
    it("produces the identical reorder sequence across a swept CENTRE trajectory regardless of where the tab was grabbed", () => {
      // The reported header-strip regression this guards against: zones must
      // follow the dragged tab's CENTRE, never the raw pointer, so grabbing a
      // tab by an edge instead of its middle cannot shift when neighbours
      // start sliding. A raw pointerX sweep would NOT be comparable across
      // geometries - a different grab offset shifts pointerX relative to the
      // centre by design - so both sweeps are driven from the same sequence
      // of centre positions, each converted to that geometry's own pointerX.
      const widths = [100, 100, 100];
      const centreGrab = geometryFor(widths, 1, null, "centred");
      const edgeGrab: StripDragGeometry = { ...centreGrab, grabOffsetX: 95 };
      const centres = range(ORIGIN - 100, ORIGIN + 300, 2);
      const sweepByCentre = (
        geometry: StripDragGeometry,
      ): ReadonlyArray<number> => {
        const indices: number[] = [];
        let previous: StripDragState | null = null;
        for (const centre of centres) {
          previous = resolveStripReorderState({
            geometry,
            contentOriginX: ORIGIN,
            pointerX: pointerForCentre(geometry, centre),
            previous,
          });
          indices.push(previous.targetIndex);
        }
        return indices;
      };
      const centreIndices = sweepByCentre(centreGrab);
      const edgeIndices = sweepByCentre(edgeGrab);
      expect(edgeIndices).toEqual(centreIndices);
      // Sanity: the shared sweep actually crosses both boundaries.
      expect(new Set(centreIndices)).toEqual(new Set([0, 1, 2]));
    });
  });

  describe("unequal widths never alternate", () => {
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
          const geometry = geometryFor(widths, source, null, "centred");
          const total = widths.reduce((sum, width) => sum + width, 0);
          const indices = sweepReorder(
            geometry,
            range(ORIGIN - 200, ORIGIN + total + 200, 2),
          ).map((state) => state.targetIndex);
          for (let i = 2; i < indices.length; i += 1) {
            const alternating =
              indices[i] === indices[i - 2] && indices[i] !== indices[i - 1];
            expect(alternating).toBe(false);
          }
        });
      }
    }

    it("holds under a randomised sequence of geometries", () => {
      let seed = 20260908;
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
        const geometry = geometryFor(widths, source, null, "centred");
        const total = widths.reduce((sum, width) => sum + width, 0);
        const indices = sweepReorder(
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

  describe("a split group reorders like any other slot", () => {
    it("is unaffected by isMergeTarget: the swap threshold ignores merge eligibility", () => {
      // A split group carries `isMergeTarget: false` because it has no
      // unambiguous single ref to merge into - but the reorder gesture never
      // considers merge eligibility, so its slot must cross exactly like an
      // ordinary tab of the same width.
      const mergeableGeometry = geometryFor(
        [191, 382, 191],
        0,
        [true, true, true],
        "centred",
      );
      const splitGeometry = geometryFor(
        [191, 382, 191],
        0,
        [true, false, true],
        "centred",
      );
      const total = 191 + 382 + 191;
      const xs = range(ORIGIN - 100, ORIGIN + total + 100, 3);
      const mergeableIndices = sweepReorder(mergeableGeometry, xs).map(
        (state) => state.targetIndex,
      );
      const splitIndices = sweepReorder(splitGeometry, xs).map(
        (state) => state.targetIndex,
      );
      expect(splitIndices).toEqual(mergeableIndices);
    });

    it("reorders straight past a split group without ever reporting merge", () => {
      const geometry = geometryFor(
        [191, 382, 191],
        0,
        [true, false, true],
        "centred",
      );
      const splitCentre = ORIGIN + 191 + 382 / 2;
      const pointerX = pointerForCentre(geometry, splitCentre);
      const state = resolveStripReorderState({
        geometry,
        contentOriginX: ORIGIN,
        pointerX,
        previous: null,
      });
      expect(state.kind).toBe("reorder");
      expect(state.targetIndex).toBe(1);
    });
  });
});
