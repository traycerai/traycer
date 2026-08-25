import { lazy, Suspense, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { isClipboardImageMediaType } from "@traycer-clients/shared/images/clipboard-image-media";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useRunnerOpenExternalLink } from "@/hooks/runner/use-open-external-link-mutation";
import { imageMutationKeys } from "@/lib/query-keys";
import { toastFromRunnerError } from "@/lib/runner-error-toast";
import { cn } from "@/lib/utils";

import {
  type ImageAction,
  ImageActions,
  imageFileName,
  performImageAction,
} from "./image-actions";

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
  const alt = props.alt.length > 0 ? props.alt : "Image";
  const suggestedName =
    props.suggestedName ?? imageFileName(alt, props.src, props.mediaType);
  const remoteUrl = /^https:/i.test(props.src) ? props.src : null;
  const canCopy =
    remoteUrl === null && isClipboardImageMediaType(props.mediaType);

  const imageAction = useMutation<void, Error, ImageAction>({
    mutationKey: imageMutationKeys.perform(),
    mutationFn: (action) =>
      performImageAction(action, props.src, props.mediaType, suggestedName),
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
        <div
          role="presentation"
          className="pointer-events-none absolute right-2 top-2 z-10 opacity-0 transition-opacity group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 @max-[8rem]:bottom-1 @max-[8rem]:left-1 @max-[8rem]:right-auto @max-[8rem]:top-auto @max-[8rem]:pointer-events-auto @max-[8rem]:opacity-100 motion-reduce:transition-none"
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          {actions}
        </div>
      </div>
      <DialogContent
        className="w-[min(95vw,80rem)] max-w-[min(95vw,80rem)] bg-popover/95 p-2 sm:max-w-[min(95vw,80rem)]"
        showCloseButton
        // Focus the dialog itself, not the first action button - auto-focusing
        // the Copy button popped its tooltip on every open.
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <DialogTitle className="sr-only">{alt}</DialogTitle>
        <div className="relative flex max-h-[90vh] min-h-0 w-full items-center justify-center overflow-hidden rounded-lg bg-foreground/3">
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
          <div className="absolute bottom-3 right-3">{actions}</div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
