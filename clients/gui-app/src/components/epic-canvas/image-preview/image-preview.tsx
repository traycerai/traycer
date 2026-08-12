import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import {
  TransformComponent,
  TransformWrapper,
  type ReactZoomPanPinchRef,
} from "react-zoom-pan-pinch";
import { Copy, Maximize2, Minus, Plus, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { cn } from "@/lib/utils";
import { appLogger } from "@/lib/logger";
import type { ImageAssetMeta } from "@/hooks/assets/use-image-asset";
import { formatImagePreviewCaption } from "./image-preview-caption";
import {
  browserImageCopyOps,
  copyImageToClipboard,
} from "./image-preview-clipboard";
import {
  ACTUAL_SIZE_EPSILON,
  DEFAULT_ANIMATION_MS,
  fitScaleFor,
  initialFitTransform,
  MAX_SCALE,
  MIN_SCALE,
  ZOOM_BOUNDARY_EPSILON,
  ZOOM_STEP,
  type ContainerSize,
  type ImagePreviewTransformState,
} from "./image-preview-transform";

export { DEFAULT_ANIMATION_MS };

/** `fallback` is a distinct branch the caller renders instead (`BinaryPlaceholder`) - never a status this viewer itself handles. */
export type ImagePreviewStatus = "loading" | "header" | "ready";

export interface ImagePreviewProps {
  readonly status: ImagePreviewStatus;
  /** Blob URL; non-null only once `status === "ready"`. */
  readonly url: string | null;
  readonly meta: ImageAssetMeta | null;
  /** Alt text and the file name copy/report actions would reference. */
  readonly fileName: string;
  /** Drops this instance's own toolbar (ticket 05) - image-preview decision log, decision #18. Independent of `gesturesEnabled`: `ImageDiffView`'s linked sides pass `compact` but keep gestures on, driven by its own shared toolbar. */
  readonly compact: boolean;
  /** Pan/pinch/wheel-zoom/double-click-toggle on or off. `false` for the bundle diff variant (decision #18's affordance-free intent) - static fit only, no gesture traps inside a virtualized list. */
  readonly gesturesEnabled: boolean;
  /**
   * Exposes this instance's imperative transform controls (`setTransform`,
   * `centerView`, `zoomIn`/`zoomOut`) to a caller that links multiple
   * instances (`ImageDiffView`, ticket 07) - `null` manages its own ref
   * internally (today's other caller, the workspace tile).
   */
  readonly transformRef: RefObject<ReactZoomPanPinchRef | null> | null;
  /** Fired on every transform change (gesture or this instance's own toolbar) so a caller can mirror it onto a linked peer; `null` when standalone. */
  readonly onTransformChange:
    ((state: ImagePreviewTransformState) => void) | null;
  /**
   * Toolbar/gesture transform animation duration in ms - ONE motion
   * language per context (ticket 07, better-ui audit): `0` for a caller
   * driving multiple linked instances (`ImageDiffView`), whose dual-dispatch
   * must stay reentrancy-safe (an animated peer update would still be
   * mid-flight, firing more `onTransform` events, when the NEXT toolbar
   * click starts); the library's own smooth default otherwise (the
   * standalone workspace tile).
   */
  readonly animationMs: number;
  /**
   * Fired from the underlying `<img>`'s `onError` - magic-valid, header-
   * parseable bytes can still fail to decode in the browser (pre-landing
   * review, P1), and this viewer never renders its own fallback (that stays
   * the caller's job, per the `ImagePreviewStatus` doc comment above), so
   * the caller must react and switch to its own settled placeholder.
   */
  readonly onDecodeError: (() => void) | null;
}

const COPY_FEEDBACK_RESET_MS = 1500;

/**
 * `measuring`: stage not yet laid out - keep the skeleton up rather than
 * flash an unconstrained image (a real, verified video symptom: the huge-
 * image flash this ticket exists to fix). `no-dimensions`: the stage IS
 * measured but `meta` never declared width/height (a dimension-less SVG) -
 * there is nothing to compute an initial fit FROM, so this renders a
 * constrained (not unconstrained, not stuck-forever) fallback with no
 * transform. `ready`: the normal case.
 */
type StageReadiness =
  | { readonly kind: "measuring" }
  | { readonly kind: "no-dimensions" }
  | { readonly kind: "ready"; readonly transform: ImagePreviewTransformState };

function stageReadinessFor(
  stageSize: ContainerSize | null,
  metaSize: ContainerSize | null,
): StageReadiness {
  if (stageSize === null) return { kind: "measuring" };
  if (metaSize === null) return { kind: "no-dimensions" };
  return { kind: "ready", transform: initialFitTransform(stageSize, metaSize) };
}

function panCursor(gesturesEnabled: boolean, isPanning: boolean): string {
  if (!gesturesEnabled) return "default";
  return isPanning ? "grabbing" : "grab";
}

export function ImagePreview(props: ImagePreviewProps) {
  // Destructured (not `props.x` inline in JSX below) so the ref-safety
  // linter can see these are plain values, not a live ref read during
  // render - same reasoning as `diff-content-primitive.tsx`'s
  // `scrollContainerRef` destructure (image-preview decision log, ticket 05).
  const {
    onDecodeError,
    onTransformChange,
    transformRef: externalRef,
    animationMs,
  } = props;
  const internalTransformRef = useRef<ReactZoomPanPinchRef | null>(null);
  const transformRef = externalRef ?? internalTransformRef;
  const imgRef = useRef<HTMLImageElement | null>(null);
  const setImgRef = useCallback((el: HTMLImageElement | null): void => {
    imgRef.current = el;
  }, []);
  // Reactive (not a ref): drives the toolbar's Fit/Actual-size buttons'
  // `aria-pressed` state, which the active-variant CSS turns into a filled
  // background - the active zoom mode must be STATICALLY visible in the
  // toolbar (UI polish requirements #6/#7), not only inferable from the
  // image's rendered size. Zoom is a THIRD state distinct from both: at an
  // intermediate zoom (e.g. a zoom-in click from fit), neither reads
  // pressed - `isActualSize` below is derived from `scale`, never from
  // `!isFitted` (that conflated "not fitted" with "at 100%").
  const [isFitted, setIsFitted] = useState(true);
  const [isPanning, setIsPanning] = useState(false);
  const [scale, setScale] = useState(1);
  // `scale` only updates from the library's own `onTransform` - but that
  // fires on CHANGE, not necessarily for the static `initialScale` a
  // `TransformWrapper` mounts with, so the "Actual size" pressed state
  // would otherwise read stale-true (`scale` still at its `1` default)
  // even when the real initial transform is a fit scale far from 100%.
  const [scaleSynced, setScaleSynced] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState<"idle" | "copied" | "error">(
    "idle",
  );
  const copyResetTimerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    return () => window.clearTimeout(copyResetTimerRef.current);
  }, []);

  const stageElRef = useRef<HTMLDivElement | null>(null);
  const [stageSize, setStageSize] = useState<ContainerSize | null>(null);
  // Callback ref measures the stage synchronously when React attaches it
  // (mirrors `pan-zoom-svg-viewer.tsx`) - gating `TransformWrapper` on
  // `stageSize !== null` means it mounts already knowing the right initial
  // transform, no flash, no imperative setTransform on first paint.
  const setStageEl = useCallback((el: HTMLDivElement | null): void => {
    stageElRef.current = el;
    if (el === null) return;
    const rect = el.getBoundingClientRect();
    setStageSize({ width: rect.width, height: rect.height });
  }, []);

  // Live re-measure: the callback ref above is a ONE-TIME snapshot from
  // mount, which goes stale the moment a tile is resized (a dragged pane
  // divider) - the fit transform would stay wrong until a manual Fit click.
  useEffect(() => {
    const el = stageElRef.current;
    if (el === null) return;
    const observer = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      setStageSize({ width, height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const readNaturalSize = useCallback((): ContainerSize | null => {
    const image = imgRef.current;
    if (image === null || image.naturalWidth <= 0 || image.naturalHeight <= 0) {
      return null;
    }
    return { width: image.naturalWidth, height: image.naturalHeight };
  }, []);

  const metaSize: ContainerSize | null =
    props.meta === null ||
    props.meta.width === null ||
    props.meta.height === null
      ? null
      : { width: props.meta.width, height: props.meta.height };

  const stage = stageReadinessFor(stageSize, metaSize);

  // Adjusted DURING RENDER (not an effect - react.dev's "adjusting state
  // when a prop changes" pattern), once: as soon as the initial fit
  // transform is known, `scale` starts from ITS value instead of the `1`
  // default, so `isActualSize` below is correct from the very first paint.
  if (!scaleSynced && stage.kind === "ready") {
    setScaleSynced(true);
    setScale(stage.transform.scale);
  }

  // Re-fit on resize ONLY while still in fitted state - a manual zoom/pan
  // is never yanked out from under the user by a pane resize.
  useEffect(() => {
    if (!isFitted || stageSize === null) return;
    const ref = transformRef.current;
    const natural = readNaturalSize();
    if (ref === null || natural === null) return;
    ref.centerView(fitScaleFor(stageSize, natural), 0);
  }, [stageSize, isFitted, readNaturalSize, transformRef]);

  // Plain (not `useCallback`-wrapped) - each reads `transformRef.current` at
  // CALL time, which the React Compiler can't reconcile against a manual
  // dependency array built around the stable `transformRef` object itself;
  // the compiler auto-memoizes these anyway.
  function stageRect(): ContainerSize | null {
    // Re-measure live so a Fit click against a since-resized tile uses its
    // CURRENT bounds, not the size at first paint.
    const el = transformRef.current?.instance.wrapperComponent ?? null;
    if (el === null) return stageSize;
    const rect = el.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  }

  function handleFit(): void {
    const ref = transformRef.current;
    const container = stageRect();
    const natural = readNaturalSize();
    if (ref === null || container === null || natural === null) return;
    ref.centerView(fitScaleFor(container, natural), animationMs);
    setIsFitted(true);
  }

  function handleActualSize(): void {
    transformRef.current?.centerView(1, animationMs);
    setIsFitted(false);
  }

  function handleZoomIn(): void {
    transformRef.current?.zoomIn(ZOOM_STEP, animationMs);
    setIsFitted(false);
  }

  function handleZoomOut(): void {
    transformRef.current?.zoomOut(ZOOM_STEP, animationMs);
    setIsFitted(false);
  }

  // Plain functions (not `useCallback`), matching `handleFit`/etc. above -
  // they close over this render's `isFitted`/`handleFit`/etc. directly, and
  // the React Compiler auto-memoizes the component as a whole.
  function handleDoubleClick(): void {
    if (isFitted) {
      handleActualSize();
      return;
    }
    handleFit();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      handleZoomIn();
      return;
    }
    if (event.key === "-" || event.key === "_") {
      event.preventDefault();
      handleZoomOut();
      return;
    }
    if (event.key === "0") {
      event.preventDefault();
      handleActualSize();
      return;
    }
    if (event.key === "f" || event.key === "F") {
      event.preventDefault();
      handleFit();
    }
  }

  const handlePanningStart = useCallback((): void => {
    setIsFitted(false);
    setIsPanning(true);
  }, []);

  const handlePanningStop = useCallback((): void => {
    setIsPanning(false);
  }, []);

  const handleTransformed = useCallback(
    (_ref: ReactZoomPanPinchRef, state: ImagePreviewTransformState): void => {
      setScale(state.scale);
      onTransformChange?.(state);
    },
    [onTransformChange],
  );

  const handleDecodeError = useCallback((): void => {
    onDecodeError?.();
  }, [onDecodeError]);

  const handleCopy = useCallback(() => {
    const image = imgRef.current;
    if (image === null) return;
    copyImageToClipboard(image, browserImageCopyOps).then(
      () => {
        window.clearTimeout(copyResetTimerRef.current);
        setCopyFeedback("copied");
        copyResetTimerRef.current = window.setTimeout(
          () => setCopyFeedback("idle"),
          COPY_FEEDBACK_RESET_MS,
        );
      },
      (error: unknown) => {
        appLogger.error("[image-preview] copy to clipboard failed", {}, error);
        window.clearTimeout(copyResetTimerRef.current);
        setCopyFeedback("error");
        copyResetTimerRef.current = window.setTimeout(
          () => setCopyFeedback("idle"),
          COPY_FEEDBACK_RESET_MS,
        );
      },
    );
  }, []);

  const caption = formatImagePreviewCaption(props.meta);
  const aspectRatio = imagePreviewAspectRatio(props.meta);
  const isActualSize = Math.abs(scale - 1) < ACTUAL_SIZE_EPSILON;
  const zoomDisabled = props.status !== "ready";
  const zoomOutDisabled =
    zoomDisabled || scale <= MIN_SCALE + ZOOM_BOUNDARY_EPSILON;
  const zoomInDisabled =
    zoomDisabled || scale >= MAX_SCALE - ZOOM_BOUNDARY_EPSILON;

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      {props.compact ? null : (
        <div
          role="toolbar"
          aria-label="Image preview controls"
          className="relative z-10 flex h-8 shrink-0 items-center justify-end gap-1 border-b border-canvas-border/70 px-2"
        >
          <TooltipWrapper
            label="Zoom out (-)"
            side="top"
            sideOffset={undefined}
            align={undefined}
          >
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={zoomOutDisabled}
              onClick={handleZoomOut}
              onKeyDown={handleKeyDown}
              aria-label="Zoom out"
            >
              <Minus className="size-4" />
            </Button>
          </TooltipWrapper>
          <TooltipWrapper
            label="Zoom in (+)"
            side="top"
            sideOffset={undefined}
            align={undefined}
          >
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={zoomInDisabled}
              onClick={handleZoomIn}
              onKeyDown={handleKeyDown}
              aria-label="Zoom in"
            >
              <Plus className="size-4" />
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
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-pressed={isFitted}
              disabled={zoomDisabled}
              onClick={handleFit}
              onKeyDown={handleKeyDown}
              aria-label="Fit to screen"
            >
              <Maximize2 className="size-4" />
            </Button>
          </TooltipWrapper>
          <TooltipWrapper
            label="Actual size (0)"
            side="top"
            sideOffset={undefined}
            align={undefined}
          >
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-pressed={isActualSize}
              disabled={zoomDisabled}
              onClick={handleActualSize}
              onKeyDown={handleKeyDown}
              aria-label="Actual size"
            >
              <RotateCcw className="size-4" />
            </Button>
          </TooltipWrapper>
          <div className="mx-0.5 h-4 w-px bg-border" aria-hidden="true" />
          <TooltipWrapper
            label={copyButtonLabel(copyFeedback)}
            side="top"
            sideOffset={undefined}
            align={undefined}
          >
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={zoomDisabled}
              onClick={handleCopy}
            >
              <Copy className="size-4" />
            </Button>
          </TooltipWrapper>
        </div>
      )}
      <div
        ref={setStageEl}
        className="image-preview-checkerboard relative isolate min-h-0 flex-1 overflow-hidden"
      >
        {renderImagePreviewStage({
          status: props.status,
          url: props.url,
          fileName: props.fileName,
          aspectRatio,
          setImgRef,
          stage,
          gesturesEnabled: props.gesturesEnabled,
          isPanning,
          transformRef,
          onDoubleClick: handleDoubleClick,
          onPanningStart: handlePanningStart,
          onPanningStop: handlePanningStop,
          onTransform: handleTransformed,
          onDecodeError: handleDecodeError,
        })}
      </div>
      {caption !== null ? (
        <div className="flex h-6 shrink-0 items-center justify-center border-t border-canvas-border/70 text-ui-xs text-muted-foreground">
          {caption}
        </div>
      ) : null}
    </div>
  );
}

function imagePreviewAspectRatio(meta: ImageAssetMeta | null): number | null {
  if (meta === null || meta.width === null || meta.height === null) return null;
  if (meta.height <= 0) return null;
  return meta.width / meta.height;
}

function copyButtonLabel(state: "idle" | "copied" | "error"): string {
  if (state === "copied") return "Copied";
  if (state === "error") return "Couldn't copy image";
  return "Copy image";
}

function renderImagePreviewStage(args: {
  readonly status: ImagePreviewStatus;
  readonly url: string | null;
  readonly fileName: string;
  readonly aspectRatio: number | null;
  readonly setImgRef: (el: HTMLImageElement | null) => void;
  readonly stage: StageReadiness;
  readonly gesturesEnabled: boolean;
  readonly isPanning: boolean;
  readonly transformRef: RefObject<ReactZoomPanPinchRef | null>;
  readonly onDoubleClick: () => void;
  readonly onPanningStart: () => void;
  readonly onPanningStop: () => void;
  readonly onTransform: (
    ref: ReactZoomPanPinchRef,
    state: ImagePreviewTransformState,
  ) => void;
  readonly onDecodeError: () => void;
}): ReactNode {
  if (args.status === "ready" && args.url !== null) {
    if (args.stage.kind === "measuring") {
      // Stage not yet laid out - keep the skeleton up rather than flash an
      // unconstrained image (video symptom #1).
      return renderSkeleton(args.aspectRatio);
    }
    if (args.stage.kind === "no-dimensions") {
      // `meta` never declared width/height (a dimension-less SVG) - no
      // basis to compute an initial fit from; render constrained via CSS
      // instead of unconstrained, with no transform (no natural size to
      // seed one safely from yet).
      return (
        <div className="flex size-full items-center justify-center p-2">
          <ImageStageImg
            url={args.url}
            fileName={args.fileName}
            setImgRef={args.setImgRef}
            onDecodeError={args.onDecodeError}
            className="max-h-full max-w-full object-contain"
          />
        </div>
      );
    }
    return (
      <TransformWrapper
        ref={args.transformRef}
        initialScale={args.stage.transform.scale}
        initialPositionX={args.stage.transform.positionX}
        initialPositionY={args.stage.transform.positionY}
        minScale={MIN_SCALE}
        maxScale={MAX_SCALE}
        limitToBounds
        centerOnInit={false}
        smooth
        disabled={!args.gesturesEnabled}
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
        onTransform={args.onTransform}
        onPanningStart={args.onPanningStart}
        onPanningStop={args.onPanningStop}
      >
        <TransformComponent
          wrapperStyle={{ width: "100%", height: "100%" }}
          contentStyle={{
            cursor: panCursor(args.gesturesEnabled, args.isPanning),
          }}
        >
          <div
            onDoubleClick={
              args.gesturesEnabled
                ? (event: MouseEvent<HTMLDivElement>) => {
                    event.preventDefault();
                    args.onDoubleClick();
                  }
                : undefined
            }
          >
            <ImageStageImg
              url={args.url}
              fileName={args.fileName}
              setImgRef={args.setImgRef}
              onDecodeError={args.onDecodeError}
              className="max-w-none"
            />
          </div>
        </TransformComponent>
      </TransformWrapper>
    );
  }
  if (args.status === "loading") {
    return (
      <div className="flex size-full items-center justify-center">
        <AgentSpinningDots
          className={undefined}
          testId={undefined}
          variant={undefined}
        />
      </div>
    );
  }
  return renderSkeleton(args.aspectRatio);
}

function renderSkeleton(aspectRatio: number | null): ReactNode {
  return (
    <div className="flex size-full items-center justify-center p-2">
      {aspectRatio !== null ? (
        <div
          data-testid="image-preview-skeleton"
          className="max-h-full max-w-full"
          style={{ aspectRatio: String(aspectRatio), width: "100%" }}
        />
      ) : null}
    </div>
  );
}

function ImageStageImg(props: {
  readonly url: string;
  readonly fileName: string;
  readonly setImgRef: (el: HTMLImageElement | null) => void;
  readonly onDecodeError: () => void;
  readonly className: string;
}): ReactNode {
  // Skeleton -> image cross-fade (UI polish requirement #4): opacity-only,
  // <=150ms, and SKIPPED for an already-cached URL - `HTMLImageElement`
  // reports `complete: true` synchronously once the browser has the bytes
  // decoded, which a fresh network load never does before this first
  // render. Syncing with that browser-owned, event-driven state (`onLoad`)
  // is exactly what an effect is for, unlike a plain "reset derived state
  // on prop change" that render-time adjustment would otherwise cover.
  const { setImgRef } = props;
  const [loaded, setLoaded] = useState(false);
  const localImgRef = useRef<HTMLImageElement | null>(null);
  const setImgEl = useCallback(
    (el: HTMLImageElement | null): void => {
      setImgRef(el);
      localImgRef.current = el;
    },
    [setImgRef],
  );
  useEffect(() => {
    setLoaded(localImgRef.current?.complete === true);
  }, [props.url]);
  const handleLoad = useCallback((): void => setLoaded(true), []);

  return (
    <img
      ref={setImgEl}
      src={props.url}
      alt={props.fileName}
      draggable={false}
      onLoad={handleLoad}
      onError={props.onDecodeError}
      className={cn(
        "image-preview-outline block transition-opacity duration-150 ease-out",
        loaded ? "opacity-100" : "opacity-0",
        props.className,
      )}
    />
  );
}
