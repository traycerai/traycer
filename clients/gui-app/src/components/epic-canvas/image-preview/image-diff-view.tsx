import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type UIEvent,
} from "react";
import {
  FileMinus,
  FilePlus,
  FileQuestionMarkIcon,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
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

  const oldRequest = useMemo<ImageAssetRequest | null>(() => {
    if (props.oldStage === null) return null;
    return {
      method: "git",
      runningDir: props.runningDir,
      filePath: props.filePath,
      previousPath: props.previousPath,
      side: "old",
      stage: props.oldStage,
    };
  }, [props.oldStage, props.runningDir, props.filePath, props.previousPath]);

  const newRequest = useMemo<ImageAssetRequest | null>(() => {
    if (props.newStage === null) return null;
    return {
      method: "git",
      runningDir: props.runningDir,
      filePath: props.filePath,
      previousPath: props.previousPath,
      side: "new",
      stage: props.newStage,
    };
  }, [props.newStage, props.runningDir, props.filePath, props.previousPath]);

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
            request={oldRequest}
            asset={oldAsset}
            emptyLabel="Added"
            fileName={props.fileName}
            compact={props.compact}
            fit={sharedFit}
            onFitChange={setSharedFit}
            scrollContainerRef={oldScrollContainerRef}
            onScroll={handleOldScroll}
          />
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <ImageDiffSide
            request={newRequest}
            asset={newAsset}
            emptyLabel="Deleted"
            fileName={props.fileName}
            compact={props.compact}
            fit={sharedFit}
            onFitChange={setSharedFit}
            scrollContainerRef={newScrollContainerRef}
            onScroll={handleNewScroll}
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
  readonly request: ImageAssetRequest | null;
  readonly asset: ImageAssetState;
  readonly emptyLabel: "Added" | "Deleted";
  readonly fileName: string;
  readonly compact: boolean;
  readonly fit: ImagePreviewFit;
  readonly onFitChange: (fit: ImagePreviewFit) => void;
  readonly scrollContainerRef: (element: HTMLDivElement | null) => void;
  readonly onScroll: (event: UIEvent<HTMLDivElement>) => void;
}): ReactNode {
  if (props.request === null) {
    return <ImageDiffEmptyState label={props.emptyLabel} />;
  }
  const asset = props.asset;
  if (asset.status === "fallback") {
    return <ImageDiffSideFallback reason={asset.reason} />;
  }
  const status: ImagePreviewStatus = asset.status;
  return (
    <ImagePreview
      status={status}
      url={asset.url}
      meta={asset.meta}
      fileName={props.fileName}
      compact
      fitOverride={props.compact ? "fit" : props.fit}
      onFitOverrideChange={props.compact ? null : props.onFitChange}
      scrollContainerRef={props.scrollContainerRef}
      onScroll={props.onScroll}
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

function ImageDiffSideFallback(props: {
  readonly reason: string | null;
}): ReactNode {
  return (
    <div className="flex size-full flex-col items-center justify-center gap-2 p-4 text-center text-ui-xs text-muted-foreground">
      <FileQuestionMarkIcon className="size-8" />
      {props.reason !== null ? <p>{props.reason}</p> : null}
    </div>
  );
}
