import type { ReactZoomPanPinchRef } from "react-zoom-pan-pinch";

/**
 * Zooms `instance` to `scale`, held to the view's own smallest and largest
 * scale, about the middle of its wrapper: the anchor its own zoom-in and
 * zoom-out steps use, so a typed zoom level keeps the reader looking at the
 * same place. `setTransform` applies no limits of its own.
 */
export function zoomInstanceTo(
  instance: ReactZoomPanPinchRef,
  scale: number,
  animationMs: number,
): void {
  const wrapper = instance.instance.wrapperComponent;
  if (wrapper === null) return;
  const { setup, state } = instance.instance;
  const target = Math.min(Math.max(scale, setup.minScale), setup.maxScale);
  const ratio = target / state.scale;
  const centreX = wrapper.clientWidth / 2;
  const centreY = wrapper.clientHeight / 2;
  instance.setTransform(
    centreX - (centreX - state.positionX) * ratio,
    centreY - (centreY - state.positionY) * ratio,
    target,
    animationMs,
  );
}
