import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type UIEvent,
} from "react";
import { FileMinus, FilePlus, ZoomIn, ZoomOut } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { BinaryPlaceholder } from "@/components/epic-canvas/binary-placeholder";
import { isImageAssetPath } from "@/lib/assets/image-extension-allowlist";
import {
  useImageAsset,
  type ImageAssetRequest,
  type ImageAssetState,
} from "@/hooks/assets/use-image-asset";
import {
  ImagePreview,
  type ImagePreviewFit,
  type ImagePreviewStatus,
} from "./image-preview";

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
  /** Drops the shared toolbar (zoom toggle, Conflicted badge) for bundle use (image-preview decision log, decision #18). */
  readonly compact: boolean;
  /** `null` when there is no single unambiguous file on disk to open for a per-side failure (e.g. a bundle row). */
  readonly onOpenExternally: (() => void) | null;
  readonly openExternallyOpening: boolean;
}

/**
 * Two `ImagePreview` instances side by side (image-preview decision log,
 * decision #9), always two columns - a missing side renders an Added/Deleted
 * empty state rather than collapsing to one column. Zoom is LINKED: one
 * shared `fit` state drives both sides via `ImagePreview`'s controlled
 * `fitOverride` (decision #17); scroll is synced between the two sides'
 * scrollable containers with a simple echo-guarded mirror, matching the
 * assignment's "two refs + one scroll handler pair" scope (no library).
 */
export function ImageDiffView(props: ImageDiffViewProps): ReactNode {
  const [sharedFit, setSharedFit] = useState<ImagePreviewFit>("fit");

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

  // Callback refs (not ref objects) so they can be forwarded into
  // `ImagePreview`'s `scrollContainerRef` prop without tripping the
  // "no refs during render" rule - mirrors
  // `useNativeDivScrollRestoration`'s documented pattern.
  const oldElementRef = useRef<HTMLDivElement | null>(null);
  const newElementRef = useRef<HTMLDivElement | null>(null);
  // Echo guard: a programmatic scroll set on the mirror below would
  // otherwise re-fire that side's own onScroll and bounce back and forth.
  const syncingScrollRef = useRef(false);

  const oldScrollContainerRef = useCallback(
    (element: HTMLDivElement | null) => {
      oldElementRef.current = element;
    },
    [],
  );
  const newScrollContainerRef = useCallback(
    (element: HTMLDivElement | null) => {
      newElementRef.current = element;
    },
    [],
  );

  const handleOldScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    mirrorScroll(syncingScrollRef, event.currentTarget, newElementRef.current);
  }, []);
  const handleNewScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    mirrorScroll(syncingScrollRef, event.currentTarget, oldElementRef.current);
  }, []);

  const toggleSharedFit = useCallback(() => {
    setSharedFit((current) => (current === "fit" ? "actual" : "fit"));
  }, []);

  const zoomDisabled =
    oldAsset.status !== "ready" && newAsset.status !== "ready";

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      {props.compact ? null : (
        <div
          role="toolbar"
          aria-label="Image diff controls"
          className="flex h-8 shrink-0 items-center justify-between gap-1 border-b border-canvas-border/70 px-2"
        >
          <div className="flex min-w-0 items-center gap-1">
            {props.conflicted ? (
              <Badge variant="outline">Conflicted</Badge>
            ) : null}
          </div>
          <TooltipWrapper
            label={sharedFit === "fit" ? "Zoom to 100%" : "Zoom to fit"}
            side="top"
            sideOffset={undefined}
            align={undefined}
          >
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-pressed={sharedFit === "actual"}
              disabled={zoomDisabled}
              onClick={toggleSharedFit}
            >
              {sharedFit === "fit" ? (
                <ZoomIn className="size-4" />
              ) : (
                <ZoomOut className="size-4" />
              )}
            </Button>
          </TooltipWrapper>
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
            fit={sharedFit}
            onFitChange={setSharedFit}
            scrollContainerRef={oldScrollContainerRef}
            onScroll={handleOldScroll}
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
            fit={sharedFit}
            onFitChange={setSharedFit}
            scrollContainerRef={newScrollContainerRef}
            onScroll={handleNewScroll}
            onOpenExternally={props.onOpenExternally}
            openExternallyOpening={props.openExternallyOpening}
          />
        </div>
      </div>
    </div>
  );
}

function mirrorScroll(
  syncingRef: { current: boolean },
  source: HTMLDivElement,
  mirror: HTMLDivElement | null,
): void {
  if (syncingRef.current || mirror === null) return;
  syncingRef.current = true;
  mirror.scrollTop = source.scrollTop;
  mirror.scrollLeft = source.scrollLeft;
  syncingRef.current = false;
}

function ImageDiffSide(props: {
  /** Whether this side has a fetchable identity at all (its `stage` is non-null) - `false` renders the Added/Deleted empty state, never a fetch. */
  readonly sideExists: boolean;
  /** Whether THIS side's own effective path (pre-landing review, P0: a rename can straddle the allowlist) is an image extension - `false` renders the non-image placeholder, never a fetch. */
  readonly isImageSide: boolean;
  readonly effectivePath: string;
  readonly asset: ImageAssetState;
  readonly emptyLabel: "Added" | "Deleted";
  readonly compact: boolean;
  readonly fit: ImagePreviewFit;
  readonly onFitChange: (fit: ImagePreviewFit) => void;
  readonly scrollContainerRef: (element: HTMLDivElement | null) => void;
  readonly onScroll: (event: UIEvent<HTMLDivElement>) => void;
  readonly onOpenExternally: (() => void) | null;
  readonly openExternallyOpening: boolean;
}): ReactNode {
  const asset = props.asset;
  // Magic-valid, header-parseable bytes can still fail to DECODE in the
  // browser (pre-landing review, P1) - `<img onError>` has no other signal
  // path, so this side tracks it locally and falls onto the same settled
  // placeholder a stream failure uses. Reset ADJUSTED DURING RENDER (not an
  // effect - react.dev's "adjusting state when a prop changes" pattern) on
  // every new URL, so a decode failure from a superseded fetch never sticks
  // to the next one.
  const [decodeFailed, setDecodeFailed] = useState(false);
  const [trackedUrl, setTrackedUrl] = useState(asset.url);
  if (asset.url !== trackedUrl) {
    setTrackedUrl(asset.url);
    setDecodeFailed(false);
  }
  const handleDecodeError = useCallback(() => setDecodeFailed(true), []);

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
  if (asset.status === "fallback" || decodeFailed) {
    return (
      <BinaryPlaceholder
        fileName={props.effectivePath}
        sizeBytes={asset.totalBytes}
        reason={decodeFailed ? "Preview could not be decoded." : asset.reason}
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
      fitOverride={props.compact ? "fit" : props.fit}
      onFitOverrideChange={props.compact ? null : props.onFitChange}
      scrollContainerRef={props.scrollContainerRef}
      onScroll={props.onScroll}
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
