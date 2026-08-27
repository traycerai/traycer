import { describe, expect, it } from "vitest";
import {
  MIN_PANE_DIMENSION_PX,
  PANE_CENTRE_BOX_MAX_PX,
  PANE_EDGE_BAND_MAX_PX,
  paneCentreBoxPx,
  paneCorridorCommits,
  paneEdgeBandPx,
  resolvePaneCorridorPosition,
  type PaneCorridorPosition,
} from "@/components/epic-canvas/dnd/pane-corridor-geometry";

const at = (
  width: number,
  height: number,
  x: number,
  y: number,
): PaneCorridorPosition => resolvePaneCorridorPosition({ width, height, x, y });

describe("pane corridor geometry", () => {
  describe("target sizing is absolute with a proportional floor", () => {
    it("is proportional at and below the pane floor", () => {
      // The clamp must be INACTIVE at 239 so the narrowest pane behaves exactly
      // as the pure-ratio proposal did - nothing regresses there.
      expect(paneEdgeBandPx(MIN_PANE_DIMENSION_PX)).toBeCloseTo(35.85, 2);
      expect(paneCentreBoxPx(MIN_PANE_DIMENSION_PX)).toBeCloseTo(66.92, 2);
      expect(paneEdgeBandPx(MIN_PANE_DIMENSION_PX)).toBeLessThan(
        PANE_EDGE_BAND_MAX_PX,
      );
    });

    it("pins targets once the pane is wide enough", () => {
      for (const dim of [320, 495, 714, 1200, 4000]) {
        expect(paneEdgeBandPx(dim)).toBe(PANE_EDGE_BAND_MAX_PX);
      }
      for (const dim of [500, 714, 1200, 4000]) {
        expect(paneCentreBoxPx(dim)).toBe(PANE_CENTRE_BOX_MAX_PX);
      }
    });

    it("demands the same precision regardless of pane size or aspect", () => {
      // The defect pure ratios had: the same gesture 3x harder on a narrow pane,
      // and "split left" 3x harder than "split top" inside ONE pane.
      const wide = paneEdgeBandPx(714);
      const tall = paneEdgeBandPx(689);
      expect(wide).toBe(tall);
      expect(paneEdgeBandPx(1200)).toBe(wide);
    });

    it("always leaves a traversable corridor, floor included", () => {
      for (const dim of [MIN_PANE_DIMENSION_PX, 280, 320, 495, 714, 1200]) {
        const corridorPerSide =
          (dim - 2 * paneEdgeBandPx(dim) - paneCentreBoxPx(dim)) / 2;
        expect(corridorPerSide).toBeGreaterThan(40);
      }
    });
  });

  describe("the corridor is inert", () => {
    it("resolves the former nearest-edge fallback region to corridor", () => {
      // Midway between the edge band and the centre box on a wide pane: under
      // the old rule this fell back to the nearest edge and committed a SPLIT.
      const w = 714;
      const h = 689;
      const x = paneEdgeBandPx(w) + 40;
      expect(at(w, h, x, h / 2)).toBe("corridor");
      expect(paneCorridorCommits("corridor")).toBe(false);
    });

    it("commits nothing anywhere in the corridor, at any pane size", () => {
      for (const [w, h] of [
        [MIN_PANE_DIMENSION_PX, MIN_PANE_DIMENSION_PX],
        [714, 689],
        [495, 400],
      ]) {
        const band = paneEdgeBandPx(w);
        const centre = paneCentreBoxPx(w);
        const probe = band + (w / 2 - centre / 2 - band) / 2;
        expect(at(w, h, probe, h / 2)).toBe("corridor");
      }
    });
  });

  describe("targets remain reachable", () => {
    it("resolves each edge band to its own split", () => {
      const w = 714;
      const h = 689;
      expect(at(w, h, 4, h / 2)).toBe("left");
      expect(at(w, h, w - 4, h / 2)).toBe("right");
      expect(at(w, h, w / 2, 4)).toBe("top");
      expect(at(w, h, w / 2, h - 4)).toBe("bottom");
    });

    it("resolves the centre box to move-into-pane", () => {
      expect(at(714, 689, 357, 344)).toBe("center");
    });

    it("keeps every target reachable at the pane floor", () => {
      const d = MIN_PANE_DIMENSION_PX;
      expect(at(d, d, 2, d / 2)).toBe("left");
      expect(at(d, d, d - 2, d / 2)).toBe("right");
      expect(at(d, d, d / 2, 2)).toBe("top");
      expect(at(d, d, d / 2, d - 2)).toBe("bottom");
      expect(at(d, d, d / 2, d / 2)).toBe("center");
    });
  });

  describe("corner rule", () => {
    it("resolves every corner to exactly one outcome", () => {
      const d = MIN_PANE_DIMENSION_PX;
      // At the floor the four corners are ~9% of the pane, so this is worst
      // exactly where area is scarcest.
      for (const [x, y] of [
        [3, 3],
        [d - 3, 3],
        [3, d - 3],
        [d - 3, d - 3],
      ]) {
        const result = at(d, d, x, y);
        expect(["left", "right", "top", "bottom"]).toContain(result);
      }
    });

    it("gives the corner to the more deeply penetrated edge", () => {
      const d = 714;
      const band = paneEdgeBandPx(d);
      // Much deeper into the top band than the left band.
      expect(at(d, d, band - 2, 2)).toBe("top");
      // And the mirror case.
      expect(at(d, d, 2, band - 2)).toBe("left");
    });

    it("resolves an exact tie horizontally, deterministically", () => {
      const d = 714;
      // Equal distance from left and top edges on a square pane => equal
      // fractional penetration; lockstep needs one answer, not branch order.
      expect(at(d, d, 5, 5)).toBe("left");
      expect(at(d, d, d - 5, 5)).toBe("right");
    });

    it("compares penetration as a FRACTION so aspect ratio cannot skew it", () => {
      // A pane where the horizontal band is clamped and the vertical is not:
      // raw pixel distance would pick the wrong edge, fractions do not.
      const w = 1200;
      const h = 260;
      const hb = paneEdgeBandPx(w);
      const vb = paneEdgeBandPx(h);
      expect(hb).not.toBeCloseTo(vb, 1);
      // 90% into the vertical band, 10% into the horizontal one.
      const x = hb * 0.9;
      const y = vb * 0.1;
      expect(at(w, h, x, y)).toBe("top");
    });
  });

  describe("degenerate input", () => {
    it("treats a zero-size pane as corridor rather than guessing", () => {
      expect(at(0, 0, 0, 0)).toBe("corridor");
      expect(at(714, 0, 100, 0)).toBe("corridor");
    });
  });
});
