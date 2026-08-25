import { useRef, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { ImageOff } from "lucide-react";
import { isClipboardImageMediaType } from "@traycer-clients/shared/images/clipboard-image-media";

import { DialogContent, DialogTitle } from "@/components/ui/dialog";
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
  const imageAction = useMutation<void, Error, ImageAction>({
    mutationKey: imageMutationKeys.perform(),
    mutationFn: (action) => {
      if (image.status !== "ready") return Promise.resolve();
      const name =
        props.suggestedName ??
        imageFileName(props.alt, image.src, image.mediaType);
      return performImageAction(action, image.src, image.mediaType, name);
    },
    onError: (error, action) =>
      toastFromRunnerError(error, `Failed to ${action} image`),
  });

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
      <div className="relative flex max-h-[90vh] min-h-0 w-full items-center justify-center overflow-hidden rounded-lg bg-foreground/3">
        <img
          src={image.src}
          alt={props.alt}
          className="block max-h-[min(88vh,52rem)] max-w-full object-contain"
          draggable={false}
        />
        <div className="absolute bottom-3 right-3">
          <ImageActions
            pendingAction={imageAction.isPending ? imageAction.variables : null}
            canCopy={isClipboardImageMediaType(image.mediaType)}
            remote={null}
            onCopy={() => imageAction.mutate("copy")}
            onDownload={() => imageAction.mutate("download")}
          />
        </div>
      </div>
    );
  }

  return (
    <DialogContent
      className="w-[min(95vw,80rem)] max-w-[min(95vw,80rem)] bg-popover/95 p-2 sm:max-w-[min(95vw,80rem)]"
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
