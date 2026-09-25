import { useCallback, useRef, useState, type ReactNode } from "react";
import type { ReactZoomPanPinchRef } from "react-zoom-pan-pinch";
import { fitInstance } from "@/components/epic-canvas/image-preview/fit-instance";
import { ImagePreview } from "@/components/epic-canvas/image-preview/image-preview";
import {
  DEFAULT_ANIMATION_MS,
  MAX_SCALE,
  SCALE_EPSILON,
  ZOOM_STEP,
  type ImagePreviewTransformReport,
} from "@/components/epic-canvas/image-preview/image-preview-transform";
import { ZoomControls } from "@/components/epic-canvas/zoom-controls/zoom-controls";

/**
 * The body every expanded chat image shares - the message lightbox and the
 * composer's expanded attachment. It is the workspace tile's image stage
 * (pan, pinch, wheel, double-tap between fit and actual size) in a dialog,
 * with the shared zoom cluster floating at the bottom right beside the
 * image's own actions, where a thumb reaches.
 *
 * The stage takes a fixed viewport-capped height rather than hugging the
 * image, as the SVG lightbox already does: a zoomable image needs room to
 * be zoomed into, and a stage that grew with the image would jump as the
 * fit changed.
 */
export function ZoomableImageDialogBody(props: {
  readonly src: string;
  readonly alt: string;
  /** The image's copy / share / download bar, rendered beside the zoom cluster. */
  readonly actions: ReactNode;
}): ReactNode {
  const transformRef = useRef<ReactZoomPanPinchRef | null>(null);
  // The stage reports every transform, gesture or button, so the cluster's
  // readout and pressed states are read from it and never kept separately.
  const [report, setReport] = useState<ImagePreviewTransformReport | null>(
    null,
  );
  const handleTransformChange = useCallback(
    (next: ImagePreviewTransformReport): void => {
      setReport(next);
    },
    [],
  );

  function handleFit(): void {
    const instance = transformRef.current;
    if (instance !== null) fitInstance(instance, DEFAULT_ANIMATION_MS);
  }

  return (
    <div className="relative h-[min(88vh,52rem)] w-full overflow-hidden rounded-lg">
      <ImagePreview
        status="ready"
        url={props.src}
        // No asset header for a chat image: the stage fits from the decoded
        // size once the `<img>` reports it, the same path an SVG file takes.
        meta={null}
        servedFromCache
        fileName={props.alt}
        compact
        gesturesEnabled
        animationMs={DEFAULT_ANIMATION_MS}
        transformRef={transformRef}
        onTransformChange={handleTransformChange}
        doubleClickOverride={null}
        onDecodeError={null}
      />
      <div className="absolute bottom-safe-bottom-gutter right-3 flex flex-wrap items-center justify-end gap-2">
        <div
          role="toolbar"
          aria-label="Image zoom controls"
          className="flex items-center gap-1 rounded-md border bg-popover p-1 shadow-sm"
        >
          <ZoomControls
            ready={report !== null}
            scalePercent={
              report === null ? null : Math.round(report.state.scale * 100)
            }
            canZoomIn={
              report !== null && report.state.scale < MAX_SCALE - SCALE_EPSILON
            }
            canZoomOut={
              report !== null &&
              report.state.scale > report.minScale + SCALE_EPSILON
            }
            onZoomIn={() => {
              transformRef.current?.zoomIn(ZOOM_STEP, DEFAULT_ANIMATION_MS);
            }}
            onZoomOut={() => {
              transformRef.current?.zoomOut(ZOOM_STEP, DEFAULT_ANIMATION_MS);
            }}
            fitKind="screen"
            fitActive={report?.isFitted ?? false}
            onFit={handleFit}
            actualSizeActive={report?.isActualSize ?? false}
            onActualSize={() => {
              transformRef.current?.centerView(1, DEFAULT_ANIMATION_MS);
            }}
            stepGroupClassName={undefined}
            anchorGroupClassName={undefined}
          />
        </div>
        {props.actions}
      </div>
    </div>
  );
}
