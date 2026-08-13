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
import { copyImageToClipboard } from "./image-preview-clipboard";
import {
  DEFAULT_ANIMATION_MS,
  effectiveMinScale,
  fitScaleFor,
  initialFitTransform,
  MAX_SCALE,
  MIN_SCALE,
  transformMatchesFit,
  SCALE_EPSILON,
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
   * than re-derived by the caller; `minScale` is this instance's live
   * interactive floor, published at init (not only on `onTransform` - RZPP
   * applies its initial transform without calling it).
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

// `TransformWrapper` only renders in the `status === "ready"` branch (see
// `renderStage` below), so it fully unmounts and remounts on every
// `ready -> header -> ready` cycle - INCLUDING a refocus re-stat that
// resolves back to the SAME cached `url` (unchanged content identity, the
// common refocus path), which a `url`-keyed reset alone does not see (Codex
// re-review: same bug family as the URL-change case, new trigger). The fresh
// `TransformWrapper` instance fits from scratch regardless, so without this,
// the DOM/library-level transform and the caller's OWN transform state
// (pressed states, zoom-bound disables) would disagree the moment the cycle
// completes. Extracted to its own function (rather than inlined in
// `ImagePreview`) purely to keep that component's branch count under the
// repo's ESLint `complexity` ceiling - a call site adds no complexity to its
// caller, only branches/loops do.
function useResetTransformSyncOnRemount(
  isReady: boolean,
  resetTransformSynced: () => void,
): void {
  const [wasReady, setWasReady] = useState(isReady);
  if (isReady !== wasReady) {
    setWasReady(isReady);
    if (isReady) {
      resetTransformSynced();
    }
  }
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
  // Incremented before every transform this component issues itself,
  // decremented when its own `onTransform` callback is consumed - a COUNT,
  // not a per-call identity, so it's correct only when each issued call
  // delivers exactly one synchronous callback: true at `animationMs=0`
  // against the pinned `react-zoom-pan-pinch` 4.0.4 (proved by the
  // sync-delivery contract test), NOT true for a nonzero `animationMs`
  // (the library calls `onTransform` once per animation frame, so only the
  // first frame consumes the slot) - inert today since the only nonzero-
  // `animationMs` caller never reads `onTransformChange`.
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
  //
  // Reset on `url` change (below, alongside `decodedSize`), not just once
  // per component lifetime: a refocus refresh (`ready` -> `header` ->
  // `ready` with a changed image, same `ImagePreview` instance throughout)
  // used to leave this permanently `true` from the FIRST sync, so the
  // seed-from-`liveFit` render-time adjustment below never re-fired for the
  // new image and every derived pressed/bounds state kept describing the
  // old one.
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
    // `url` is this asset's content identity (a fresh blob URL only for
    // genuinely new/changed bytes - a cache hit against unchanged content
    // reuses the same URL, correctly keeping the transform) - resetting the
    // sync flag here re-arms the seed-from-`liveFit` adjustment for it.
    setTransformSynced(false);
  }
  useResetTransformSyncOnRemount(props.status === "ready", () => {
    setTransformSynced(false);
  });
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
  const isActualSize = Math.abs(transform.scale - 1) < SCALE_EPSILON;

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
    return {
      state,
      origin,
      isFitted: liveFit !== null && transformMatchesFit(state, liveFit),
      isActualSize: Math.abs(state.scale - 1) < SCALE_EPSILON,
      minScale: ref.instance.setup.minScale,
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
  //
  // Seeded from `ref.state` (the library's own just-initialized transform),
  // not the closure's `transform` React state: a refocus refresh remounts
  // `TransformWrapper` (it only renders in the `stage.kind === "ready"`
  // branch, so it unmounts entirely through the intervening `header`
  // status), and this `onInit` fires for that NEW instance before this
  // component is guaranteed to have re-rendered with the matching new
  // `transform` value - reading the library's ref directly is correct
  // regardless of React's own state-update timing.
  function handleInit(ref: ReactZoomPanPinchRef): void {
    onTransformChange?.(buildTransformReport(ref.state, "programmatic", ref));
  }

  const handleDecodeError = useCallback((): void => {
    onDecodeError?.();
  }, [onDecodeError]);

  const handleCopy = useCallback(() => {
    const image = imgRef.current;
    if (image === null) return;
    copyImageToClipboard(image).then(
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
    zoomDisabled || transform.scale <= effectiveMin + SCALE_EPSILON;
  const zoomInDisabled =
    zoomDisabled || transform.scale >= MAX_SCALE - SCALE_EPSILON;

  function renderStage(): ReactNode {
    if (props.status === "ready" && props.url !== null) {
      if (stage.kind === "measuring") {
        // Stage not yet laid out - keep the skeleton up rather than flash an
        // unconstrained image (video symptom #1).
        return renderSkeleton(aspectRatio);
      }
      if (stage.kind === "no-dimensions") {
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
              url={props.url}
              fileName={props.fileName}
              servedFromCache={props.servedFromCache}
              setImgRef={setImgRef}
              onDecodeError={handleDecodeError}
              onNaturalSize={handleNaturalSize}
              className="max-h-full max-w-full object-contain"
            />
          </div>
        );
      }
      return (
        <TransformWrapper
          ref={transformRef}
          initialScale={stage.transform.scale}
          initialPositionX={stage.transform.positionX}
          initialPositionY={stage.transform.positionY}
          minScale={effectiveMin}
          maxScale={MAX_SCALE}
          limitToBounds
          centerOnInit={false}
          smooth
          disabled={!props.gesturesEnabled}
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
          zoomAnimation={{ animationTime: animationMs }}
          autoAlignment={{ animationTime: animationMs }}
          onTransform={handleTransformed}
          onInit={handleInit}
          onPanningStart={handlePanningStart}
          onPanningStop={handlePanningStop}
        >
          <TransformComponent
            wrapperStyle={{ width: "100%", height: "100%" }}
            contentStyle={{
              cursor: panCursor(props.gesturesEnabled, isPanning),
            }}
          >
            <div
              onDoubleClick={
                props.gesturesEnabled
                  ? (event: MouseEvent<HTMLDivElement>) => {
                      event.preventDefault();
                      handleDoubleClick();
                    }
                  : undefined
              }
            >
              <ImageStageImg
                url={props.url}
                fileName={props.fileName}
                servedFromCache={props.servedFromCache}
                setImgRef={setImgRef}
                onDecodeError={handleDecodeError}
                onNaturalSize={handleNaturalSize}
                className="max-w-none"
              />
            </div>
          </TransformComponent>
        </TransformWrapper>
      );
    }
    if (props.status === "loading") {
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
    return renderSkeleton(aspectRatio);
  }

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
                aria-label={copyButtonLabel(copyFeedback)}
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
        {renderStage()}
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
  /** Ticket 07 closing E2E item: see {@link ImagePreviewProps.servedFromCache}. */
  readonly servedFromCache: boolean;
  readonly setImgRef: (el: HTMLImageElement | null) => void;
  readonly onDecodeError: () => void;
  /** Review finding #6: reports the blob-URL `<img>`'s own decoded natural size, the only way to fit/pan/zoom a host-reported-dimensionless file (every SVG). Ignored (never called) for a genuinely 0x0 decode. */
  readonly onNaturalSize: (size: ContainerSize) => void;
  readonly className: string;
}): ReactNode {
  // Skeleton -> image cross-fade (UI polish requirement #4): opacity-only,
  // <=150ms, skipped for a cache hit. `loaded` seeds from `servedFromCache`
  // in the `useState` INITIALIZER, not an effect: a CSS transition fires on
  // any resolved-style change between two style passes regardless of paint
  // timing, so an effect-based correction can still animate 0 -> 100 if
  // some OTHER layout effect forces a style pass in between. Seeding the
  // initial value means the first commit's className is already
  // `opacity-100` for a cache hit - no `opacity-0` value is ever exposed to
  // transition away from. `img.complete` (below) is a second, independent
  // signal for a same-instance fast decode that isn't itself a cache hit.
  const { setImgRef, onNaturalSize, servedFromCache } = props;
  const [loaded, setLoaded] = useState(servedFromCache);
  const localImgRef = useRef<HTMLImageElement | null>(null);
  const setImgEl = useCallback(
    (el: HTMLImageElement | null): void => {
      setImgRef(el);
      localImgRef.current = el;
    },
    [setImgRef],
  );
  const reportNaturalSizeIfKnown = useCallback((): void => {
    const el = localImgRef.current;
    if (el === null || el.naturalWidth <= 0 || el.naturalHeight <= 0) return;
    onNaturalSize({ width: el.naturalWidth, height: el.naturalHeight });
  }, [onNaturalSize]);
  useLayoutEffect(() => {
    const complete = servedFromCache || localImgRef.current?.complete === true;
    setLoaded(complete);
    if (complete) reportNaturalSizeIfKnown();
  }, [props.url, servedFromCache, reportNaturalSizeIfKnown]);
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
