export const WINDOWS_TITLE_BAR_OVERLAY_BASE_HEIGHT = 36;

export function windowsTitleBarOverlayHeight(zoomFactor: number): number {
  const safeZoomFactor =
    Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;
  return Math.max(
    1,
    Math.round(WINDOWS_TITLE_BAR_OVERLAY_BASE_HEIGHT * safeZoomFactor),
  );
}
