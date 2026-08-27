import { useRef } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogTrigger } from "@/components/ui/dialog";
import {
  ExpandedImageDialogContent,
  type ExpandedImageState,
} from "@/components/chat/expanded-image-dialog";
import type { ComposerImageAtom } from "@/lib/composer/image-atoms";
import { type ImageBytesFetcher } from "@/lib/attachments/image-blob-cache";
import { useImageBlobUrlState } from "@/lib/attachments/use-image-blob-url";
import type { ImageAttachmentDisplayLabel } from "@/lib/composer/image-attachment-labels";
import { fallbackImageAttachmentDisplayLabel } from "@/lib/composer/image-attachment-labels";

import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
export interface ImageAttachmentChipProps {
  atom: ComposerImageAtom;
  displayLabel: ImageAttachmentDisplayLabel | undefined;
  onRemove: (id: string) => void;
  /** Streams a hash's bytes when no synchronous source is available. */
  fetcher: ImageBytesFetcher;
  /** Same-session synchronous object-URL for a hash, or null if unseen. */
  sessionObjectUrl: (hash: string) => string | null;
}

export function ImageAttachmentChip(props: ImageAttachmentChipProps) {
  const { atom, displayLabel, onRemove, fetcher, sessionObjectUrl } = props;
  const label =
    displayLabel ??
    fallbackImageAttachmentDisplayLabel({
      id: atom.id,
      fileName: atom.fileName,
    });
  const alt = atom.fileName.length > 0 ? atom.fileName : "Pasted image";
  const wrapperRef = useRef<HTMLDivElement>(null);
  const dataUrl =
    atom.b64content === null
      ? null
      : `data:${atom.mimeType};base64,${atom.b64content}`;
  // Priority: a same-session paste's synchronous object-URL (no flash), then the
  // async blob stream for a restored hash, then chat's inline base64. The hook is
  // called unconditionally; for a base64-only atom (`hash === null`) it returns
  // null, so the `dataUrl` fallback keeps chat paste instant.
  const sessionUrl = atom.hash === null ? null : sessionObjectUrl(atom.hash);
  const blob = useImageBlobUrlState(atom.hash, atom.mimeType, fetcher, null);
  const src = sessionUrl ?? blob.url ?? dataUrl;
  // A restored hash's bytes are typed by the serving host's sniff, which can
  // disagree with the stored claim and decides whether Copy is offered at all.
  // The claim only stands where it IS the source: a same-session paste or
  // inline base64.
  const mediaType =
    sessionUrl === null && blob.status === "ready"
      ? blob.mediaType
      : atom.mimeType;
  let expandedImage: ExpandedImageState;
  if (src !== null) {
    expandedImage = { status: "ready", src, mediaType };
  } else if (blob.status === "unavailable") {
    expandedImage = { status: "unavailable" };
  } else {
    expandedImage = { status: "loading" };
  }
  return (
    <Dialog>
      <div
        ref={wrapperRef}
        className="group relative size-14 shrink-0 overflow-hidden rounded-md border border-border/70 bg-foreground/5"
      >
        <span
          className="pointer-events-none absolute left-0.5 top-0.5 z-10 flex h-4 min-w-4 items-center justify-center rounded-sm border border-border/70 bg-background/90 px-1 text-[0.625rem] font-semibold leading-none text-foreground shadow-sm"
          data-composer-image-strip-badge={label.badgeLabel}
        >
          {label.badgeLabel}
        </span>
        {/* Scoped to the open/zoom trigger, not the chip: the chip also
              holds the Remove button, and a chip-wide trigger meant focusing
              Remove surfaced the filename tooltip. */}
        <TooltipWrapper
          label={label.title}
          side="top"
          sideOffset={undefined}
          align={undefined}
        >
          <DialogTrigger asChild>
            <button
              type="button"
              aria-label={`Open ${label.ariaLabel}`}
              className="block size-full cursor-zoom-in focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {src === null ? (
                <div
                  className="size-full animate-pulse bg-foreground/10"
                  aria-hidden
                />
              ) : (
                <img
                  src={src}
                  alt={alt}
                  className="size-full object-cover"
                  draggable={false}
                />
              )}
            </button>
          </DialogTrigger>
        </TooltipWrapper>
        <Button
          type="button"
          size="icon"
          variant="secondary"
          aria-label={`Remove ${label.ariaLabel}`}
          onPointerDown={(event) => {
            event.stopPropagation();
          }}
          onMouseDown={(event) => {
            event.stopPropagation();
          }}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onRemove(atom.id);
          }}
          className="absolute right-0.5 top-0.5 z-10 size-4 rounded-full p-0 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
        >
          <X className="size-3" aria-hidden />
        </Button>
      </div>
      <ExpandedImageDialogContent
        title={label.title}
        alt={alt}
        image={expandedImage}
        suggestedName={atom.fileName.length > 0 ? atom.fileName : null}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const shell = wrapperRef.current?.closest<HTMLElement>(
            "[data-composer-shell]",
          );
          const editor = shell?.querySelector<HTMLElement>(
            "[data-composer-editor]",
          );
          editor?.focus();
        }}
      />
    </Dialog>
  );
}
