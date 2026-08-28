import { lazy, Suspense, useRef, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { isClipboardImageMediaType } from "@traycer-clients/shared/images/clipboard-image-media";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useOpenSavedFile } from "@/hooks/files/use-open-saved-file";
import { useRunnerOpenExternalLink } from "@/hooks/runner/use-open-external-link-mutation";
import { imageMutationKeys } from "@/lib/query-keys";
import { toastFromRunnerError } from "@/lib/runner-error-toast";
import { cn } from "@/lib/utils";
import { useFileSaveHost } from "@/hooks/files/use-file-save-host";

import {
  type ImageAction,
  imageFileName,
  performImageAction,
} from "@/lib/images/perform-image-action";

import { ImageActions } from "./image-actions";

interface ImageLightboxProps {
  readonly src: string;
  readonly alt: string;
  readonly mediaType: string | null;
  readonly suggestedName: string | null;
  readonly children: ReactNode;
  readonly className: string | undefined;
}

const UntrustedSvgLightbox = lazy(() =>
  import("./untrusted-svg-lightbox").then((module) => ({
    default: module.UntrustedSvgLightbox,
  })),
);

export function ImageLightbox(props: ImageLightboxProps): ReactNode {
  const openExternalLink = useRunnerOpenExternalLink();
  const contentRef = useRef<HTMLDivElement>(null);
  const fileSave = useFileSaveHost();
  const openSaved = useOpenSavedFile();
  const alt = props.alt.length > 0 ? props.alt : "Image";
  const suggestedName =
    props.suggestedName ?? imageFileName(alt, props.src, props.mediaType);
  const remoteUrl = /^https:/i.test(props.src) ? props.src : null;
  const canCopy =
    remoteUrl === null && isClipboardImageMediaType(props.mediaType);

  const imageAction = useMutation<void, Error, ImageAction>({
    mutationKey: imageMutationKeys.perform(),
    mutationFn: (action) =>
      performImageAction({
        action,
        src: props.src,
        mediaType: props.mediaType,
        suggestedName,
        openSaved: openSaved.mutate,
        fileSave,
      }),
    onError: (error, action) =>
      toastFromRunnerError(error, `Failed to ${action} image`),
  });

  const actions = (
    <ImageActions
      pendingAction={imageAction.isPending ? imageAction.variables : null}
      canCopy={canCopy}
      remote={
        remoteUrl === null
          ? null
          : {
              pending: openExternalLink.isPending,
              onOpen: () => openExternalLink.mutate(remoteUrl),
            }
      }
      onCopy={() => imageAction.mutate("copy")}
      onDownload={() => imageAction.mutate("download")}
    />
  );

  return (
    <Dialog>
      <div className={cn("group relative", props.className)}>
        <DialogTrigger asChild>
          <button
            type="button"
            className="block max-h-full max-w-full cursor-zoom-in outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={`Open ${alt}`}
          >
            {props.children}
          </button>
        </DialogTrigger>
        {/* Hover is the disclosure on a fine pointer; a coarse pointer has no
            hover state to reach it with, so the same bar is simply present
            there - the app's standing answer for hover-gated chrome. */}
        <div
          role="presentation"
          className="pointer-events-none absolute right-2 top-2 z-10 opacity-0 transition-opacity group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100 @max-[8rem]:bottom-1 @max-[8rem]:left-1 @max-[8rem]:right-auto @max-[8rem]:top-auto @max-[8rem]:pointer-events-auto @max-[8rem]:opacity-100 motion-reduce:transition-none"
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          {actions}
        </div>
      </div>
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
      >
        <DialogTitle className="sr-only">{alt}</DialogTitle>
        {/* The minimum reserves room for the absolutely positioned action
            bar, so no image aspect ratio can collapse the wrapper and clip
            the actions under overflow-hidden; the 90vh clamp keeps the floor
            inside the wrapper's own max height. */}
        <div className="relative flex max-h-[90vh] min-h-[min(6rem,90vh)] w-full items-center justify-center overflow-hidden rounded-lg bg-foreground/3">
          {props.mediaType === "image/svg+xml" ? (
            <div className="h-[min(88vh,52rem)] w-full">
              <Suspense
                fallback={
                  <div className="size-full animate-pulse bg-foreground/10 motion-reduce:animate-none" />
                }
              >
                <UntrustedSvgLightbox src={props.src} alt={alt} />
              </Suspense>
            </div>
          ) : (
            <img
              src={props.src}
              alt={alt}
              className="block max-h-[min(88vh,52rem)] max-w-full object-contain"
              draggable={false}
            />
          )}
          <div className="absolute bottom-safe-bottom-gutter right-3">
            {actions}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
