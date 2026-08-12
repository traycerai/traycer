import {
  useCallback,
  useEffect,
  useLayoutEffect,
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
import { Check, Copy, Maximize2, Minus, Plus } from "lucide-react";
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
  effectiveMinScale,
  fitScaleFor,
  initialFitTransform,
  MAX_SCALE,
  MIN_SCALE,
  transformMatchesFit,
  ZOOM_BOUNDARY_EPSILON,
  ZOOM_STEP,
  type ContainerSize,
  type ImagePreviewTransformReport,
  type ImagePreviewTransformState,
  type TransformOrigin,
} from "./image-preview-transform";

export { DEFAULT_ANIMATION_MS };

/** `fallback` is a distinct branch the caller renders instead (`BinaryPlaceholder`) - never a status this viewer itself handles. */
export type ImagePreviewStatus = "loading" | "header" | "ready";

export interface ImagePreviewProps {
  readonly status: ImagePreviewStatus;
  /** Blob URL; non-null only once `status === "ready"`. */
  readonly url: string | null;
  readonly meta: ImageAssetMeta | null;
  /**
   * Whether `url` resolved from the shared asset cache rather than a fresh
   * stream (`ImageAssetState.servedFromCache`, ticket 07 closing E2E item:
   * a brand-new `<img>` element mounted for a cache hit still reports
   * `complete === false` at layout time even though the bytes are already
   * local - that per-element browser signal can't carry "already resident"
   * across a remount, but this asset-layer one can) - skips the entrance
   * fade for a cache hit specifically. Only meaningful when `url !== null`.
   */
  readonly servedFromCache: boolean;
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
  /**
   * Fired once at mount and on every subsequent transform change (gesture
   * or this instance's own toolbar) so a caller can mirror it onto a
   * linked peer, derive shared pressed/boundary state from it, and never
   * has to re-derive or manually track this instance's own mode - `null`
   * when standalone. See {@link ImagePreviewTransformReport} (round-2
   * review, findings #3/#4): `origin` distinguishes a genuine user GESTURE
   * from a PROGRAMMATIC transform this instance issued itself (a caller
   * must never mirror a programmatic transform's raw numbers onto a
   * differently-sized peer, each peer computes its own fit, and must not
   * read it as "the user manually zoomed away"); `isFitted`/`isActualSize`
   * are this instance's OWN already-correct derivation, reported up rather
   * than re-derived by the caller; `minScale`/`maxScale` are this
   * instance's live interactive bounds, published at init (not only on
   * `onTransform` - RZPP applies its initial transform without calling it).
   */
  readonly onTransformChange:
    ((report: ImagePreviewTransformReport) => void) | null;
  /**
   * Overrides the internal double-click fit/actual toggle entirely - a
   * caller linking multiple instances (`ImageDiffView`, review finding #3)
   * must drive BOTH sides through its own dual-dispatch (each computing its
   * own fit), not let one side's internal handler run solo and get mirrored
   * onto the peer. `null` keeps the built-in per-instance toggle (the
   * standalone workspace tile).
   */
  readonly doubleClickOverride: (() => void) | null;
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
    doubleClickOverride,
    animationMs,
  } = props;
  const internalTransformRef = useRef<ReactZoomPanPinchRef | null>(null);
  const transformRef = externalRef ?? internalTransformRef;
  const imgRef = useRef<HTMLImageElement | null>(null);
  const setImgRef = useCallback((el: HTMLImageElement | null): void => {
    imgRef.current = el;
  }, []);
  // Incremented BEFORE every transform WE issue ourselves - Fit/Actual-
  // size/zoom, or the autonomous resize-refit effect below - and decremented
  // when its OWN `onTransform` callback actually arrives and is "consumed"
  // (round-2 review finding #2). A synchronous set-true/call/set-false
  // bracket only reports the right origin if the callback happens to fire
  // within that exact synchronous window.
  //
  // This is a COUNT, not a per-call identity - round-3 review finding #2
  // proved a count alone still misattributes origin if a DIFFERENT
  // programmatic call's callback consumes a slot meant for an earlier one
  // (or a gesture interleaves between issuing and its own delivery). The
  // ruling was NOT to build call-matching machinery for this: with
  // `react-zoom-pan-pinch` PINNED to exactly 4.0.4 (package.json - no
  // caret), `onTransform` for a `0`-duration transform fires synchronously,
  // in the same tick, before the issuing call returns - interleaving is
  // impossible on a single thread, so a plain count is correct as-is. See
  // the sync-delivery contract test against the real library; a version
  // bump that ever breaks that assumption must fail that test loudly
  // before this mechanism can silently reopen a ping-pong echo.
  //
  // KNOWN NARROWER LIMIT (round-4 review, discovered not ruled-on): the
  // "increment once, decrement on next callback" shape only correctly
  // tags ONE `onTransform` firing as programmatic. It assumes `0`ms,
  // single-callback delivery per issued call - true for every consumer
  // TODAY (the diff view always passes `animationMs={0}` to both linked
  // sides, pinned by its own test). It is NOT true for a nonzero
  // `animationMs`: the library's own animation loop invokes `onTransform`
  // once per animation frame for a SINGLE issued call (`animate()` calls
  // its step callback on every `requestAnimationFrame` tick until the
  // duration elapses), so only the FIRST of those N frames consumes the
  // pending slot - frames 2..N misreport `"gesture"`. Inert today because
  // the standalone workspace tile (the only caller that uses a nonzero
  // `animationMs`) never passes `onTransformChange` at all, so no one
  // reads the misreported origin. Deliberately NOT building consume-
  // until-complete machinery for a configuration that doesn't exist
  // (YAGNI) - if a future caller ever links instances at a nonzero
  // `animationMs`, this comment is the tripwire to revisit.
  const pendingProgrammaticCountRef = useRef(0);
  const [isPanning, setIsPanning] = useState(false);
  // The single source of truth for "where is this image right now" -
  // `isFitted`/`isActualSize` below are DERIVED from comparing this against
  // the live fit transform, never a manually-toggled flag a gesture handler
  // could leave stuck (review finding #2: a plain click's mousedown, or a
  // pinch/ctrl-wheel that never fires `onPanningStart`, used to desync a
  // separate `isFitted` boolean from what the transform actually was).
  const [transform, setTransform] = useState<ImagePreviewTransformState>({
    scale: 1,
    positionX: 0,
    positionY: 0,
  });
  // `transform` only updates from the library's own `onTransform` - but
  // that fires on CHANGE, not necessarily for the static `initialScale`/
  // `initialPositionX/Y` a `TransformWrapper` mounts with, so the derived
  // pressed states would otherwise read against a stale `{scale: 1, ...}`
  // default even when the real initial transform is a fit far from that.
  const [transformSynced, setTransformSynced] = useState(false);
  // Client-decoded fallback for `props.meta`'s width/height (review finding
  // #6): the host intentionally reports every SVG as dimensionless, so
  // there is nothing to compute a fit FROM until the blob-URL `<img>` itself
  // decodes and reports its own natural size. Reset on `url` change (render-
  // time adjustment, same pattern as the rest of this file) so a stale
  // decode from a PREVIOUS dimensionless file never survives a URL swap.
  const [decodedSize, setDecodedSize] = useState<ContainerSize | null>(null);
  const [decodedSizeUrl, setDecodedSizeUrl] = useState<string | null>(null);
  if (decodedSizeUrl !== props.url) {
    setDecodedSizeUrl(props.url);
    setDecodedSize(null);
  }
  const handleNaturalSize = useCallback((size: ContainerSize): void => {
    setDecodedSize(size);
  }, []);
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

  // `props.meta` is authoritative when it declares dimensions; `decodedSize`
  // (review finding #6) only fills the gap for a host-reported dimension-
  // less file (every SVG) once the blob-URL `<img>` itself has decoded.
  const metaSize: ContainerSize | null =
    props.meta === null ||
    props.meta.width === null ||
    props.meta.height === null
      ? decodedSize
      : { width: props.meta.width, height: props.meta.height };

  const stage = stageReadinessFor(stageSize, metaSize);
  // The live fit transform for THIS render's stage/meta size - recomputed
  // every render (not cached), so it tracks a pane resize automatically.
  // `null` while there's nothing to fit against yet.
  const liveFit = stage.kind === "ready" ? stage.transform : null;
  // Never greater than the current fit (review finding #7) - a huge image's
  // fit can and must sit below the normal interactive floor.
  const effectiveMin =
    liveFit !== null ? effectiveMinScale(liveFit.scale) : MIN_SCALE;
  // The single derivation review finding #2 asks for: fitted iff the
  // CURRENT transform (from wherever it came - gesture, toolbar, refit) IS
  // the live fit transform. No manual flag to get stuck.
  const isFitted = liveFit !== null && transformMatchesFit(transform, liveFit);
  const isActualSize = Math.abs(transform.scale - 1) < ACTUAL_SIZE_EPSILON;

  // Adjusted DURING RENDER (not an effect - react.dev's "adjusting state
  // when a prop changes" pattern), once: as soon as the initial fit
  // transform is known, `transform` starts from ITS value instead of the
  // `{scale: 1, ...}` default, so the derivations above are correct from
  // the very first paint.
  if (!transformSynced && liveFit !== null) {
    setTransformSynced(true);
    setTransform(liveFit);
  }

  // Ref-mirrored (via a layout effect, never assigned during render itself
  // - refs are for event handlers/effects, not render) so the resize
  // effect can see the LATEST transform without re-running every time it
  // changes - if `transform` were a reactive dependency instead, the
  // effect's OWN `centerView` call would update it and re-trigger the
  // effect, forever. No deps array: runs after EVERY commit, synchronously
  // before paint, so it's always current by the time the resize effect
  // (below, a passive effect, always flushes after) reads it.
  const latestTransformRef = useRef(transform);
  useLayoutEffect(() => {
    latestTransformRef.current = transform;
  });
  // The stage size as of the LAST time the resize effect below ran - used
  // to decide "was this fitted BEFORE this resize", never the new size.
  const prevStageSizeRef = useRef<ContainerSize | null>(null);

  // Re-fit on resize ONLY if the transform matched the fit for the
  // PREVIOUS stage size (round-2 review finding #1): comparing against the
  // NEW stage's fit here would already read "not fitted" for a transform
  // that was never laid out against that size, so the effect would bail
  // and a fitted preview would silently stop refitting on every resize.
  // Bracketed as a programmatic transform (review finding #3) so a caller
  // linking this instance to a peer never mirrors an autonomous refit's
  // raw numbers or reads it as "the user manually zoomed away".
  useEffect(() => {
    const prevStageSize = prevStageSizeRef.current;
    prevStageSizeRef.current = stageSize;
    if (stageSize === null || prevStageSize === null) return;
    const ref = transformRef.current;
    const natural = readNaturalSize();
    if (ref === null || natural === null) return;
    const wasFitted = transformMatchesFit(
      latestTransformRef.current,
      initialFitTransform(prevStageSize, natural),
    );
    if (!wasFitted) return;
    pendingProgrammaticCountRef.current += 1;
    ref.centerView(fitScaleFor(stageSize, natural), 0);
  }, [stageSize, readNaturalSize, transformRef]);

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
    pendingProgrammaticCountRef.current += 1;
    ref.centerView(fitScaleFor(container, natural), animationMs);
  }

  function handleActualSize(): void {
    const ref = transformRef.current;
    if (ref === null) return;
    pendingProgrammaticCountRef.current += 1;
    ref.centerView(1, animationMs);
  }

  function handleZoomIn(): void {
    const ref = transformRef.current;
    if (ref === null) return;
    pendingProgrammaticCountRef.current += 1;
    ref.zoomIn(ZOOM_STEP, animationMs);
  }

  function handleZoomOut(): void {
    const ref = transformRef.current;
    if (ref === null) return;
    pendingProgrammaticCountRef.current += 1;
    ref.zoomOut(ZOOM_STEP, animationMs);
  }

  // Plain functions (not `useCallback`), matching `handleFit`/etc. above -
  // they close over this render's `isFitted`/`handleFit`/etc. directly, and
  // the React Compiler auto-memoizes the component as a whole.
  function handleDoubleClick(): void {
    if (doubleClickOverride !== null) {
      doubleClickOverride();
      return;
    }
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

  // Cursor styling only (review finding #2) - mousedown is not a completed
  // transform, so this never touches the fit/actual-size derivation above.
  const handlePanningStart = useCallback((): void => {
    setIsPanning(true);
  }, []);

  const handlePanningStop = useCallback((): void => {
    setIsPanning(false);
  }, []);

  // Plain function (not `useCallback`) - reads THIS render's `liveFit`
  // directly (round-2 review findings #3/#4: the caller needs this
  // instance's own derived mode and live bounds, not just the raw state),
  // matching `handleFit`/etc above; the compiler auto-memoizes the whole
  // component.
  function buildTransformReport(
    state: ImagePreviewTransformState,
    origin: TransformOrigin,
    ref: ReactZoomPanPinchRef,
  ): ImagePreviewTransformReport {
    const setup = ref.instance.setup;
    return {
      state,
      origin,
      isFitted: liveFit !== null && transformMatchesFit(state, liveFit),
      isActualSize: Math.abs(state.scale - 1) < ACTUAL_SIZE_EPSILON,
      minScale: setup.minScale,
      maxScale: setup.maxScale,
    };
  }

  function handleTransformed(
    ref: ReactZoomPanPinchRef,
    state: ImagePreviewTransformState,
  ): void {
    setTransform(state);
    // "Consumed" (round-2 review finding #2): decremented exactly when a
    // callback actually arrives, not synchronously after issuing the call -
    // stays correct even if delivery is ever deferred past that call.
    const origin: TransformOrigin =
      pendingProgrammaticCountRef.current > 0 ? "programmatic" : "gesture";
    if (pendingProgrammaticCountRef.current > 0) {
      pendingProgrammaticCountRef.current -= 1;
    }
    onTransformChange?.(buildTransformReport(state, origin, ref));
  }

  // RZPP applies its initial transform without calling `onTransform`
  // (round-2 review finding #4), so a caller relying only on that callback
  // never learns this instance's true initial bounds - a side whose fit
  // sits below the constant floor would leave the caller's shared zoom-out
  // button incorrectly enabled at the old floor, no-opping on first click.
  function handleInit(ref: ReactZoomPanPinchRef): void {
    onTransformChange?.(buildTransformReport(transform, "programmatic", ref));
  }

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
  const zoomDisabled = props.status !== "ready";
  const zoomOutDisabled =
    zoomDisabled || transform.scale <= effectiveMin + ZOOM_BOUNDARY_EPSILON;
  const zoomInDisabled =
    zoomDisabled || transform.scale >= MAX_SCALE - ZOOM_BOUNDARY_EPSILON;

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      {props.compact ? null : (
        <div
          role="toolbar"
          aria-label="Image preview controls"
          className="relative z-10 flex h-8 shrink-0 items-center justify-between gap-2 border-b border-canvas-border/70 px-2"
        >
          <span className="min-w-0 truncate text-ui-xs text-muted-foreground">
            {caption}
          </span>
          <div className="flex shrink-0 items-center gap-1">
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
              label="Actual size (100%)"
              side="top"
              sideOffset={undefined}
              align={undefined}
            >
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-pressed={isActualSize}
                disabled={zoomDisabled}
                onClick={handleActualSize}
                onKeyDown={handleKeyDown}
                aria-label="Actual size"
                className="min-w-12 tabular-nums"
              >
                100%
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
                {copyButtonIcon(copyFeedback)}
              </Button>
            </TooltipWrapper>
          </div>
        </div>
      )}
      <div
        ref={setStageEl}
        className="image-preview-checkerboard relative isolate min-h-0 flex-1 overflow-hidden"
      >
        {renderImagePreviewStage({
          status: props.status,
          url: props.url,
          servedFromCache: props.servedFromCache,
          fileName: props.fileName,
          aspectRatio,
          setImgRef,
          stage,
          effectiveMin,
          animationMs,
          gesturesEnabled: props.gesturesEnabled,
          isPanning,
          transformRef,
          onDoubleClick: handleDoubleClick,
          onPanningStart: handlePanningStart,
          onPanningStop: handlePanningStop,
          onTransform: handleTransformed,
          onInit: handleInit,
          onDecodeError: handleDecodeError,
          onNaturalSize: handleNaturalSize,
        })}
      </div>
      {props.compact && caption !== null ? (
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

/** Transient check-icon confirmation on copy success (item 14a) - the repo's existing `copy-text-button.tsx` convention (icon swap, not a label swap). Failure keeps its existing icon + error tooltip. */
function copyButtonIcon(state: "idle" | "copied" | "error"): ReactNode {
  if (state === "copied") return <Check className="size-4" />;
  return <Copy className="size-4" />;
}

function renderImagePreviewStage(args: {
  readonly status: ImagePreviewStatus;
  readonly url: string | null;
  /** Ticket 07 closing E2E item: skips `ImageStageImg`'s entrance fade for a cache hit, in both branches below. */
  readonly servedFromCache: boolean;
  readonly fileName: string;
  readonly aspectRatio: number | null;
  readonly setImgRef: (el: HTMLImageElement | null) => void;
  readonly stage: StageReadiness;
  /** Review finding #7: never greater than the current fit, so a huge image's fit is always within interactive zoom-out range. */
  readonly effectiveMin: number;
  readonly animationMs: number;
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
  /** Review finding #4: fires once at mount with the ref RZPP never passes to `onTransform` for the initial transform. */
  readonly onInit: (ref: ReactZoomPanPinchRef) => void;
  readonly onDecodeError: () => void;
  readonly onNaturalSize: (size: ContainerSize) => void;
}): ReactNode {
  // eslint-disable-next-line no-console -- ticket-07 temporary trace, see report to coordinator
  console.debug("[ticket07-trace] render-stage", {
    status: args.status,
    url: args.url,
    servedFromCache: args.servedFromCache,
    stageKind: args.stage.kind,
  });
  if (args.status === "ready" && args.url !== null) {
    if (args.stage.kind === "measuring") {
      // Stage not yet laid out - keep the skeleton up rather than flash an
      // unconstrained image (video symptom #1).
      return renderSkeleton(args.aspectRatio);
    }
    if (args.stage.kind === "no-dimensions") {
      // `meta` never declared width/height (a dimension-less SVG, review
      // finding #6) - render constrained via CSS with no transform until
      // `onNaturalSize` reports a decoded size (this same `<img>` element),
      // at which point the stage recomputes as `ready` and this branch is
      // replaced by the transform-enabled one below. A genuinely
      // dimensionless decode (0x0) never calls back, so this stays the
      // permanent, correct fallback for that file.
      return (
        <div className="flex size-full items-center justify-center p-2">
          <ImageStageImg
            url={args.url}
            fileName={args.fileName}
            servedFromCache={args.servedFromCache}
            setImgRef={args.setImgRef}
            onDecodeError={args.onDecodeError}
            onNaturalSize={args.onNaturalSize}
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
        minScale={args.effectiveMin}
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
          // Library default is `disabled: true` (review finding #1) - a
          // partial config object merges OVER that default, so an ordinary
          // two-finger trackpad pan stayed rejected until this was explicit.
          disabled: false,
          velocityDisabled: true,
        }}
        pinch={{
          step: 5,
        }}
        doubleClick={{
          disabled: true,
        }}
        // Review finding #4: the "0ms everywhere" echo-safety premise (used
        // by `ImageDiffView`'s reentrancy guard) is only exhaustive if EVERY
        // library-owned animation is pinned to the same duration - these two
        // default to 200ms regardless of our own explicit `animationTime`
        // args, and can fire after a pinch/pan settles out of bounds.
        zoomAnimation={{ animationTime: args.animationMs }}
        autoAlignment={{ animationTime: args.animationMs }}
        onTransform={args.onTransform}
        onInit={args.onInit}
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
              servedFromCache={args.servedFromCache}
              setImgRef={args.setImgRef}
              onDecodeError={args.onDecodeError}
              onNaturalSize={args.onNaturalSize}
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

// Temporary ticket-07 trace state: tags each real DOM `<img>` node with a
// stable id so the console trace can distinguish "same element, effect
// replayed" (StrictMode) from "a genuinely different element mounted".
// Removed together with the rest of this instrumentation.
let ticket07NodeIdCounter = 0;
const ticket07NodeIds = new WeakMap<HTMLImageElement, number>();
function ticket07NodeId(el: HTMLImageElement): number {
  const existing = ticket07NodeIds.get(el);
  if (existing !== undefined) return existing;
  ticket07NodeIdCounter += 1;
  ticket07NodeIds.set(el, ticket07NodeIdCounter);
  return ticket07NodeIdCounter;
}

function ImageStageImg(props: {
  readonly url: string;
  readonly fileName: string;
  /** Ticket 07 closing E2E item: see {@link ImagePreviewProps.servedFromCache}. */
  readonly servedFromCache: boolean;
  readonly setImgRef: (el: HTMLImageElement | null) => void;
  readonly onDecodeError: () => void;
  /** Review finding #6: reports the blob-URL `<img>`'s own decoded natural size, the only way to fit/pan/zoom a host-reported-dimensionless file (every SVG). Ignored (never called) for a genuinely 0x0 decode. */
  readonly onNaturalSize: (size: ContainerSize) => void;
  readonly className: string;
}): ReactNode {
  // Skeleton -> image cross-fade (UI polish requirement #4): opacity-only,
  // <=150ms, and SKIPPED for an already-cached URL. `useLayoutEffect`, not
  // `useEffect` (review finding #8): a passive effect runs AFTER the
  // browser paints, so a cached remount still flashed one hidden frame
  // before the fade; layout timing reads/applies the skip before that
  // paint.
  //
  // Two independent cache-hit signals, both checked (ticket 07 closing E2E
  // item): `img.complete` catches a genuinely fast decode on the SAME `<img>`
  // element within this session, but a BRAND-NEW element (a fresh remount -
  // a different pane, a switched file and back) always starts
  // `complete === false` even when the underlying bytes are already
  // resident, because browser decode state lives on the ELEMENT, not the
  // URL - that per-element signal can never carry "already resident" across
  // a remount. `props.servedFromCache` is the asset layer's OWN knowledge
  // of exactly that (a hit against the shared blob cache), independent of
  // any particular `<img>` element's decode history.
  const { setImgRef, onNaturalSize, servedFromCache } = props;
  const [loaded, setLoaded] = useState(false);
  const localImgRef = useRef<HTMLImageElement | null>(null);
  const setImgEl = useCallback(
    (el: HTMLImageElement | null): void => {
      // eslint-disable-next-line no-console -- ticket-07 temporary trace, see report to coordinator
      console.debug("[ticket07-trace] img-ref", {
        phase: el === null ? "detach" : "attach",
        nodeId: el === null ? null : ticket07NodeId(el),
        url: props.url,
      });
      setImgRef(el);
      localImgRef.current = el;
    },
    [setImgRef, props.url],
  );
  const reportNaturalSizeIfKnown = useCallback((): void => {
    const el = localImgRef.current;
    if (el === null || el.naturalWidth <= 0 || el.naturalHeight <= 0) return;
    onNaturalSize({ width: el.naturalWidth, height: el.naturalHeight });
  }, [onNaturalSize]);
  useLayoutEffect(() => {
    const complete = servedFromCache || localImgRef.current?.complete === true;
    // eslint-disable-next-line no-console -- ticket-07 temporary trace, see report to coordinator
    console.debug("[ticket07-trace] image-stage-img-layout-effect", {
      url: props.url,
      nodeId:
        localImgRef.current === null
          ? null
          : ticket07NodeId(localImgRef.current),
      servedFromCache,
      imgComplete: localImgRef.current?.complete,
      resolvedComplete: complete,
    });
    setLoaded(complete);
    if (complete) reportNaturalSizeIfKnown();
  }, [props.url, servedFromCache, reportNaturalSizeIfKnown]);
  // Ground truth, every commit (no deps): what's actually on the DOM node
  // right now, independent of what the skip-decision effect above computed.
  useLayoutEffect(() => {
    // eslint-disable-next-line no-console -- ticket-07 temporary trace, see report to coordinator
    console.debug("[ticket07-trace] dom-commit", {
      url: props.url,
      nodeId:
        localImgRef.current === null
          ? null
          : ticket07NodeId(localImgRef.current),
      loaded,
      actualClassName: localImgRef.current?.className,
    });
  });
  const handleLoad = useCallback((): void => {
    setLoaded(true);
    reportNaturalSizeIfKnown();
  }, [reportNaturalSizeIfKnown]);

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
