import type { ReactNode } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  ExpandedImageBody,
  type ExpandedImageState,
} from "@/components/chat/expanded-image-dialog";
import type { ComposerImageAtom } from "@/lib/composer/image-atoms";
import { type ScopedImageBytesFetcher } from "@/lib/attachments/image-blob-cache";
import { useImageBlobUrlState } from "@/lib/attachments/use-image-blob-url";
import type { ImageAttachmentDisplayLabel } from "@/lib/composer/image-attachment-labels";
import { fallbackImageAttachmentDisplayLabel } from "@/lib/composer/image-attachment-labels";

import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";

/** Where a draft image's bytes come from; the chip and the expanded view share it. */
interface ComposerImageSource {
  atom: ComposerImageAtom;
  /** Streams a hash's bytes when no synchronous source is available, scoped to the subject those bytes are authorized against. */
  fetcher: ScopedImageBytesFetcher;
  /** Same-session synchronous object-URL for a hash, or null if unseen. */
  sessionObjectUrl: (hash: string) => string | null;
}

export interface ImageAttachmentChipProps extends ComposerImageSource {
  displayLabel: ImageAttachmentDisplayLabel | undefined;
  onRemove: (id: string) => void;
  /** Opens the strip's viewer at this image. */
  onOpen: () => void;
}

function composerImageAlt(atom: ComposerImageAtom): string {
  return atom.fileName.length > 0 ? atom.fileName : "Pasted image";
}

function useComposerImage(source: ComposerImageSource): ExpandedImageState {
  const { atom, fetcher, sessionObjectUrl } = source;
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
  if (src !== null) return { status: "ready", src, mediaType };
  return blob.status === "unavailable"
    ? { status: "unavailable" }
    : { status: "loading" };
}

export function ImageAttachmentChip(props: ImageAttachmentChipProps) {
  const { atom, displayLabel, onRemove, onOpen } = props;
  const label =
    displayLabel ??
    fallbackImageAttachmentDisplayLabel({
      id: atom.id,
      fileName: atom.fileName,
    });
  const image = useComposerImage(props);
  return (
    <div className="group relative size-14 shrink-0 overflow-hidden rounded-md border border-border/70 bg-foreground/5">
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
        <button
          type="button"
          aria-label={`Open ${label.ariaLabel}`}
          aria-haspopup="dialog"
          onClick={onOpen}
          className="block size-full cursor-zoom-in focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {image.status === "ready" ? (
            <img
              src={image.src}
              alt={composerImageAlt(atom)}
              className="size-full object-cover"
              draggable={false}
            />
          ) : (
            <div
              className="size-full animate-pulse bg-foreground/10"
              aria-hidden
            />
          )}
        </button>
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
        className="absolute right-0.5 top-0.5 z-10 size-4 rounded-full opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
      >
        <X className="size-3" aria-hidden />
      </Button>
    </div>
  );
}

/** The strip's shown image, resolved the way its chip resolves the thumbnail. */
export function ExpandedComposerImage(props: ComposerImageSource): ReactNode {
  const image = useComposerImage(props);
  return (
    <ExpandedImageBody
      alt={composerImageAlt(props.atom)}
      image={image}
      suggestedName={
        props.atom.fileName.length > 0 ? props.atom.fileName : null
      }
    />
  );
}
