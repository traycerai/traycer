import {
  type KeyboardEvent,
  useCallback,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  TransformComponent,
  TransformWrapper,
  type ReactZoomPanPinchRef,
} from "react-zoom-pan-pinch";
import { Maximize2, Minus, Plus, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { trustedMarkupToReactNodes } from "@/lib/trusted-markup";
import { cn } from "@/lib/utils";
import { getSvgIntrinsicSize } from "./mermaid-service";

export interface PanZoomSvgViewerProps {
  readonly svg: string;
  readonly ariaLabel: string;
  readonly className: string | undefined;
}

const MIN_SCALE = 0.25;
const MAX_SCALE = 8;
const ANIMATION_MS = 200;
const ZOOM_STEP = 0.2;
const FIT_PADDING_PX = 32;

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

interface ContainerSize {
  readonly width: number;
  readonly height: number;
}

export function PanZoomSvgViewer(props: PanZoomSvgViewerProps) {
  const { svg, ariaLabel, className } = props;
  const intrinsic = useMemo(() => getSvgIntrinsicSize(svg), [svg]);
  const renderedSvg = useMemo(
    () => trustedMarkupToReactNodes(svg, "svg"),
    [svg],
  );

  const transformRef = useRef<ReactZoomPanPinchRef | null>(null);
  const containerRef = useRef<HTMLElement | null>(null);
  const isFittedRef = useRef(true);

  const [containerSize, setContainerSize] = useState<ContainerSize | null>(
    null,
  );
  const [scale, setScale] = useState(1);

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

  const handleZoomIn = useCallback((): void => {
    transformRef.current?.zoomIn(ZOOM_STEP, ANIMATION_MS);
    isFittedRef.current = false;
  }, []);

  const handleZoomOut = useCallback((): void => {
    transformRef.current?.zoomOut(ZOOM_STEP, ANIMATION_MS);
    isFittedRef.current = false;
  }, []);

  const handleFit = useCallback((): void => {
    const ref = transformRef.current;
    const size = containerSize;
    if (ref === null || size === null) return;
    const next = fitTransformFor(
      size.width,
      size.height,
      intrinsic.width,
      intrinsic.height,
    );
    ref.setTransform(next.positionX, next.positionY, next.scale, ANIMATION_MS);
    isFittedRef.current = true;
  }, [containerSize, intrinsic]);

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
    isFittedRef.current = false;
  }, [containerSize, intrinsic]);

  const handleDoubleClick = useCallback((): void => {
    if (isFittedRef.current) {
      handleActualSize();
      return;
    }
    handleFit();
  }, [handleActualSize, handleFit]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLButtonElement>): void => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        handleZoomIn();
        return;
      }
      if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        handleZoomOut();
        return;
      }
      if (e.key === "0") {
        e.preventDefault();
        handleActualSize();
        return;
      }
      if (e.key === "f" || e.key === "F") {
        e.preventDefault();
        handleFit();
      }
    },
    [handleActualSize, handleFit, handleZoomIn, handleZoomOut],
  );

  const percent = Math.round(scale * 100);

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
            setScale(state.scale);
          }}
          onPanningStart={() => {
            isFittedRef.current = false;
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
                lineHeight: 0,
              }}
              className="tc-mermaid-pan-zoom__content [&>svg]:!w-full [&>svg]:!h-full [&>svg]:!max-w-none"
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
        <TooltipWrapper
          label="Zoom out (-)"
          side="top"
          sideOffset={undefined}
          align={undefined}
        >
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={handleZoomOut}
            onKeyDown={handleKeyDown}
            aria-label="Zoom out"
            aria-keyshortcuts="-"
            disabled={scale <= MIN_SCALE + 0.001}
          >
            <Minus className="size-4" aria-hidden="true" />
          </Button>
        </TooltipWrapper>
        <TooltipWrapper
          label="Fit to screen (F)"
          side="top"
          sideOffset={undefined}
          align={undefined}
        >
          <Button
            variant="ghost"
            size="sm"
            onClick={handleFit}
            onKeyDown={handleKeyDown}
            aria-label={`Current zoom ${percent}%, click to fit`}
            aria-keyshortcuts="F"
            className="min-w-12 tabular-nums"
          >
            {percent}%
          </Button>
        </TooltipWrapper>
        <TooltipWrapper
          label="Zoom in (+)"
          side="top"
          sideOffset={undefined}
          align={undefined}
        >
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={handleZoomIn}
            onKeyDown={handleKeyDown}
            aria-label="Zoom in"
            aria-keyshortcuts="+"
            disabled={scale >= MAX_SCALE - 0.001}
          >
            <Plus className="size-4" aria-hidden="true" />
          </Button>
        </TooltipWrapper>
        <div className="mx-0.5 h-4 w-px bg-border" aria-hidden="true" />
        <TooltipWrapper
          label="Fit to screen (F)"
          side="top"
          sideOffset={undefined}
          align={undefined}
        >
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={handleFit}
            onKeyDown={handleKeyDown}
            aria-label="Fit to screen"
            aria-keyshortcuts="F"
          >
            <Maximize2 className="size-4" aria-hidden="true" />
          </Button>
        </TooltipWrapper>
        <TooltipWrapper
          label="Actual size (0)"
          side="top"
          sideOffset={undefined}
          align={undefined}
        >
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={handleActualSize}
            onKeyDown={handleKeyDown}
            aria-label="Reset to actual size"
            aria-keyshortcuts="0"
          >
            <RotateCcw className="size-4" aria-hidden="true" />
          </Button>
        </TooltipWrapper>
      </div>
    </section>
  );
}
