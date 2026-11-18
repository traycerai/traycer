import { useCallback, useMemo, useRef, useState } from "react";
import {
  TransformComponent,
  TransformWrapper,
  type ReactZoomPanPinchRef,
} from "react-zoom-pan-pinch";
import { ZoomControls } from "@/components/epic-canvas/zoom-controls/zoom-controls";
import { trustedMarkupToReactNodes } from "@/lib/trusted-markup";
import { cn } from "@/lib/utils";
import { getSvgIntrinsicSize } from "./mermaid-service";

export interface PanZoomSvgViewerProps {
  readonly svg: string;
  readonly source: "sanitized" | "trusted";
  readonly ariaLabel: string;
  readonly className: string | undefined;
}

const MIN_SCALE = 0.25;
const MAX_SCALE = 8;
const ANIMATION_MS = 200;
const ZOOM_STEP = 0.2;
const FIT_PADDING_PX = 32;
const SCALE_EPSILON = 0.001;
/** How far a settled transform may sit from the fit transform and still count as fitted - an animated fit lands within sub-pixel rounding of its target. */
const POSITION_EPSILON_PX = 0.5;

interface AppliedTransform {
  readonly positionX: number;
  readonly positionY: number;
  readonly scale: number;
}

function fitTransformFor(
  containerWidth: number,
  containerHeight: number,
  intrinsicWidth: number,
  intrinsicHeight: number,
): AppliedTransform {
  const availW = Math.max(containerWidth - FIT_PADDING_PX * 2, 1);
  const availH = Math.max(containerHeight - FIT_PADDING_PX * 2, 1);
  const raw = Math.min(availW / intrinsicWidth, availH / intrinsicHeight);
  const scale = Math.min(Math.max(raw, MIN_SCALE), MAX_SCALE);
  return {
    scale,
    positionX: (containerWidth - intrinsicWidth * scale) / 2,
    positionY: (containerHeight - intrinsicHeight * scale) / 2,
  };
}

function actualSizeTransformFor(
  containerWidth: number,
  containerHeight: number,
  intrinsicWidth: number,
  intrinsicHeight: number,
): AppliedTransform {
  return {
    scale: 1,
    positionX: (containerWidth - intrinsicWidth) / 2,
    positionY: (containerHeight - intrinsicHeight) / 2,
  };
}

function transformMatchesFit(
  transform: AppliedTransform,
  fit: AppliedTransform,
): boolean {
  return (
    Math.abs(transform.scale - fit.scale) < SCALE_EPSILON &&
    Math.abs(transform.positionX - fit.positionX) < POSITION_EPSILON_PX &&
    Math.abs(transform.positionY - fit.positionY) < POSITION_EPSILON_PX
  );
}

interface ContainerSize {
  readonly width: number;
  readonly height: number;
}

export function PanZoomSvgViewer(props: PanZoomSvgViewerProps) {
  const { svg, ariaLabel, className } = props;
  const intrinsic = useMemo(() => getSvgIntrinsicSize(svg), [svg]);
  const renderedSvg =
    props.source === "trusted" ? (
      trustedMarkupToReactNodes(svg, "svg")
    ) : (
      <SanitizedSvgMarkup svg={svg} />
    );

  const transformRef = useRef<ReactZoomPanPinchRef | null>(null);
  const containerRef = useRef<HTMLElement | null>(null);

  const [containerSize, setContainerSize] = useState<ContainerSize | null>(
    null,
  );
  // The library reports every transform it applies EXCEPT the initial one,
  // so `null` here means "still at the fit we mounted with" and the readout
  // and pressed states read `initial` instead.
  const [reported, setReported] = useState<AppliedTransform | null>(null);

  // Callback ref measures the wrapper synchronously when React attaches it.
  // Setting state from a ref callback bypasses the fire-before-init race
  // we hit with useLayoutEffect: by gating TransformWrapper on
  // `containerSize !== null`, the library mounts already knowing the right
  // initial transform - no flash, no imperative setTransform.
  const setContainerEl = useCallback((el: HTMLElement | null) => {
    containerRef.current = el;
    if (el === null) return;
    const rect = el.getBoundingClientRect();
    setContainerSize({ width: rect.width, height: rect.height });
  }, []);

  const initial = useMemo(
    () =>
      containerSize === null
        ? null
        : fitTransformFor(
            containerSize.width,
            containerSize.height,
            intrinsic.width,
            intrinsic.height,
          ),
    [containerSize, intrinsic],
  );
  const transform = reported ?? initial;
  // Derived from the live transform, never a flag a gesture could leave
  // stale: a pinch that lands back on the fit reads as fitted.
  const isFitted =
    transform !== null &&
    initial !== null &&
    transformMatchesFit(transform, initial);
  const isActualSize =
    transform !== null && Math.abs(transform.scale - 1) < SCALE_EPSILON;
  const scale = transform?.scale ?? 1;

  const handleZoomIn = useCallback((): void => {
    transformRef.current?.zoomIn(ZOOM_STEP, ANIMATION_MS);
  }, []);

  const handleZoomOut = useCallback((): void => {
    transformRef.current?.zoomOut(ZOOM_STEP, ANIMATION_MS);
  }, []);

  const handleFit = useCallback((): void => {
    const ref = transformRef.current;
    if (ref === null || initial === null) return;
    ref.setTransform(
      initial.positionX,
      initial.positionY,
      initial.scale,
      ANIMATION_MS,
    );
  }, [initial]);

  const handleActualSize = useCallback((): void => {
    const ref = transformRef.current;
    const size = containerSize;
    if (ref === null || size === null) return;
    const next = actualSizeTransformFor(
      size.width,
      size.height,
      intrinsic.width,
      intrinsic.height,
    );
    ref.setTransform(next.positionX, next.positionY, next.scale, ANIMATION_MS);
  }, [containerSize, intrinsic]);

  const handleDoubleClick = useCallback((): void => {
    if (isFitted) {
      handleActualSize();
      return;
    }
    handleFit();
  }, [isFitted, handleActualSize, handleFit]);

  return (
    <section
      ref={setContainerEl}
      aria-label={ariaLabel}
      className={cn("relative w-full h-full bg-canvas outline-none", className)}
    >
      {initial !== null ? (
        <TransformWrapper
          ref={transformRef}
          initialScale={initial.scale}
          initialPositionX={initial.positionX}
          initialPositionY={initial.positionY}
          minScale={MIN_SCALE}
          maxScale={MAX_SCALE}
          limitToBounds
          centerOnInit={false}
          smooth
          wheel={{
            step: ZOOM_STEP,
            wheelDisabled: true,
            touchPadDisabled: false,
          }}
          panning={{
            velocityDisabled: true,
          }}
          trackPadPanning={{
            velocityDisabled: true,
          }}
          pinch={{
            step: 5,
          }}
          doubleClick={{
            disabled: true,
          }}
          onTransform={(_ref, state) => {
            setReported({
              scale: state.scale,
              positionX: state.positionX,
              positionY: state.positionY,
            });
          }}
        >
          <TransformComponent
            wrapperStyle={{ width: "100%", height: "100%" }}
            contentStyle={{ cursor: "grab" }}
          >
            <div
              onDoubleClick={handleDoubleClick}
              // Lock the slot to the SVG's natural viewBox dimensions so
              // mermaid's own `width="100%"` does not collapse to the
              // browser's 300x150 default inside the library's
              // `width: fit-content` content wrapper.
              style={{
                width: `${intrinsic.width}px`,
                height: `${intrinsic.height}px`,
              }}
              className="tc-mermaid-pan-zoom__content leading-none [&>svg]:!size-full [&>svg]:!max-w-none [&>div>svg]:!size-full [&>div>svg]:!max-w-none"
            >
              {renderedSvg}
            </div>
          </TransformComponent>
        </TransformWrapper>
      ) : null}

      <div
        className="absolute bottom-3 right-3 flex items-center gap-1 rounded-md border bg-popover p-1 shadow-sm"
        role="toolbar"
        aria-label="Diagram view controls"
      >
        <ZoomControls
          ready={initial !== null}
          scalePercent={initial === null ? null : Math.round(scale * 100)}
          canZoomIn={scale < MAX_SCALE - SCALE_EPSILON}
          canZoomOut={scale > MIN_SCALE + SCALE_EPSILON}
          onZoomIn={handleZoomIn}
          onZoomOut={handleZoomOut}
          fitKind="screen"
          fitActive={isFitted}
          onFit={handleFit}
          actualSizeActive={isActualSize}
          onActualSize={handleActualSize}
          stepGroupClassName={undefined}
          anchorGroupClassName={undefined}
        />
      </div>
    </section>
  );
}

function SanitizedSvgMarkup(props: { readonly svg: string }) {
  const setHost = useCallback(
    (host: HTMLDivElement | null): void => {
      if (host === null) return;
      const parsed = new DOMParser().parseFromString(
        props.svg,
        "image/svg+xml",
      );
      host.replaceChildren(document.importNode(parsed.documentElement, true));
    },
    [props.svg],
  );
  return <div ref={setHost} className="size-full [&>svg]:size-full" />;
}
