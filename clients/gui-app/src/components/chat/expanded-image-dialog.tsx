import { useRef, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { ImageOff } from "lucide-react";
import { isClipboardImageMediaType } from "@traycer-clients/shared/images/clipboard-image-media";

import { DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useOpenSavedFile } from "@/hooks/files/use-open-saved-file";
import { imageMutationKeys } from "@/lib/query-keys";
import { toastFromRunnerError } from "@/lib/runner-error-toast";

import {
  type ImageAction,
  imageFileName,
  performImageAction,
} from "@/lib/images/perform-image-action";

import { ImageActions } from "./segments/image-actions";

export type ExpandedImageState =
  | { readonly status: "loading" }
  | { readonly status: "unavailable" }
  | {
      readonly status: "ready";
      readonly src: string;
      readonly mediaType: string;
    };

/**
 * The shared expanded view for user-attached images - composer strip chips
 * and sent-message gallery thumbs. Thumbnails stay action-free by design;
 * copy and download live only here, on the expanded image.
 */
export function ExpandedImageDialogContent(props: {
  readonly title: string;
  readonly alt: string;
  readonly image: ExpandedImageState;
  readonly suggestedName: string | null;
  readonly onCloseAutoFocus: ((event: Event) => void) | undefined;
}): ReactNode {
  const image = props.image;
  const contentRef = useRef<HTMLDivElement>(null);

  let body: ReactNode;
  if (image.status === "loading") {
    body = (
      <div
        className="aspect-video w-full animate-pulse rounded-lg bg-foreground/10"
        aria-hidden
      />
    );
  } else if (image.status === "unavailable") {
    body = (
      <div
        className="flex aspect-video w-full flex-col items-center justify-center gap-2 rounded-lg bg-foreground/5 px-4 py-8 text-center text-muted-foreground"
        role="status"
      >
        <ImageOff className="size-8" aria-hidden />
        <p className="text-ui-sm">Image unavailable</p>
      </div>
    );
  } else {
    body = (
      // The minimum reserves room for the absolutely positioned action bar,
      // so no image aspect ratio (tiny icon, extreme panorama) can collapse
      // the wrapper and clip Copy/Download under overflow-hidden; the 90vh
      // clamp keeps the floor inside the wrapper's own max height.
      <div className="relative flex max-h-[90vh] min-h-[min(6rem,90vh)] w-full items-center justify-center overflow-hidden rounded-lg bg-foreground/3">
        <img
          src={image.src}
          alt={props.alt}
          // w-full expands small images to a usable preview and keeps the
          // wrapper tall enough that the action bar is never clipped.
          className="block max-h-[min(88vh,52rem)] w-full max-w-full object-contain"
          draggable={false}
        />
        <div className="absolute bottom-safe-bottom-gutter right-3">
          <ExpandedImageActionBar
            src={image.src}
            mediaType={image.mediaType}
            alt={props.alt}
            suggestedName={props.suggestedName}
          />
        </div>
      </div>
    );
  }

  return (
    <DialogContent
      className="w-[min(95vw,80rem)] max-w-[min(95vw,80rem,var(--safe-area-width))] bg-popover/95 p-2 sm:max-w-[min(95vw,80rem,var(--safe-area-width))]"
      showCloseButton
      ref={contentRef}
      // Focus the dialog itself, not the first action button, whose tooltip
      // pops open on that focus. Radix skips its own focus move once this is
      // prevented, so the dialog has to take focus explicitly or it would be
      // left outside the modal, on the trigger Radix hides from screen readers.
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        contentRef.current?.focus();
      }}
      onCloseAutoFocus={props.onCloseAutoFocus}
    >
      <DialogTitle className="sr-only">{props.title}</DialogTitle>
      {body}
    </DialogContent>
  );
}

/**
 * Owns the copy/download mutation, deliberately BELOW `DialogContent`: Radix
 * mounts a closed dialog's subtree lazily, so keeping the hook here means a
 * thumbnail that never gets opened costs no query client at all - the chips
 * render inside surfaces that have no reason to provide one.
 */
function ExpandedImageActionBar(props: {
  readonly src: string;
  readonly mediaType: string;
  readonly alt: string;
  readonly suggestedName: string | null;
}): ReactNode {
  const openSaved = useOpenSavedFile();
  const imageAction = useMutation<void, Error, ImageAction>({
    mutationKey: imageMutationKeys.perform(),
    mutationFn: (action) =>
      performImageAction({
        action,
        src: props.src,
        mediaType: props.mediaType,
        suggestedName:
          props.suggestedName ??
          imageFileName(props.alt, props.src, props.mediaType),
        openSaved: openSaved.mutate,
      }),
    onError: (error, action) =>
      toastFromRunnerError(error, `Failed to ${action} image`),
  });

  return (
    <ImageActions
      pendingAction={imageAction.isPending ? imageAction.variables : null}
      canCopy={isClipboardImageMediaType(props.mediaType)}
      remote={null}
      onCopy={() => imageAction.mutate("copy")}
      onDownload={() => imageAction.mutate("download")}
    />
  );
}
