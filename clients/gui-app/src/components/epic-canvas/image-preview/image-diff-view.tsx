import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import type { ReactZoomPanPinchRef } from "react-zoom-pan-pinch";
import { FileMinus, FilePlus, Maximize2, Minus, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { BinaryPlaceholder } from "@/components/epic-canvas/binary-placeholder";
import { isImageAssetPath } from "@/lib/assets/image-extension-allowlist";
import { cn } from "@/lib/utils";
import {
  useImageAsset,
  type ImageAssetMeta,
  type ImageAssetRequest,
  type UseImageAssetResult,
} from "@/hooks/assets/use-image-asset";
import { ImagePreview, type ImagePreviewStatus } from "./image-preview";
import {
  clampPositionToVisibleBounds,
  fitScaleFor,
  MAX_SCALE,
  MIN_SCALE,
  SCALE_EPSILON,
  ZOOM_STEP,
  type ImagePreviewTransformReport,
  type ImagePreviewTransformState,
} from "./image-preview-transform";

/**
 * A side's own current scale and interactive bounds - populated straight
 * from that side's OWN reported {@link ImagePreviewTransformReport},
 * published at init (RZPP applies its initial transform without firing
 * `onTransform`, so waiting for a transform event would leave this at the
 * default) and on every subsequent transform. Never derived from the OTHER
 * side's numbers.
 */
interface SideBounds {
  readonly scale: number;
  readonly minScale: number;
}

const DEFAULT_SIDE_BOUNDS: SideBounds = {
  scale: 1,
  minScale: MIN_SCALE,
};

/**
 * An ACTIVE side blocks the shared zoom-out button once it's at ITS OWN
 * floor (that floor can be below the constant `MIN_SCALE`). `active` means
 * "has a currently mounted, reporting `ImagePreview`" - NOT "the git stage
 * exists": a non-image side or one that's fallen back to `BinaryPlaceholder`
 * never mounts one, so the `active &&` short-circuit below keeps its bounds
 * (whatever they last held, possibly stale from an earlier activation) from
 * ever being read.
 */
function sideAtMin(active: boolean, bounds: SideBounds): boolean {
  return active && bounds.scale <= bounds.minScale + SCALE_EPSILON;
}

// `maxScale` isn't part of `SideBounds` - every side's TransformWrapper is
// configured with the same constant MAX_SCALE (only minScale varies per
// side's own image dimensions), so the ceiling check compares against it
// directly rather than threading an always-identical value through state.
function sideAtMax(active: boolean, bounds: SideBounds): boolean {
  return active && bounds.scale >= MAX_SCALE - SCALE_EPSILON;
}

/**
 * A side's own derived Fit/Actual-size mode - reported by that side's
 * `ImagePreview` instance (which already computes this correctly for
 * itself), never re-derived or manually toggled here.
 */
interface SideMode {
  readonly isFitted: boolean;
  readonly isActualSize: boolean;
}

const DEFAULT_SIDE_MODE: SideMode = { isFitted: true, isActualSize: false };

/**
 * The shared toolbar's pressed state: pressed iff every ACTIVE side reports
 * itself in that mode. `active`, not `exists` - a missing (Added/Deleted)
 * side correctly never blocks the derivation, but neither may a side that
 * exists as a git stage yet never mounts an `ImagePreview` (a non-image
 * side, or one that's failed to `BinaryPlaceholder`) - its stale/default
 * mode would otherwise permanently block the SURVIVING side's own pressed
 * state from ever showing.
 *
 * When NEITHER side is active, the "every active side agrees" quantifier is
 * vacuously true for BOTH `isFitted` and `isActualSize` at once - Fit and
 * Actual-size would show pressed simultaneously with no image on screen to
 * justify either. Falls back to `DEFAULT_SIDE_MODE` explicitly instead, the
 * same "nothing is happening" baseline already used everywhere else in this
 * file.
 */
function combinedMode(
  oldActive: boolean,
  oldMode: SideMode,
  newActive: boolean,
  newMode: SideMode,
): SideMode {
  if (!oldActive && !newActive) return DEFAULT_SIDE_MODE;
  return {
    isFitted:
      (!oldActive || oldMode.isFitted) && (!newActive || newMode.isFitted),
    isActualSize:
      (!oldActive || oldMode.isActualSize) &&
      (!newActive || newMode.isActualSize),
  };
}

/** `meta`'s own width/height ratio, or `null` when either dimension is unknown (a dimensionless SVG, or the header hasn't arrived yet). */
function aspectRatioOf(meta: ImageAssetMeta | null): number | null {
  if (meta === null) return null;
  if (meta.width === null || meta.height === null) return null;
  if (meta.width <= 0 || meta.height <= 0) return null;
  return meta.width / meta.height;
}

/**
 * The COMPACT root's own width:height ratio for a CSS `aspect-ratio` style
 * (Codex re-review, #3773298843) - `null` when neither side has a usable
 * ratio (both dimensionless, or still loading), the caller's cue to fall
 * back to a fixed-vh height instead.
 *
 * The two sides render at roughly HALF the root's own width each (both
 * `flex-1` in the row below), so a side needing `height = (width/2) / ratio`
 * to show uncropped drives the root's OWN ratio as `width / height`, i.e.
 * `2 * ratio` for that side - using whichever side needs MORE height per
 * unit width (the smaller of the two ratios) so neither side is cropped by
 * the resulting box.
 */
function compactAspectRatio(
  oldMeta: ImageAssetMeta | null,
  newMeta: ImageAssetMeta | null,
): number | null {
  const oldRatio = aspectRatioOf(oldMeta);
  const newRatio = aspectRatioOf(newMeta);
  if (oldRatio === null && newRatio === null) return null;
  return 2 * Math.min(oldRatio ?? Infinity, newRatio ?? Infinity);
}

interface CompactRootSizing {
  readonly className: string;
  readonly style: CSSProperties | undefined;
}

/**
 * The compact root's own height (Codex re-review, #3773015605's follow-up
 * #3773298843): a definite `h-full` needs a definite ancestor height, which
 * a bundle row never provides on its own - but a FIXED px/rem value is a
 * `gui-app/AGENTS.md` fluid-layout violation regardless of what fills it
 * (an upscaled icon in a mostly-empty box on a small image, or an
 * always-320px band on every row on a tall viewport). An `aspect-ratio` box
 * with `w-full` has a DEFINITE computed height derived from the image's own
 * decoded dimensions - snug for a small/wide image, capped by
 * `max-h-[min(45vh,20rem)]` (this repo's existing viewport-cap convention,
 * `git-diff-repo-switcher.tsx`) for a tall one. Falls back to a fixed-vh
 * (never px/rem) height only when NEITHER side has decoded dimensions yet
 * to derive a ratio from.
 *
 * `min-h-24` (sol re-review, #3773298843's follow-up): a panoramic/sprite-
 * strip ratio (e.g. 4000x100) can derive a root height BELOW each compact
 * `ImagePreview`'s own non-shrinking `h-6` caption, collapsing the
 * `min-h-0 flex-1` image stage to zero beneath it - a valid image renders
 * blank. This is a CHROME-driven floor, not a primary sizing mechanism: it
 * only ever binds in that degenerate regime (`aspect-ratio`/`max-height`
 * govern every normal case), the same shape as the fluid-layout rule's own
 * icon/touch-target carve-out for small chrome dimensions - stated
 * explicitly here since this rule has now been litigated twice on this
 * file.
 */
function compactRootSizing(
  compact: boolean,
  oldMeta: ImageAssetMeta | null,
  newMeta: ImageAssetMeta | null,
): CompactRootSizing {
  if (!compact) return { className: "h-full", style: undefined };
  const ratio = compactAspectRatio(oldMeta, newMeta);
  if (ratio === null)
    return { className: "h-[45vh] overflow-hidden", style: undefined };
  return {
    className: "max-h-[min(45vh,20rem)] min-h-24 overflow-hidden",
    style: { aspectRatio: `${ratio}` },
  };
}

export interface ImageDiffViewProps {
  readonly runningDir: string;
  readonly filePath: string;
  readonly previousPath: string | null;
  /**
   * `gitImageDiffRevisionKey(file, headSha)` - the SAME value the caller
   * already uses as this component's own `key=` (remount-on-revision-change,
   * PR review P1). Threaded into each side's git request too, as
   * `coalesceRevision`, because the `key=` remount alone doesn't close the
   * gap when a SEPARATE, still-mounted consumer of the identical (path,
   * stage) at the OLD revision keeps that revision's shared pre-header
   * subscription alive (e.g. the same file open in two panes, one remounts
   * before the other's git-status catches up) - without this, the
   * remounted side's fresh `useImageAsset` call would still coalesce onto
   * that surviving old-revision subscription and replay its stale header
   * (sol re-review).
   */
  readonly revisionKey: string;
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
 *   `setTransform` - exact for same-dimension sides. `setTransform` calls
 *   the library's `setState` directly and bypasses `limitToBounds` entirely,
 *   so for mismatched dimensions the mirrored position is clamped against
 *   the peer's OWN live bounds first - sane containment only (ticket 07: "do
 *   not over-engineer sub-pixel alignment for mismatched dimensions"), never
 *   a reimplementation of the library's padding-aware bounds engine.
 * - A PROGRAMMATIC transform (this side's own resize-refit, or a
 *   double-click) is never mirrored at all: each side recomputes its own
 *   fit/actual-size independently instead.
 * Compact (bundle) variant: static fit only, no toolbar, no gestures -
 * matches decision #18's affordance-free intent.
 */
export function ImageDiffView(props: ImageDiffViewProps): ReactNode {
  const oldTransformRef = useRef<ReactZoomPanPinchRef | null>(null);
  const newTransformRef = useRef<ReactZoomPanPinchRef | null>(null);
  // Per-side pending count, same shape and same constraints as
  // `ImagePreview`'s own `pendingProgrammaticCountRef` (see its comment) -
  // incremented before this side is told to change (by `dualDispatch` or a
  // peer's `mirrorTransform`), decremented when that side's own
  // `onTransform` is consumed. Both `ImageDiffSide` instances are ALWAYS
  // mounted with `animationMs={0}` below, so the single-synchronous-
  // callback assumption always holds here.
  const oldPendingSyncRef = useRef(0);
  const newPendingSyncRef = useRef(0);
  // Per-side, never a single shared value, and never manually toggled - this
  // component previously kept its OWN `isFitted`/`isActualSize` booleans,
  // unconditionally cleared by every gesture callback, which could drift
  // from the real transforms: a pinch that lands exactly at scale 1, or back
  // at the fit transform, left the matching button unpressed. Each side's
  // `ImagePreview` already derives its own mode correctly - these just
  // mirror what it reports, and the toolbar's actual pressed state below is
  // COMPUTED from them, never stored.
  const [oldMode, setOldMode] = useState<SideMode>(DEFAULT_SIDE_MODE);
  const [newMode, setNewMode] = useState<SideMode>(DEFAULT_SIDE_MODE);
  // Per-side, never a single shared value: each side can have its own
  // natural size and therefore its own fit/interactive floor, so the shared
  // zoom buttons must disable when EITHER side is at ITS OWN boundary, not
  // some averaged/last-writer value.
  const [oldBounds, setOldBounds] = useState<SideBounds>(DEFAULT_SIDE_BOUNDS);
  const [newBounds, setNewBounds] = useState<SideBounds>(DEFAULT_SIDE_BOUNDS);

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
      coalesceRevision: props.revisionKey,
    };
  }, [
    props.oldStage,
    oldIsImageSide,
    props.runningDir,
    props.filePath,
    props.previousPath,
    props.revisionKey,
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
      coalesceRevision: props.revisionKey,
    };
  }, [
    props.newStage,
    newIsImageSide,
    props.runningDir,
    props.filePath,
    props.previousPath,
    props.revisionKey,
  ]);

  const oldAsset = useImageAsset(oldRequest);
  const newAsset = useImageAsset(newRequest);

  // "The git stage is non-null" (`oldSideExists` above) is NOT "this side
  // currently has a mounted, reporting `ImagePreview`" - a non-image side
  // (renders `BinaryPlaceholder`, e.g.
  // `old.txt -> new.png`) or a side that fails to `fallback` never mounts
  // one, so its default `isActualSize: false`/default bounds would
  // otherwise permanently block the SURVIVING side's pressed state and
  // zoom-boundary checks. Mode/bounds aggregation below gates on THIS, not
  // on `oldSideExists`/`newSideExists` (which stay correct for the
  // Added/Deleted empty-state decision - unrelated).
  const oldActive = oldIsImageSide && oldAsset.status === "ready";
  const newActive = newIsImageSide && newAsset.status === "ready";

  // `report.origin` distinguishes a genuine user GESTURE on THIS side from
  // a PROGRAMMATIC transform `ImagePreview` issued itself - its own
  // autonomous resize-refit, most importantly, which recomputes THIS
  // side's own correct fit for its own new size and must never be read as
  // "the user manually zoomed away" or mirrored onto the differently-sized
  // peer (that would stomp the peer's own correct fit). Bounds AND mode
  // tracking run UNCONDITIONALLY though - even a programmatic refit
  // changes this side's own current scale/floor/fitted-ness, and the
  // shared toolbar/zoom-boundary state must reflect that regardless of
  // origin. Fires once at init too, which is exactly how
  // `oldBounds`/`newBounds`/`oldMode`/`newMode` learn a side's
  // TRUE starting values instead of sitting at the defaults.
  const handleOldTransform = useCallback(
    (report: ImagePreviewTransformReport): void => {
      setOldBounds({
        scale: report.state.scale,
        minScale: report.minScale,
      });
      setOldMode({
        isFitted: report.isFitted,
        isActualSize: report.isActualSize,
      });
      if (oldPendingSyncRef.current > 0) {
        oldPendingSyncRef.current -= 1;
        return;
      }
      if (report.origin === "gesture") {
        mirrorTransform(newPendingSyncRef, newTransformRef, report.state);
      }
    },
    [],
  );
  const handleNewTransform = useCallback(
    (report: ImagePreviewTransformReport): void => {
      setNewBounds({
        scale: report.state.scale,
        minScale: report.minScale,
      });
      setNewMode({
        isFitted: report.isFitted,
        isActualSize: report.isActualSize,
      });
      if (newPendingSyncRef.current > 0) {
        newPendingSyncRef.current -= 1;
        return;
      }
      if (report.origin === "gesture") {
        mirrorTransform(oldPendingSyncRef, oldTransformRef, report.state);
      }
    },
    [],
  );

  // A toolbar action fits/zooms BOTH sides independently and instantly
  // (`animationTime: 0`) - each computes its own correct transform from its
  // own natural size, never a shared number forced onto a differently-sized
  // peer. Each side's own pending count (not a shared bracket) is
  // incremented here so the per-side `onTransform` this triggers doesn't
  // ALSO mirror one side's raw numbers onto the other - only incremented
  // once the ref is confirmed present, so a not-yet-mounted side can never
  // leave a stuck count blocking a later genuine gesture. Neither handler
  // below manually sets fit/actual-size mode - each side's own
  // `onTransform` firing synchronously as part of this call
  // reports its TRUE resulting mode back through `handleOldTransform`/
  // `handleNewTransform` above.
  const dualDispatch = useCallback(
    (action: (instance: ReactZoomPanPinchRef) => void): void => {
      dispatchToSide(oldTransformRef, oldPendingSyncRef, action);
      dispatchToSide(newTransformRef, newPendingSyncRef, action);
    },
    [],
  );

  const handleFit = useCallback(() => {
    dualDispatch((instance) => fitInstance(instance));
  }, [dualDispatch]);
  const handleActualSize = useCallback(() => {
    dualDispatch((instance) => instance.centerView(1, 0));
  }, [dualDispatch]);
  const handleZoomIn = useCallback(() => {
    dualDispatch((instance) => instance.zoomIn(ZOOM_STEP, 0));
  }, [dualDispatch]);
  const handleZoomOut = useCallback(() => {
    dualDispatch((instance) => instance.zoomOut(ZOOM_STEP, 0));
  }, [dualDispatch]);

  // Matches the shared toolbar's own instant dual-dispatch (image-preview
  // decision log) rather than letting one side's internal handler run solo
  // - that would mirror a raw fit/actual transform computed for THIS side's
  // size onto the differently-sized peer instead of the peer computing its
  // own.
  // Derived, never stored. Gated on `oldActive`/`newActive`, never
  // `oldSideExists`/`newSideExists` - a non-image or failed side must never
  // count toward "every side agrees".
  const { isFitted, isActualSize } = combinedMode(
    oldActive,
    oldMode,
    newActive,
    newMode,
  );

  const handleSideDoubleClick = useCallback((): void => {
    if (isFitted) {
      handleActualSize();
      return;
    }
    handleFit();
  }, [isFitted, handleActualSize, handleFit]);

  const zoomDisabled = !oldActive && !newActive;
  // Disable when EITHER ACTIVE side is at ITS OWN boundary - each side's
  // `minScale` already reflects its own fit floor, so this stays correct
  // even when the two sides' floors differ; a non-image or failed side never
  // contributes since `sideAtMin`/`sideAtMax` gate on `active` before
  // reading its bounds at all.
  const zoomOutDisabled =
    zoomDisabled ||
    sideAtMin(oldActive, oldBounds) ||
    sideAtMin(newActive, newBounds);
  const zoomInDisabled =
    zoomDisabled ||
    sideAtMax(oldActive, oldBounds) ||
    sideAtMax(newActive, newBounds);
  const rootSizing = compactRootSizing(
    props.compact,
    oldAsset.meta,
    newAsset.meta,
  );

  return (
    <div
      className={cn("flex min-h-0 w-full flex-col", rootSizing.className)}
      style={rootSizing.style}
    >
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
                aria-label="Actual size"
                className="min-w-12 tabular-nums"
              >
                100%
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
            doubleClickOverride={props.compact ? null : handleSideDoubleClick}
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
            doubleClickOverride={props.compact ? null : handleSideDoubleClick}
            onOpenExternally={props.onOpenExternally}
            openExternallyOpening={props.openExternallyOpening}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * Calls `action` on `ref`'s resolved instance, incrementing `pendingRef`
 * FIRST - but only once the ref is confirmed present, so a not-yet-mounted
 * side can never leave a stuck pending count that would block a later
 * genuine gesture from ever mirroring again.
 */
function dispatchToSide(
  ref: RefObject<ReactZoomPanPinchRef | null>,
  pendingRef: { current: number },
  action: (instance: ReactZoomPanPinchRef) => void,
): void {
  const instance = ref.current;
  if (instance === null) return;
  pendingRef.current += 1;
  action(instance);
}

/** Independently fits `instance`'s own content to its own wrapper - never a shared number forced onto a differently-sized peer (ticket 07). */
function fitInstance(instance: ReactZoomPanPinchRef): void {
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

/**
 * Mirrors `state` onto `peerRef`, clamped to the peer's OWN live bounds -
 * `setTransform` calls the library's `setState` directly, bypassing
 * `limitToBounds` entirely (verified against installed v4.0.4), so an
 * unclamped mirror onto a smaller peer could push its content wholly
 * offscreen OR past its own interactive zoom range. Scale clamps to the
 * peer's OWN `setup.minScale`/`maxScale` FIRST (two grossly mismatched sides
 * can have different bounds, and `setTransform` would otherwise happily
 * apply a scale the peer could never reach through its own toolbar/
 * gestures) - position bounds are then computed at that CLAMPED scale, not
 * the raw mirrored one, so they describe the transform actually being
 * applied. Sane containment only, not a reimplementation of the library's
 * padding-aware bounds engine (ticket 07: "do not over-engineer sub-pixel
 * alignment for mismatched dimensions"). Increments the PEER's own pending
 * count, never a shared synchronous bracket - the peer's `onTransform`
 * consuming it is what suppresses the echo, correct however long delivery
 * takes.
 */
function mirrorTransform(
  peerPendingRef: { current: number },
  peerRef: RefObject<ReactZoomPanPinchRef | null>,
  state: ImagePreviewTransformState,
): void {
  const peer = peerRef.current;
  if (peer === null) return;
  const { minScale, maxScale } = peer.instance.setup;
  const scale = Math.min(Math.max(state.scale, minScale), maxScale);
  const wrapper = peer.instance.wrapperComponent;
  const content = peer.instance.contentComponent;
  peerPendingRef.current += 1;
  if (wrapper === null || content === null) {
    peer.setTransform(state.positionX, state.positionY, scale, 0);
  } else {
    // `getBoundingClientRect()` for the wrapper, `offsetWidth`/`offsetHeight`
    // for the content - the same measurement split `fitInstance` above uses.
    const wrapperRect = wrapper.getBoundingClientRect();
    const scaledWidth = content.offsetWidth * scale;
    const scaledHeight = content.offsetHeight * scale;
    peer.setTransform(
      clampPositionToVisibleBounds(
        state.positionX,
        wrapperRect.width,
        scaledWidth,
      ),
      clampPositionToVisibleBounds(
        state.positionY,
        wrapperRect.height,
        scaledHeight,
      ),
      scale,
      0,
    );
  }
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
  readonly onTransformChange: (report: ImagePreviewTransformReport) => void;
  readonly doubleClickOverride: (() => void) | null;
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
      servedFromCache={asset.servedFromCache}
      fileName={props.effectivePath}
      compact
      gesturesEnabled={!props.compact}
      // One motion language within the diff view (ticket 07, better-ui
      // audit): double-click is intercepted entirely by
      // `doubleClickOverride` - it drives the shared toolbar's own
      // dual-dispatch instead of this instance's internal
      // fit/actual handler, so both sides move together and each computes
      // its own fit, matching the toolbar exactly rather than mirroring one
      // side's raw numbers onto the other.
      animationMs={0}
      transformRef={props.compact ? null : props.transformRef}
      onTransformChange={props.compact ? null : props.onTransformChange}
      doubleClickOverride={props.doubleClickOverride}
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
