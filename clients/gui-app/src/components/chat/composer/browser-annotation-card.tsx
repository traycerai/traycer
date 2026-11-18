import { ImageOff, X } from "lucide-react";
import type { CanvasAnnotationRecord } from "@traycer/protocol/persistence/epic/messages";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { type ScopedImageBytesFetcher } from "@/lib/attachments/image-blob-cache";
import { useImageBlobUrl } from "@/lib/attachments/use-image-blob-url";
import { useLiveBrowserSession } from "@/lib/browser-view/sessions/use-live-browser-session";
import {
  formatAnnotationCounts,
  type BrowserAnnotationRecord,
} from "@/lib/browser-view/annotation/browser-annotation-record";
import {
  ANNOTATION_STALENESS_COPY,
  annotationStalenessHint,
} from "@/lib/browser-view/annotation/browser-annotation-staleness";
import { cn } from "@/lib/utils";

interface AnnotationCardProps {
  readonly record: BrowserAnnotationRecord;
  readonly onRemove: ((annotationId: string) => void) | null;
  readonly imageFetcher: ScopedImageBytesFetcher;
  readonly sessionObjectUrl: (hash: string) => string | null;
  readonly targetControl?: ReactNode;
}

export function BrowserAnnotationCard(props: AnnotationCardProps) {
  return "tabId" in props.record ? (
    <BrowserSourceAnnotationCard {...props} record={props.record} />
  ) : (
    <CanvasAnnotationCard {...props} record={props.record} />
  );
}

function BrowserSourceAnnotationCard(
  props: Omit<AnnotationCardProps, "record"> & {
    readonly record: Extract<
      BrowserAnnotationRecord,
      { source: { kind: "browser" } }
    >;
  },
) {
  const { record, onRemove, imageFetcher } = props;
  // Resolved across every open coordinator, not the surrounding sessions
  // context: an annotation taken on one host is attached to a chat that may be
  // pinned to another (see `browserSessionAcrossCoordinators`).
  const session = useLiveBrowserSession(record.source.sessionId);
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
  const staleness = annotationStalenessHint(
    record,
    session === null ? null : [session],
  );
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
        data-annotation-tab={record.source.tabId}
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
                staleness !== null && "text-warning-foreground",
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
            variant="muted"
            size="icon-xs"
            aria-label="Remove annotation"
            className="shrink-0 opacity-50 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
            onClick={() => onRemove(record.annotationId)}
          >
            <X />
          </Button>
        )}
      </div>
    </TooltipWrapper>
  );
}

function CanvasAnnotationCard(
  props: Omit<AnnotationCardProps, "record"> & {
    readonly record: CanvasAnnotationRecord;
  },
) {
  const { record } = props;
  const blobUrl = useImageBlobUrl(
    record.imageHash,
    "image/png",
    props.imageFetcher,
  );
  const src =
    (record.imageHash === null
      ? null
      : props.sessionObjectUrl(record.imageHash)) ?? blobUrl;
  const source = record.source;
  const element = record.elements.at(0);
  const quote = element?.textRange?.quote;
  const label =
    quote ?? element?.accessibleName ?? element?.textPreview ?? record.comment;
  const board = source.boardPath.split("/").at(-1) ?? source.boardPath;
  return (
    <div
      data-testid="browser-annotation-card"
      data-annotation-id={record.annotationId}
      data-annotation-source="canvas"
      className="group flex max-w-sm shrink-0 items-center gap-2 rounded-lg bg-foreground/5 p-1 pe-1.5"
    >
      <div className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded bg-foreground/8">
        {src === null ? (
          <ImageOff className="size-4 text-muted-foreground" />
        ) : (
          <img src={src} alt="" className="size-full object-cover" />
        )}
      </div>
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-ui-sm font-medium">
          {board}
          {element === undefined ? "" : ` · ${element.tagName}`}
        </span>
        <TooltipWrapper label={label} side="top" sideOffset={6} align="start">
          <span className="max-w-64 truncate text-ui-xs text-muted-foreground">
            {label}
          </span>
        </TooltipWrapper>
        {props.targetControl}
      </div>
      {props.onRemove === null ? null : (
        <Button
          type="button"
          variant="muted"
          size="icon-xs"
          aria-label="Remove annotation"
          onClick={() => props.onRemove?.(record.annotationId)}
        >
          <X />
        </Button>
      )}
    </div>
  );
}
