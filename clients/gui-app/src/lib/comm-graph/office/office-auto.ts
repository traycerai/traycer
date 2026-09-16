/**
 * AUTO: which view an office opens on when nobody has picked one.
 *
 * The question Auto answers is not "which view is nicest" but "how much of
 * this epic fits in THIS tile" - a floor plan that needs 0.06x to fit is a
 * grey smear, whatever else is true of it. So the answer is arithmetic: take
 * each candidate's packed size, divide the tile by it, and take the first that
 * still reaches office detail.
 *
 * TWO MEASUREMENTS, NOT TWO PLANS. `view.measure` is the packing arithmetic
 * with no walkability pass, no spots and no flood fills, and nothing it
 * produces is retained - the winner is planned once, by the scene, afterwards.
 *
 * Called from the TILE, not from the canvas: a mode toggle or an LRU remount
 * re-creates the canvas, and a decision that lived there would be re-taken
 * every time, which is how a floor silently becomes a different floor.
 */
import { OFFICE_LOD_OFFICE_ZOOM } from "@/lib/comm-graph/office/office-lod";
import {
  OFFICE_VIEWS,
  type OfficePlanInput,
} from "@/lib/comm-graph/office/views/office-view";
import type {
  OfficeSize,
  OfficeViewId,
} from "@/lib/comm-graph/office/office-types";

/**
 * Everything a decision needs, gathered by the canvas and handed to the tile.
 *
 * The canvas is the only thing that knows BOTH of these: it already derives
 * the population for its own scene, and it is the only element that knows how
 * much room the office has once the directory and any open panel have taken
 * theirs. The tile decides; it does not re-derive.
 */
export interface OfficeAutoProbe {
  readonly input: OfficePlanInput;
  /** The canvas box in CSS pixels, net of the directory and the panels. */
  readonly canvas: OfficeSize;
}

/** One candidate, and the zoom its whole plan would fit the tile at. */
export interface OfficeAutoFit {
  readonly view: OfficeViewId;
  /** Screen pixels per sprite pixel; `0` where the tile has not been measured. */
  readonly zoom: number;
}

export interface OfficeAutoDecision {
  readonly view: OfficeViewId;
  /** Every candidate measured, in the order they were tried. */
  readonly fits: ReadonlyArray<OfficeAutoFit>;
  /** How big the epic was when this was decided - what the chip reports. */
  readonly agents: number;
}

/**
 * The views Auto CONSIDERS, densest-drawn first.
 *
 * Deliberately not every registered view. Auto is choosing how much detail
 * this epic can afford, and these two are the steps of that ladder: the Floor
 * draws every desk on one storey, Towers draws every desk stacked. Mission
 * control, Campus and City are different READINGS of the same office rather
 * than points on that ladder, so they are things a person picks, not things
 * measurement can pick for them.
 */
const AUTO_CANDIDATES: ReadonlyArray<OfficeViewId> = ["floor", "towers"];

/**
 * Where Auto lands when neither candidate reaches office detail: the view
 * that answers "too many agents to draw every desk" by not drawing them all.
 */
const AUTO_FALLBACK: OfficeViewId = "building";

/**
 * The zoom at which `size` fits inside `canvas`, measured against the SAME
 * padded viewport the camera fits the chosen plan into.
 *
 * `fitCamera` leaves `fitPadding` px of margin on every side, so a view opens
 * at `(canvas - 2·fitPadding) / size`, not `canvas / size`. The LOD the frame
 * renders is decided by that opened zoom, so Auto has to ask its office-detail
 * question at it: measured unpadded, a candidate whose bare fit clears
 * `OFFICE_LOD_OFFICE_ZOOM` by a hair is selected, then opens just below the
 * threshold and draws the overview block map and pips - the very detail Auto
 * claimed would fit. The other clamps `fitCamera` applies (`MAX_FIT_ZOOM`,
 * `clampZoom`) sit far from that threshold and cannot change the decision, so
 * matching the padding is all it takes to reconcile the two.
 */
function fitZoom(
  size: OfficeSize,
  canvas: OfficeSize,
  fitPadding: number,
): number {
  if (size.width <= 0 || size.height <= 0) return 0;
  const availableWidth = canvas.width - fitPadding * 2;
  const availableHeight = canvas.height - fitPadding * 2;
  if (availableWidth <= 0 || availableHeight <= 0) return 0;
  return Math.min(availableWidth / size.width, availableHeight / size.height);
}

/**
 * `canvas` is the tile's canvas box in CSS pixels, measured AFTER the
 * directory and any detail panel have taken their width - the space the office
 * actually gets, not the space the tile has. `fitPadding` is the camera's fit
 * margin (`FIT_PADDING`), so each candidate is measured at the zoom it will
 * actually open at - see {@link fitZoom}.
 */
export function decideOfficeView(
  input: OfficePlanInput,
  canvas: OfficeSize,
  fitPadding: number,
): OfficeAutoDecision {
  const fits = AUTO_CANDIDATES.map((view) => ({
    view,
    zoom: fitZoom(OFFICE_VIEWS[view].measure(input), canvas, fitPadding),
  }));
  const winner = fits.find((fit) => fit.zoom >= OFFICE_LOD_OFFICE_ZOOM);
  return {
    view: winner?.view ?? AUTO_FALLBACK,
    fits,
    agents: input.agents.length,
  };
}

/**
 * A measured zoom as the chrome says it. Two decimals, because the numbers
 * that matter here (0.06x, 0.43x) are all below one and a rounded "0x" says
 * nothing.
 */
export function officeZoomLabel(zoom: number): string {
  return `${zoom.toFixed(2)}×`;
}
