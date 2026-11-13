import { useMemo, useRef, useState, type ReactNode } from "react";
import { ImageOff } from "lucide-react";

import { Dialog } from "@/components/ui/dialog";
import {
  ExpandedImageBody,
  ExpandedImageDialogContent,
  type ImageSetViewerState,
} from "@/components/chat/expanded-image-dialog";
import {
  type AttachmentBlobSrcState,
  useChatAttachmentBlobSrc,
} from "@/lib/attachments/use-attachment-blob-src";
import {
  buildImageAttachmentDisplayLabels,
  fallbackImageAttachmentDisplayLabel,
  type ImageAttachmentDisplayLabel,
} from "@/lib/composer/image-attachment-labels";
import type { BrowserAnnotationRecord } from "@traycer/protocol/persistence/epic/schemas";
import type { Attachment, ImageAttachment } from "@/lib/composer/types";
import { cn } from "@/lib/utils";

import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
interface UserMessageAttachmentGalleryProps {
  readonly align: "start" | "end";
  readonly attachments: ReadonlyArray<Attachment>;
  /**
   * Annotation crops are rendered by the reference chips, not here, so the
   * gallery hides the attachments they own. Taken as the message's own array
   * (a stable reference) and reduced to hashes inside the memo below - passing
   * a freshly built `Set` defeated the memo on every parent render.
   */
  readonly browserAnnotations:
    | ReadonlyArray<BrowserAnnotationRecord>
    | undefined;
}

export function UserMessageAttachmentGallery({
  align,
  attachments,
  browserAnnotations,
}: UserMessageAttachmentGalleryProps): ReactNode {
  const images = useMemo(() => {
    const excludeHashes = new Set(
      (browserAnnotations ?? []).map((annotation) => annotation.imageHash),
    );
    const imageAttachments = attachments
      .filter(isImageAttachment)
      .filter(
        (attachment) =>
          attachment.hash === null || !excludeHashes.has(attachment.hash),
      );
    const labels = buildImageAttachmentDisplayLabels(
      imageAttachments.map((attachment, index) => ({
        id: String(index),
        fileName: attachment.name ?? "image",
      })),
    );
    return imageAttachments.map((attachment, index) => ({
      // Prefix with the stable list index so two images that share name+size and
      // both lack hash/dataUrl can't collide into the same React key.
      key: `${index}:${imageAttachmentRenderKey(attachment)}`,
      attachment,
      label: labels.get(String(index)),
    }));
  }, [attachments, browserAnnotations]);
  const [viewer, setViewer] = useState<ImageSetViewerState>({
    open: false,
    index: 0,
  });
  const galleryRef = useRef<HTMLDivElement>(null);
  if (images.length === 0) return null;
  const shown = images.at(viewer.index);
  return (
    <Dialog
      open={viewer.open}
      onOpenChange={(open) => setViewer((current) => ({ ...current, open }))}
    >
      <div
        ref={galleryRef}
        className={cn(
          "mb-2 flex w-full flex-wrap gap-1.5",
          align === "start" ? "justify-start" : "justify-end",
        )}
      >
        {images.map((image, index) => (
          <ImageAttachmentThumb
            key={image.key}
            attachment={image.attachment}
            displayLabel={image.label}
            onOpen={() => setViewer({ open: true, index })}
          />
        ))}
      </div>
      {shown === undefined ? null : (
        <ExpandedImageDialogContent
          title={imageAttachmentAlt(shown.attachment)}
          navigation={{
            index: viewer.index,
            count: images.length,
            onNavigate: (index) => setViewer({ open: true, index }),
          }}
          // Focus returns to the thumbnail of the image last shown, which
          // after stepping through the set is not the one that opened it.
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const thumbs = galleryRef.current?.querySelectorAll<HTMLElement>(
              "[data-user-message-image-thumb]",
            );
            thumbs?.[viewer.index]?.focus();
          }}
        >
          {/* Keyed so each image opens fitted, never at its neighbour's zoom. */}
          <ExpandedAttachmentImage
            key={shown.key}
            attachment={shown.attachment}
          />
        </ExpandedImageDialogContent>
      )}
    </Dialog>
  );
}

function imageAttachmentAlt(attachment: ImageAttachment): string {
  return attachment.name || "Image attachment";
}

function isImageAttachment(
  attachment: Attachment,
): attachment is ImageAttachment {
  return attachment.kind === "image";
}

function imageAttachmentRenderKey(attachment: ImageAttachment): string {
  return [
    attachment.name ?? "image",
    attachment.size ?? 0,
    attachment.hash ?? attachment.dataUrl?.slice(-64) ?? "",
  ].join(":");
}

/**
 * Resolves the image source: persisted images (`hash`) fetch their bytes off the
 * chat plane (this chat's tab host, epic doc as the legacy fallback) into a
 * shared blob URL via the content-addressed cache; draft/optimistic images
 * render their inline `dataUrl` directly. A persisted hash transitions from
 * loading to unavailable after its grace period while remaining able to recover
 * when bytes arrive later.
 */
function useImageAttachmentSrc(
  attachment: ImageAttachment,
): AttachmentBlobSrcState {
  return useChatAttachmentBlobSrc(
    attachment.hash,
    attachment.mediaType,
    attachment.dataUrl,
  );
}

function ImageAttachmentThumb({
  attachment,
  displayLabel,
  onOpen,
}: {
  readonly attachment: ImageAttachment;
  readonly displayLabel: ImageAttachmentDisplayLabel | undefined;
  readonly onOpen: () => void;
}): ReactNode {
  const alt = imageAttachmentAlt(attachment);
  const label =
    displayLabel ??
    fallbackImageAttachmentDisplayLabel({ id: "fallback", fileName: alt });
  const image = useImageAttachmentSrc(attachment);
  const triggerAriaLabel =
    image.status === "unavailable"
      ? `Open ${label.ariaLabel} (image unavailable)`
      : `Open ${label.ariaLabel}`;
  let thumbnail: ReactNode;
  if (image.status === "loading") {
    thumbnail = (
      // muted-fill-ok: fills the timeline trigger below, same non-raised chat surface
      <div className="size-full animate-pulse bg-muted/60" aria-hidden />
    );
  } else if (image.status === "unavailable") {
    thumbnail = (
      <div
        // muted-fill-ok: fills the timeline trigger above, same non-raised chat surface
        className="flex size-full items-center justify-center bg-muted/60 text-muted-foreground"
        data-user-message-image-unavailable
        aria-hidden
      >
        <ImageOff className="size-4" />
      </div>
    );
  } else {
    thumbnail = (
      <img
        src={image.src}
        alt={alt}
        className="size-full object-cover transition-transform group-hover:scale-102"
        draggable={false}
      />
    );
  }

  return (
    <TooltipWrapper
      label={label.title}
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      <button
        type="button"
        aria-label={triggerAriaLabel}
        aria-haspopup="dialog"
        data-user-message-image-thumb=""
        onClick={onOpen}
        // muted-fill-ok: thumb trigger sits on the chat canvas backdrop / user bubble, not a raised surface
        className="group relative size-12 overflow-hidden rounded-md border border-border/70 bg-muted/40 outline-none transition-colors hover:border-foreground/40 focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span
          className="pointer-events-none absolute left-0.5 top-0.5 z-10 flex h-4 min-w-4 items-center justify-center rounded-sm border border-border/70 bg-background/90 px-1 text-[0.625rem] font-semibold leading-none text-foreground shadow-sm"
          data-user-message-image-badge={label.badgeLabel}
        >
          {label.badgeLabel}
        </span>
        {thumbnail}
      </button>
    </TooltipWrapper>
  );
}

/**
 * The shown image of the set. It resolves its own source, sharing the cache
 * entry its thumbnail already holds, so only the image on screen is read.
 */
function ExpandedAttachmentImage({
  attachment,
}: {
  readonly attachment: ImageAttachment;
}): ReactNode {
  const image = useImageAttachmentSrc(attachment);
  return (
    <ExpandedImageBody
      alt={imageAttachmentAlt(attachment)}
      image={image}
      suggestedName={attachment.name ?? null}
    />
  );
}
