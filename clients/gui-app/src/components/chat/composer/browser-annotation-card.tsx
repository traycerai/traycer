import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useMaybeBrowserSessionsContext } from "@/components/epic-canvas/renderers/browser-sessions-context";
import { type ImageBytesFetcher } from "@/lib/attachments/image-blob-cache";
import { useImageBlobUrl } from "@/lib/attachments/use-image-blob-url";
import {
  formatAnnotationCounts,
  type BrowserAnnotationRecord,
} from "@/lib/browser-view/annotation/browser-annotation-record";
import {
  ANNOTATION_STALENESS_COPY,
  annotationStalenessHint,
} from "@/lib/browser-view/annotation/browser-annotation-staleness";
import { cn } from "@/lib/utils";

export function BrowserAnnotationCard(props: {
  readonly record: BrowserAnnotationRecord;
  readonly onRemove: ((annotationId: string) => void) | null;
  readonly imageFetcher: ImageBytesFetcher;
  readonly sessionObjectUrl: (hash: string) => string | null;
}) {
  const { record, onRemove, imageFetcher } = props;
  const sessions = useMaybeBrowserSessionsContext();
  const sessionUrl = props.sessionObjectUrl(record.imageHash);
  const blobUrl = useImageBlobUrl(record.imageHash, "image/png", imageFetcher);
  const src = sessionUrl ?? blobUrl;
  const counts = formatAnnotationCounts(record.counts);
  const dropped =
    record.droppedElementCount > 0
      ? `${record.droppedElementCount} over budget`
      : "";
  const countsLine = [counts, dropped]
    .filter((part) => part.length > 0)
    .join(", ");
  const staleness = annotationStalenessHint(record, sessions?.items ?? null);
  const stalenessCopy =
    staleness === null ? "" : ANNOTATION_STALENESS_COPY[staleness];
  const secondary = stalenessCopy.length > 0 ? stalenessCopy : countsLine;
  const comment =
    record.comment.trim().length > 0 ? record.comment.trim() : "No comment";
  const title = [comment, countsLine, stalenessCopy]
    .filter((part) => part.length > 0)
    .join(" · ");

  return (
    <TooltipWrapper label={title} side="top" sideOffset={6} align="start">
      <div
        data-testid="browser-annotation-card"
        data-annotation-id={record.annotationId}
        data-annotation-tab={record.tabId}
        className="group flex h-10 max-w-[min(70vw,16rem)] shrink-0 items-center gap-2 rounded-lg bg-foreground/5 p-1 pe-1.5"
      >
        <div
          className={cn(
            "relative size-8 shrink-0 overflow-hidden rounded bg-foreground/5",
            src === null && "bg-foreground/8",
          )}
        >
          {src === null ? (
            <div
              className="size-full animate-pulse bg-foreground/10"
              aria-hidden
            />
          ) : (
            <img
              src={src}
              alt=""
              className="size-full object-cover outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10"
            />
          )}
        </div>
        <div className="flex min-w-0 flex-1 items-baseline gap-1">
          <p className="min-w-0 truncate text-ui-sm font-medium text-foreground">
            {comment}
          </p>
          {secondary.length > 0 ? (
            <span
              className={cn(
                "max-w-24 shrink-0 truncate text-ui-xs text-muted-foreground",
                staleness !== null && "text-amber-600 dark:text-amber-400",
              )}
            >
              · {secondary}
            </span>
          ) : null}
          {stalenessCopy.length > 0 && countsLine.length > 0 ? (
            <span className="sr-only">{countsLine}</span>
          ) : null}
        </div>
        {onRemove === null ? null : (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Remove annotation"
            className="shrink-0 text-muted-foreground opacity-50 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
            onClick={() => onRemove(record.annotationId)}
          >
            <X />
          </Button>
        )}
      </div>
    </TooltipWrapper>
  );
}
