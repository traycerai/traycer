export const WINDOWS_TITLE_BAR_OVERLAY_BASE_HEIGHT = 36;

/**
 * Electron page zoom scales renderer CSS pixels but not the native Window
 * Controls Overlay. Scale its configured height explicitly so the caption
 * controls continue to match the title-bar content at every zoom step.
 */
export function windowsTitleBarOverlayHeight(zoomFactor: number): number {
  const safeZoomFactor =
    Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;
  return Math.max(
    1,
    Math.round(WINDOWS_TITLE_BAR_OVERLAY_BASE_HEIGHT * safeZoomFactor),
  );
}
