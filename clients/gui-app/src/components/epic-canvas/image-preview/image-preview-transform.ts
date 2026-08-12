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

export interface ContainerSize {
  readonly width: number;
  readonly height: number;
}

/** The workspace tile's animation duration - named so it isn't a magic-number duplicate at the call site. */
export const DEFAULT_ANIMATION_MS = 200;
export const MIN_SCALE = 0.25;
export const MAX_SCALE = 8;
export const ZOOM_STEP = 0.2;
export const ZOOM_BOUNDARY_EPSILON = 0.001;
export const ACTUAL_SIZE_EPSILON = 0.001;
/** Mermaid `pan-zoom-svg-viewer.tsx`'s `FIT_PADDING_PX` convention - a fit transform never sits flush against the pane edge/header. */
const FIT_PADDING_PX = 32;

/**
 * Fit-to-container scale from a measured size vs an image's own natural
 * pixels, inset by `FIT_PADDING_PX` on every side - clamped to the
 * library's own min/max so `centerView(scale)` never receives an
 * out-of-range value. Used by `ImageDiffView` to compute the SAME fit
 * independently for each of its two linked sides (ticket 07) rather than
 * forcing one side's shared number onto a differently-sized peer.
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
  return Math.min(Math.max(raw, MIN_SCALE), MAX_SCALE);
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
