import {
  rectsIntersect,
  type TileRect,
} from "@/lib/browser-view/tiles/tile-rect-registry";

export type ToasterAnchor =
  | "top-left"
  | "top-center"
  | "top-right"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right";

export interface ToasterSize {
  readonly width: number;
  readonly height: number;
}

/** Reusing it keeps each anchor's prospective rect aligned with where sonner actually paints the toaster,
 * without hardcoding the toaster's own size. */
export const TOASTER_EDGE_OFFSET_PX = 24;

export const DEFAULT_TOASTER_ANCHOR: ToasterAnchor = "bottom-right";

// The app default must stay first: `pickToasterAnchor` checks it before
// walking the rest, and only falls through when it overlaps a tile.
const TOASTER_ANCHOR_PREFERENCE_ORDER: readonly ToasterAnchor[] = [
  DEFAULT_TOASTER_ANCHOR,
  "bottom-center",
  "bottom-left",
  "top-right",
  "top-center",
  "top-left",
];

const ANCHOR_X: Record<ToasterAnchor, "left" | "center" | "right"> = {
  "top-left": "left",
  "top-center": "center",
  "top-right": "right",
  "bottom-left": "left",
  "bottom-center": "center",
  "bottom-right": "right",
};

const ANCHOR_Y: Record<ToasterAnchor, "top" | "bottom"> = {
  "top-left": "top",
  "top-center": "top",
  "top-right": "top",
  "bottom-left": "bottom",
  "bottom-center": "bottom",
  "bottom-right": "bottom",
};

/** Starts from the app default and only moves off it when the default's prospective rect (at `toasterSize`, the
 * toaster's own last-measured rect) overlaps a tile. */
export function pickToasterAnchor(input: {
  readonly toasterSize: ToasterSize | null;
  readonly viewport: ToasterSize;
  readonly tileRects: readonly TileRect[];
}): ToasterAnchor {
  const { toasterSize, viewport, tileRects } = input;
  if (toasterSize === null || tileRects.length === 0) {
    return DEFAULT_TOASTER_ANCHOR;
  }
  const overlapsAnyTile = (anchor: ToasterAnchor): boolean => {
    const rect = rectForAnchor(anchor, toasterSize, viewport);
    return tileRects.some((tile) => rectsIntersect(rect, tile));
  };
  const nonOverlapping = TOASTER_ANCHOR_PREFERENCE_ORDER.find(
    (anchor) => !overlapsAnyTile(anchor),
  );
  return nonOverlapping ?? DEFAULT_TOASTER_ANCHOR;
}

function rectForAnchor(
  anchor: ToasterAnchor,
  size: ToasterSize,
  viewport: ToasterSize,
): TileRect {
  const left = xLeftFor(ANCHOR_X[anchor], size.width, viewport.width);
  const top = yTopFor(ANCHOR_Y[anchor], size.height, viewport.height);
  return {
    left,
    top,
    right: left + size.width,
    bottom: top + size.height,
    width: size.width,
    height: size.height,
  };
}

function xLeftFor(
  xPosition: "left" | "center" | "right",
  width: number,
  viewportWidth: number,
): number {
  if (xPosition === "left") return TOASTER_EDGE_OFFSET_PX;
  if (xPosition === "right")
    return viewportWidth - TOASTER_EDGE_OFFSET_PX - width;
  return (viewportWidth - width) / 2;
}

function yTopFor(
  yPosition: "top" | "bottom",
  height: number,
  viewportHeight: number,
): number {
  if (yPosition === "top") return TOASTER_EDGE_OFFSET_PX;
  return viewportHeight - TOASTER_EDGE_OFFSET_PX - height;
}
