import type { ReactZoomPanPinchRef } from "react-zoom-pan-pinch";
import { fitScaleFor } from "./image-preview-transform";

/**
 * Fits `instance`'s own content to its own wrapper - a caller that drives an
 * `ImagePreview` from outside (the image diff's linked sides, the chat
 * lightbox's floating cluster) has no natural size of its own to fit from,
 * so it reads the live content and wrapper boxes instead. Never a shared
 * number forced onto a differently-sized peer (ticket 07).
 */
export function fitInstance(
  instance: ReactZoomPanPinchRef,
  animationMs: number,
): void {
  const wrapper = instance.instance.wrapperComponent;
  const content = instance.instance.contentComponent;
  if (wrapper === null || content === null) return;
  const wrapperRect = wrapper.getBoundingClientRect();
  instance.centerView(
    fitScaleFor(
      { width: wrapperRect.width, height: wrapperRect.height },
      { width: content.offsetWidth, height: content.offsetHeight },
    ),
    animationMs,
  );
}
