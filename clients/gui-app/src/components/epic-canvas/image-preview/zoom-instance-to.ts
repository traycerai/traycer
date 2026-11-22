import type { ReactZoomPanPinchRef } from "react-zoom-pan-pinch";

/** Apply an absolute scale through the same bounded, centre-anchored API as +/-.
 * Smooth viewers use multiplicative steps; other viewers use additive steps.
 */
export function zoomInstanceTo(
  instance: ReactZoomPanPinchRef,
  scale: number,
  animationMs: number,
): void {
  if (instance.instance.wrapperComponent === null) return;
  const { setup, state } = instance.instance;
  const target = Math.min(Math.max(scale, setup.minScale), setup.maxScale);
  const step = setup.smooth
    ? Math.log(target / state.scale)
    : target - state.scale;
  if (step >= 0) instance.zoomIn(step, animationMs);
  else instance.zoomOut(-step, animationMs);
}
