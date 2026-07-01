import { useMemo, type ReactNode } from "react";

import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useAttachmentBlobSrc } from "@/lib/attachments/use-attachment-blob-src";
import {
  buildImageAttachmentDisplayLabels,
  fallbackImageAttachmentDisplayLabel,
  type ImageAttachmentDisplayLabel,
} from "@/lib/composer/image-attachment-labels";
import type { Attachment, ImageAttachment } from "@/lib/composer/types";
import { cn } from "@/lib/utils";

interface UserMessageAttachmentGalleryProps {
  readonly align: "start" | "end";
  readonly attachments: ReadonlyArray<Attachment>;
}

export function UserMessageAttachmentGallery({
  align,
  attachments,
}: UserMessageAttachmentGalleryProps): ReactNode {
  const images = useMemo(() => {
    const imageAttachments = attachments.filter(isImageAttachment);
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
  }, [attachments]);
  if (images.length === 0) return null;
  return (
    <div
      className={cn(
        "mb-2 flex w-full flex-wrap gap-1.5",
        align === "start" ? "justify-start" : "justify-end",
      )}
    >
      {images.map((image) => (
        <ImageAttachmentThumb
          key={image.key}
          attachment={image.attachment}
          displayLabel={image.label}
        />
      ))}
    </div>
  );
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
 * Resolves the image source: persisted images (`hash`) stream their bytes from
 * the epic doc's attachments map into a shared blob URL via the content-addressed
 * cache; draft/optimistic images render their inline `dataUrl` directly. Returns
 * null while a persisted image's blob is still loading.
 */
function useImageAttachmentSrc(attachment: ImageAttachment): string | null {
  return useAttachmentBlobSrc(
    attachment.hash,
    attachment.mediaType,
    attachment.dataUrl,
  );
}

function ImageAttachmentThumb({
  attachment,
  displayLabel,
}: {
  readonly attachment: ImageAttachment;
  readonly displayLabel: ImageAttachmentDisplayLabel | undefined;
}): ReactNode {
  const alt = attachment.name || "Image attachment";
  const label =
    displayLabel ??
    fallbackImageAttachmentDisplayLabel({ id: "fallback", fileName: alt });
  const src = useImageAttachmentSrc(attachment);
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          aria-label={`Open ${label.ariaLabel}`}
          title={label.title}
          className="group relative size-12 overflow-hidden rounded-md border border-border/70 bg-muted/40 outline-none transition-colors hover:border-foreground/40 focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span
            className="pointer-events-none absolute left-0.5 top-0.5 z-10 flex h-4 min-w-4 items-center justify-center rounded-sm border border-border/70 bg-background/90 px-1 text-[0.625rem] font-semibold leading-none text-foreground shadow-sm"
            data-user-message-image-badge={label.badgeLabel}
          >
            {label.badgeLabel}
          </span>
          {src === null ? (
            <div className="size-full animate-pulse bg-muted/60" aria-hidden />
          ) : (
            <img
              src={src}
              alt={alt}
              className="size-full object-cover transition-transform group-hover:scale-[1.02]"
              draggable={false}
            />
          )}
        </button>
      </DialogTrigger>
      <DialogContent
        className="w-[min(95vw,80rem)] max-w-[min(95vw,80rem)] bg-popover/95 p-2 sm:max-w-[min(95vw,80rem)]"
        showCloseButton
      >
        <DialogTitle className="sr-only">{alt}</DialogTitle>
        {src === null ? (
          <div
            className="aspect-video w-full animate-pulse rounded-lg bg-muted/60"
            aria-hidden
          />
        ) : (
          <img
            src={src}
            alt={alt}
            className="block max-h-[min(90vh,52rem)] w-full rounded-lg object-contain"
            draggable={false}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
