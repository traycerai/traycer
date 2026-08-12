import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import type { ReactZoomPanPinchRef } from "react-zoom-pan-pinch";
import {
  FileMinus,
  FilePlus,
  Maximize2,
  Minus,
  Plus,
  RotateCcw,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { BinaryPlaceholder } from "@/components/epic-canvas/binary-placeholder";
import { isImageAssetPath } from "@/lib/assets/image-extension-allowlist";
import {
  useImageAsset,
  type ImageAssetRequest,
  type UseImageAssetResult,
} from "@/hooks/assets/use-image-asset";
import { ImagePreview, type ImagePreviewStatus } from "./image-preview";
import {
  fitScaleFor,
  MAX_SCALE,
  MIN_SCALE,
  ZOOM_BOUNDARY_EPSILON,
  ZOOM_STEP,
  type ImagePreviewTransformState,
} from "./image-preview-transform";

export interface ImageDiffViewProps {
  readonly runningDir: string;
  readonly filePath: string;
  readonly previousPath: string | null;
  /** Stage to request the OLD (pre-change) side at; `null` = no old side (Added empty state). */
  readonly oldStage: "staged" | "unstaged" | null;
  /** Stage to request the NEW (post-change) side at; `null` = no new side (Deleted empty state). */
  readonly newStage: "staged" | "unstaged" | null;
  readonly fileName: string;
  readonly conflicted: boolean;
  /** Drops the shared toolbar and all gestures for bundle use - static fit only (image-preview decision log, decision #18; ticket 07). */
  readonly compact: boolean;
  /** `null` when there is no single unambiguous file on disk to open for a per-side failure (e.g. a bundle row). */
  readonly onOpenExternally: (() => void) | null;
  readonly openExternallyOpening: boolean;
}

/**
 * Two `ImagePreview` instances side by side (image-preview decision log,
 * decision #9), always two columns - a missing side renders an Added/Deleted
 * empty state rather than collapsing to one column. Zoom + pan are LINKED
 * (decision #17, rebuilt on `react-zoom-pan-pinch` - ticket 07):
 * - The shared toolbar's fit/actual/zoom buttons drive BOTH sides
 *   independently and instantly (`animationTime: 0`, so `onTransform` fires
 *   once synchronously per side, never mid-animation) - each side computes
 *   its OWN correct fit from its OWN natural image size, not a shared
 *   number forced onto a differently-sized peer.
 * - A GESTURE on either side (drag, pinch, ctrl+wheel) instead mirrors that
 *   side's raw `{scale, positionX, positionY}` onto the peer via
 *   `setTransform` - exact for same-dimension sides, and for mismatched
 *   dimensions simply syncs scale/position with the peer's OWN
 *   `limitToBounds` clamping it into range (ticket 07: "do not over-
 *   engineer sub-pixel alignment for mismatched dimensions").
 * Compact (bundle) variant: static fit only, no toolbar, no gestures -
 * matches decision #18's affordance-free intent.
 */
export function ImageDiffView(props: ImageDiffViewProps): ReactNode {
  const oldTransformRef = useRef<ReactZoomPanPinchRef | null>(null);
  const newTransformRef = useRef<ReactZoomPanPinchRef | null>(null);
  // Echo guard shared by both the gesture-mirror path and the toolbar's own
  // dual-dispatch: a toolbar action already updates both sides correctly
  // and independently, so the mirror below must not also overwrite the
  // peer with the OTHER side's raw numbers while that dispatch is in flight.
  const syncingTransformRef = useRef(false);
  // Drives the shared toolbar's Fit/Actual-size `aria-pressed` state - the
  // active zoom mode must be statically visible (UI polish requirements
  // #6/#7), so a gesture on either side (which desyncs from both) also
  // flips these, not just the toolbar's own buttons. Tracked as two
  // EXPLICIT booleans (not `isActualSize` derived from `scale`): unlike the
  // standalone `ImagePreview`, this component never learns either side's
  // own initial fit scale (that's computed privately inside each instance),
  // so a scale-derived `Math.abs(scale - 1) < epsilon` would read
  // stale-true from `scale`'s `1` default until the first `onTransform`
  // arrives. `scale` still exists below for the zoom-boundary disable
  // check, where a stale default is harmless (both directions stay enabled
  // until a real value arrives).
  const [isFitted, setIsFitted] = useState(true);
  const [isActualSize, setIsActualSize] = useState(false);
  const [scale, setScale] = useState(1);

  // A rename's two sides can straddle the extension allowlist (pre-landing
  // review, P0: `old.png -> new.txt` / `old.txt -> new.png`) - each side is
  // gated against its OWN effective path, never `props.filePath` alone. The
  // old side reads from `previousPath` when the file was renamed (mirrors
  // the host's `previousPath ?? filePath` resolution); the new side is
  // always the current path.
  const oldEffectivePath = props.previousPath ?? props.filePath;
  const newEffectivePath = props.filePath;
  const oldSideExists = props.oldStage !== null;
  const newSideExists = props.newStage !== null;
  const oldIsImageSide = oldSideExists && isImageAssetPath(oldEffectivePath);
  const newIsImageSide = newSideExists && isImageAssetPath(newEffectivePath);

  const oldRequest = useMemo<ImageAssetRequest | null>(() => {
    if (props.oldStage === null || !oldIsImageSide) return null;
    return {
      method: "git",
      runningDir: props.runningDir,
      filePath: props.filePath,
      previousPath: props.previousPath,
      side: "old",
      stage: props.oldStage,
    };
  }, [
    props.oldStage,
    oldIsImageSide,
    props.runningDir,
    props.filePath,
    props.previousPath,
  ]);

  const newRequest = useMemo<ImageAssetRequest | null>(() => {
    if (props.newStage === null || !newIsImageSide) return null;
    return {
      method: "git",
      runningDir: props.runningDir,
      filePath: props.filePath,
      previousPath: props.previousPath,
      side: "new",
      stage: props.newStage,
    };
  }, [
    props.newStage,
    newIsImageSide,
    props.runningDir,
    props.filePath,
    props.previousPath,
  ]);

  const oldAsset = useImageAsset(oldRequest);
  const newAsset = useImageAsset(newRequest);

  const handleOldTransform = useCallback(
    (state: ImagePreviewTransformState): void => {
      setScale(state.scale);
      // Skipped during a toolbar-driven dual-dispatch (see `dualDispatch`
      // below) - that path sets `isFitted`/`isActualSize` explicitly
      // itself, correctly, instead of this generic "any transform change
      // means an intermediate zoom" rule, which only applies to a genuine
      // per-side gesture.
      if (!syncingTransformRef.current) {
        setIsFitted(false);
        setIsActualSize(false);
      }
      mirrorTransform(syncingTransformRef, newTransformRef, state);
    },
    [],
  );
  const handleNewTransform = useCallback(
    (state: ImagePreviewTransformState): void => {
      setScale(state.scale);
      if (!syncingTransformRef.current) {
        setIsFitted(false);
        setIsActualSize(false);
      }
      mirrorTransform(syncingTransformRef, oldTransformRef, state);
    },
    [],
  );

  // A toolbar action fits/zooms BOTH sides independently and instantly
  // (`animationTime: 0`) - each computes its own correct transform from its
  // own natural size, never a shared number forced onto a differently-sized
  // peer. The echo guard is reused here (not just for gestures) so the
  // per-side `onTransform` this triggers doesn't ALSO mirror one side's raw
  // numbers onto the other mid-dispatch.
  const dualDispatch = useCallback(
    (action: (ref: RefObject<ReactZoomPanPinchRef | null>) => void): void => {
      syncingTransformRef.current = true;
      action(oldTransformRef);
      action(newTransformRef);
      syncingTransformRef.current = false;
    },
    [],
  );

  const handleFit = useCallback(() => {
    dualDispatch((ref) => fitSide(ref));
    setIsFitted(true);
    setIsActualSize(false);
  }, [dualDispatch]);
  const handleActualSize = useCallback(() => {
    dualDispatch((ref) => ref.current?.centerView(1, 0));
    setIsFitted(false);
    setIsActualSize(true);
  }, [dualDispatch]);
  const handleZoomIn = useCallback(() => {
    dualDispatch((ref) => ref.current?.zoomIn(ZOOM_STEP, 0));
    setIsFitted(false);
    setIsActualSize(false);
  }, [dualDispatch]);
  const handleZoomOut = useCallback(() => {
    dualDispatch((ref) => ref.current?.zoomOut(ZOOM_STEP, 0));
    setIsFitted(false);
    setIsActualSize(false);
  }, [dualDispatch]);

  const zoomDisabled =
    oldAsset.status !== "ready" && newAsset.status !== "ready";
  const zoomOutDisabled =
    zoomDisabled || scale <= MIN_SCALE + ZOOM_BOUNDARY_EPSILON;
  const zoomInDisabled =
    zoomDisabled || scale >= MAX_SCALE - ZOOM_BOUNDARY_EPSILON;

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      {props.compact ? null : (
        <div
          role="toolbar"
          aria-label="Image diff controls"
          className="relative z-10 flex h-8 shrink-0 items-center justify-between gap-1 border-b border-canvas-border/70 px-2"
        >
          <div className="flex min-w-0 items-center gap-1">
            {props.conflicted ? (
              <Badge variant="outline">Conflicted</Badge>
            ) : null}
          </div>
          <div className="flex items-center gap-1">
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
                aria-label="Actual size"
              >
                <RotateCcw className="size-4" />
              </Button>
            </TooltipWrapper>
          </div>
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col border-r border-canvas-border/70">
          <ImageDiffSide
            sideExists={oldSideExists}
            isImageSide={oldIsImageSide}
            effectivePath={oldEffectivePath}
            asset={oldAsset}
            emptyLabel="Added"
            compact={props.compact}
            transformRef={oldTransformRef}
            onTransformChange={handleOldTransform}
            onOpenExternally={props.onOpenExternally}
            openExternallyOpening={props.openExternallyOpening}
          />
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <ImageDiffSide
            sideExists={newSideExists}
            isImageSide={newIsImageSide}
            effectivePath={newEffectivePath}
            asset={newAsset}
            emptyLabel="Deleted"
            compact={props.compact}
            transformRef={newTransformRef}
            onTransformChange={handleNewTransform}
            onOpenExternally={props.onOpenExternally}
            openExternallyOpening={props.openExternallyOpening}
          />
        </div>
      </div>
    </div>
  );
}

/** Independently fits `ref`'s own content to its own wrapper - never a shared number forced onto a differently-sized peer (ticket 07). */
function fitSide(ref: RefObject<ReactZoomPanPinchRef | null>): void {
  const instance = ref.current;
  if (instance === null) return;
  const wrapper = instance.instance.wrapperComponent;
  const content = instance.instance.contentComponent;
  if (wrapper === null || content === null) return;
  const wrapperRect = wrapper.getBoundingClientRect();
  instance.centerView(
    fitScaleFor(
      { width: wrapperRect.width, height: wrapperRect.height },
      { width: content.offsetWidth, height: content.offsetHeight },
    ),
    0,
  );
}

function mirrorTransform(
  syncingRef: { current: boolean },
  peerRef: RefObject<ReactZoomPanPinchRef | null>,
  state: ImagePreviewTransformState,
): void {
  if (syncingRef.current) return;
  const peer = peerRef.current;
  if (peer === null) return;
  syncingRef.current = true;
  peer.setTransform(state.positionX, state.positionY, state.scale, 0);
  syncingRef.current = false;
}

function ImageDiffSide(props: {
  /** Whether this side has a fetchable identity at all (its `stage` is non-null) - `false` renders the Added/Deleted empty state, never a fetch. */
  readonly sideExists: boolean;
  /** Whether THIS side's own effective path (pre-landing review, P0: a rename can straddle the allowlist) is an image extension - `false` renders the non-image placeholder, never a fetch. */
  readonly isImageSide: boolean;
  readonly effectivePath: string;
  readonly asset: UseImageAssetResult;
  readonly emptyLabel: "Added" | "Deleted";
  readonly compact: boolean;
  readonly transformRef: RefObject<ReactZoomPanPinchRef | null>;
  readonly onTransformChange: (state: ImagePreviewTransformState) => void;
  readonly onOpenExternally: (() => void) | null;
  readonly openExternallyOpening: boolean;
}): ReactNode {
  const asset = props.asset;
  // Magic-valid, header-parseable bytes can still fail to DECODE in the
  // browser (pre-landing review, P1) - `<img onError>` has no other signal
  // path. `reportDecodeFailure` (re-review P1 follow-up) discards the exact
  // cache entry AND transitions the hook's own state to `fallback`, so this
  // side renders straight from `asset.status` like every other failure -
  // no local decode-failed flag to track or reset.
  const handleDecodeError = asset.reportDecodeFailure;

  if (!props.sideExists) {
    return <ImageDiffEmptyState label={props.emptyLabel} />;
  }
  if (!props.isImageSide) {
    return (
      <BinaryPlaceholder
        fileName={props.effectivePath}
        sizeBytes={null}
        reason="This file is not one of the supported image formats."
        onOpenExternally={props.onOpenExternally}
        openExternallyOpening={props.openExternallyOpening}
        compact
      />
    );
  }
  if (asset.status === "fallback") {
    return (
      <BinaryPlaceholder
        fileName={props.effectivePath}
        sizeBytes={asset.totalBytes}
        reason={asset.reason}
        onOpenExternally={props.onOpenExternally}
        openExternallyOpening={props.openExternallyOpening}
        compact
      />
    );
  }
  const status: ImagePreviewStatus = asset.status;
  return (
    <ImagePreview
      status={status}
      url={asset.url}
      meta={asset.meta}
      fileName={props.effectivePath}
      compact
      gesturesEnabled={!props.compact}
      // One motion language within the diff view (ticket 07, better-ui
      // audit): a double-click on either side calls THIS ImagePreview's own
      // internal fit/actual handlers, which must match the shared
      // toolbar's instant dual-dispatch, not the standalone tile's smooth
      // default - a mix of the two would read as inconsistent in the same
      // view.
      animationMs={0}
      transformRef={props.compact ? null : props.transformRef}
      onTransformChange={props.compact ? null : props.onTransformChange}
      onDecodeError={handleDecodeError}
    />
  );
}

function ImageDiffEmptyState(props: {
  readonly label: "Added" | "Deleted";
}): ReactNode {
  const Icon = props.label === "Added" ? FilePlus : FileMinus;
  return (
    <div className="flex size-full flex-col items-center justify-center gap-2 p-4 text-ui-xs text-muted-foreground">
      <Icon className="size-8" />
      <span>{props.label}</span>
    </div>
  );
}
