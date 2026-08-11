import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
  type UIEvent,
} from "react";
import { Copy, ZoomIn, ZoomOut } from "lucide-react";
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

/** `fallback` is a distinct branch the caller renders instead (`BinaryPlaceholder`) - never a status this viewer itself handles. */
export type ImagePreviewStatus = "loading" | "header" | "ready";

export interface ImagePreviewProps {
  readonly status: ImagePreviewStatus;
  /** Blob URL; non-null only once `status === "ready"`. */
  readonly url: string | null;
  readonly meta: ImageAssetMeta | null;
  /** Alt text and the file name copy/report actions would reference. */
  readonly fileName: string;
  /** Drops the toolbar (zoom + copy) for bundle/diff use (ticket 05) - image-preview decision log, decision #18. */
  readonly compact: boolean;
  /**
   * Controlled zoom for callers that link multiple instances (ticket 05's
   * `ImageDiffView`) - `null` manages `fit` internally (today's only other
   * caller, the workspace tile). A non-null value always wins over internal
   * state, so a caller can also use it to freeze zoom (pass a fixed value
   * with `onFitOverrideChange: null`) without a separate "disabled" prop.
   */
  readonly fitOverride: ImagePreviewFit | null;
  /** Called instead of internal state when `fitOverride` drives this instance; `null` when uncontrolled or frozen. */
  readonly onFitOverrideChange: ((fit: ImagePreviewFit) => void) | null;
  /**
   * Callback ref (not a ref object - see `useNativeDivScrollRestoration`'s
   * doc comment) to the scrollable image stage, for callers that sync scroll
   * across linked instances (ticket 05, decision #17); `null` when unneeded.
   */
  readonly scrollContainerRef:
    ((element: HTMLDivElement | null) => void) | null;
  readonly onScroll: ((event: UIEvent<HTMLDivElement>) => void) | null;
}

export type ImagePreviewFit = "fit" | "actual";

const COPY_FEEDBACK_RESET_MS = 1500;

export function ImagePreview(props: ImagePreviewProps) {
  // Destructured (not `props.scrollContainerRef`/`props.onScroll` inline in
  // the JSX below) so the ref-safety linter can see these are plain values,
  // not a live ref read during render - same reasoning as
  // `diff-content-primitive.tsx`'s `scrollContainerRef` destructure.
  const { scrollContainerRef, onScroll, onFitOverrideChange } = props;
  const [internalFit, setInternalFit] = useState<ImagePreviewFit>("fit");
  const fit = props.fitOverride ?? internalFit;
  const [copyFeedback, setCopyFeedback] = useState<"idle" | "copied" | "error">(
    "idle",
  );
  const imgRef = useRef<HTMLImageElement | null>(null);
  const copyResetTimerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    return () => window.clearTimeout(copyResetTimerRef.current);
  }, []);

  const toggleFit = useCallback(() => {
    const next: ImagePreviewFit = fit === "fit" ? "actual" : "fit";
    if (onFitOverrideChange !== null) {
      onFitOverrideChange(next);
      return;
    }
    setInternalFit(next);
  }, [fit, onFitOverrideChange]);

  const handleImageClick = useCallback(() => {
    if (props.status === "ready") toggleFit();
  }, [props.status, toggleFit]);

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

  const aspectRatio = imagePreviewAspectRatio(props.meta);
  const caption = formatImagePreviewCaption(props.meta);

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      {props.compact ? null : (
        <div
          role="toolbar"
          aria-label="Image preview controls"
          className="flex h-8 shrink-0 items-center justify-end gap-1 border-b border-canvas-border/70 px-2"
        >
          <TooltipWrapper
            label={fit === "fit" ? "Zoom to 100%" : "Zoom to fit"}
            side="top"
            sideOffset={undefined}
            align={undefined}
          >
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-pressed={fit === "actual"}
              disabled={props.status !== "ready"}
              onClick={toggleFit}
            >
              {fit === "fit" ? (
                <ZoomIn className="size-4" />
              ) : (
                <ZoomOut className="size-4" />
              )}
            </Button>
          </TooltipWrapper>
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
              disabled={props.status !== "ready"}
              onClick={handleCopy}
            >
              <Copy className="size-4" />
            </Button>
          </TooltipWrapper>
        </div>
      )}
      <div
        ref={scrollContainerRef}
        onScroll={onScroll ?? undefined}
        className={cn(
          "image-preview-checkerboard relative min-h-0 flex-1",
          fit === "fit" ? "flex items-center justify-center" : "overflow-auto",
        )}
      >
        {renderImagePreviewStage({
          status: props.status,
          url: props.url,
          fileName: props.fileName,
          fit,
          aspectRatio,
          imgRef,
          onImageClick: handleImageClick,
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
  readonly fit: ImagePreviewFit;
  readonly aspectRatio: number | null;
  readonly imgRef: RefObject<HTMLImageElement | null>;
  readonly onImageClick: () => void;
}): ReactNode {
  if (args.status === "ready" && args.url !== null) {
    return (
      <button
        type="button"
        onClick={args.onImageClick}
        aria-pressed={args.fit === "actual"}
        aria-label={args.fit === "fit" ? "Zoom to 100%" : "Zoom to fit"}
        className={cn(
          "flex max-h-full max-w-full items-center justify-center border-0 bg-transparent p-0",
          args.fit === "fit" ? "cursor-zoom-in" : "m-2 cursor-zoom-out",
        )}
      >
        <img
          ref={args.imgRef}
          src={args.url}
          alt={args.fileName}
          draggable={false}
          className={cn(
            "block",
            args.fit === "fit" && "max-h-full max-w-full object-contain",
          )}
        />
      </button>
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
  return (
    <div className="flex size-full items-center justify-center p-2">
      {args.aspectRatio !== null ? (
        <div
          data-testid="image-preview-skeleton"
          className="max-h-full max-w-full"
          style={{ aspectRatio: String(args.aspectRatio), width: "100%" }}
        />
      ) : null}
    </div>
  );
}
