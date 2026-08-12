/**
 * Pure pan/zoom transform math shared between `ImagePreview` and
 * `ImageDiffView` (ticket 07) - kept out of `image-preview.tsx` so that
 * file stays component-only (Fast Refresh only works when a file exports
 * ONLY components).
 */

/** Scale/position tuple a `TransformWrapper` reports on every change - the sync unit `ImageDiffView` mirrors onto a linked peer. */
export interface ImagePreviewTransformState {
  readonly positionX: number;
  readonly positionY: number;
  readonly scale: number;
}

/**
 * Why a transform changed (review finding #3): `"gesture"` is a genuine
 * user pan/pinch/wheel, reported by the library's own event handlers.
 * `"programmatic"` is a transform `ImagePreview` issued itself - Fit,
 * Actual-size, zoom in/out, or its own autonomous resize-refit. A caller
 * linking multiple instances must only mirror `"gesture"` transforms onto a
 * peer (a programmatic one recomputes its OWN fit independently) and must
 * not read a programmatic transform as "the user manually zoomed away".
 */
export type TransformOrigin = "gesture" | "programmatic";

/**
 * Everything a caller linking multiple `ImagePreview` instances needs from
 * one `onTransform` firing (round-2 review, findings #3/#4): the raw
 * `state` to mirror, its `origin`, the CHILD's OWN derived fit/actual-size
 * mode (so a caller never re-derives or manually toggles it), and the
 * child's live interactive floor (so a caller's shared zoom-boundary UI
 * never has to guess). Fired once at mount (`onInit` - RZPP applies its
 * initial transform without calling `onTransform`) and on every subsequent
 * `onTransform`. No `maxScale` field: every `TransformWrapper` is configured
 * with the same constant `MAX_SCALE` (only `minScale` varies per instance,
 * from that instance's own image dimensions), so a ceiling check compares
 * against `MAX_SCALE` directly rather than threading an always-identical
 * value through every report.
 */
export interface ImagePreviewTransformReport {
  readonly state: ImagePreviewTransformState;
  readonly origin: TransformOrigin;
  readonly isFitted: boolean;
  readonly isActualSize: boolean;
  readonly minScale: number;
}

export interface ContainerSize {
  readonly width: number;
  readonly height: number;
}

/** The workspace tile's animation duration - named so it isn't a magic-number duplicate at the call site. */
export const DEFAULT_ANIMATION_MS = 200;
/** Interactive zoom floor for images that already fit at or above this scale - NOT a floor on the fit scale itself (review finding #7: a huge image's fit can and must go below this). */
export const MIN_SCALE = 0.25;
export const MAX_SCALE = 8;
export const ZOOM_STEP = 0.2;
/** Float-comparison tolerance for scale (0-1 ratio) checks - zoom-boundary and actual-size derivations both used the same value under separate names. */
export const SCALE_EPSILON = 0.001;
/** Pixel tolerance for "is this position the fit position" (review finding #2/#3's mode derivation) - looser than a scale epsilon since position is in raw px, not a 0-1 ratio. */
const FIT_POSITION_EPSILON_PX = 1;
/** Mermaid `pan-zoom-svg-viewer.tsx`'s `FIT_PADDING_PX` convention - a fit transform never sits flush against the pane edge/header. */
const FIT_PADDING_PX = 32;
/** Floor so a degenerate (near-zero) container/natural size never produces a zero or negative scale - not a UX floor, just NaN/Infinity avoidance. */
const MIN_SAFE_SCALE = 1e-3;

/**
 * Fit-to-container scale from a measured size vs an image's own natural
 * pixels, inset by `FIT_PADDING_PX` on every side - clamped only against
 * `MAX_SCALE` and a degenerate-input floor, NEVER against the interactive
 * `MIN_SCALE` (review finding #7): a huge image in a small pane must fit at
 * whatever scale that actually takes, even below the normal zoom-out floor.
 * `centerView`/`setTransform` bypass the library's own `minScale`/`maxScale`
 * setup entirely (verified against installed v4.0.4's `setState`), so this
 * clamp is the only one that applies to a caller-supplied fit scale. Used by
 * `ImageDiffView` to compute the SAME fit independently for each of its two
 * linked sides (ticket 07) rather than forcing one side's shared number onto
 * a differently-sized peer.
 */
export function fitScaleFor(
  container: ContainerSize,
  natural: ContainerSize,
): number {
  if (natural.width <= 0 || natural.height <= 0) return 1;
  const availableWidth = Math.max(container.width - FIT_PADDING_PX * 2, 1);
  const availableHeight = Math.max(container.height - FIT_PADDING_PX * 2, 1);
  const raw = Math.min(
    availableWidth / natural.width,
    availableHeight / natural.height,
  );
  return Math.min(Math.max(raw, MIN_SAFE_SCALE), MAX_SCALE);
}

/**
 * The wrapper's effective interactive-zoom floor (review finding #7): no
 * greater than the current fit scale, so a huge image's "Fit to screen"
 * value is always reachable by zooming out, and Zoom Out only disables once
 * the user is actually AT that fit (or the constant floor, whichever is
 * smaller/looser) - never before.
 */
export function effectiveMinScale(fitScale: number): number {
  return Math.min(MIN_SCALE, fitScale);
}

/** Pre-mount initial transform only - every subsequent Fit reads the live DOM instead (mirrors `pan-zoom-svg-viewer.tsx`'s `fitTransformFor`). */
export function initialFitTransform(
  container: ContainerSize,
  natural: ContainerSize,
): ImagePreviewTransformState {
  const scale = fitScaleFor(container, natural);
  return {
    scale,
    positionX: (container.width - natural.width * scale) / 2,
    positionY: (container.height - natural.height * scale) / 2,
  };
}

/**
 * Whether `transform` IS the fit transform right now (review finding #2: the
 * single source of truth for "is this image currently fitted", replacing a
 * manually-toggled flag that gesture handlers could leave stuck). Compares
 * scale AND position - a pure pan away from an unchanged fit SCALE is still
 * "actual pan activity" that must read as no-longer-fitted.
 */
export function transformMatchesFit(
  transform: ImagePreviewTransformState,
  fit: ImagePreviewTransformState,
): boolean {
  return (
    Math.abs(transform.scale - fit.scale) < SCALE_EPSILON &&
    Math.abs(transform.positionX - fit.positionX) < FIT_POSITION_EPSILON_PX &&
    Math.abs(transform.positionY - fit.positionY) < FIT_POSITION_EPSILON_PX
  );
}

/** Round-2 review finding #5: the endpoints themselves paint zero visible pixels (content only touching the wrapper edge), so the clamp must stay strictly inside them by at least this much. */
const MIN_VISIBLE_OVERLAP_PX = 1;

/**
 * Clamps a mirrored position so the (differently-sized) peer's content can
 * never end up wholly (or effectively) offscreen (review finding #5) - the
 * loosest bound that guarantees at least `MIN_VISIBLE_OVERLAP_PX` of
 * overlap between the scaled content rect and the wrapper rect on one
 * axis, nothing tighter. Deliberately NOT a reimplementation of the
 * library's own padding-aware bounds engine (ticket 07: "do not over-
 * engineer sub-pixel alignment for mismatched dimensions") - a same-
 * dimension mirror (the common case) is already exact and never gets
 * anywhere near this range; only a genuine mismatch can.
 */
export function clampPositionToVisibleBounds(
  position: number,
  wrapperSize: number,
  scaledContentSize: number,
): number {
  const min = MIN_VISIBLE_OVERLAP_PX - scaledContentSize;
  const max = wrapperSize - MIN_VISIBLE_OVERLAP_PX;
  return Math.min(Math.max(position, min), max);
}
