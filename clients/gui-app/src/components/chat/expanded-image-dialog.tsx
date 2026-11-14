import {
  useRef,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { useMutation } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, ImageOff } from "lucide-react";
import { isClipboardImageMediaType } from "@traycer-clients/shared/images/clipboard-image-media";

import { Button } from "@/components/ui/button";
import { DialogContent, DialogTitle } from "@/components/ui/dialog";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useOpenSavedFile } from "@/hooks/files/use-open-saved-file";
import { imageMutationKeys } from "@/lib/query-keys";
import { toastFromRunnerError } from "@/lib/runner-error-toast";
import { cn } from "@/lib/utils";
import { useFileSaveHost } from "@/hooks/files/use-file-save-host";
import { useCanCopyImages } from "@/hooks/images/use-can-copy-images";
import {
  canDownloadToDevice,
  hasSeparateDownloadRoute,
} from "@/lib/files/save-blob-to-disk";

import {
  type ImageAction,
  imageFileName,
  performImageAction,
} from "@/lib/images/perform-image-action";

import { ImageActions } from "./segments/image-actions";
import {
  EXPANDED_IMAGE_STAGE_BOX,
  ZoomableImageDialogBody,
} from "./zoomable-image-dialog-body";

export type ExpandedImageState =
  | { readonly status: "loading" }
  | { readonly status: "unavailable" }
  | {
      readonly status: "ready";
      readonly src: string;
      readonly mediaType: string;
    };

/**
 * Which image of a set the viewer shows. `open` is kept apart from `index` so
 * the last image stays on screen while the dialog animates closed.
 */
export interface ImageSetViewerState {
  readonly open: boolean;
  readonly index: number;
}

/**
 * Where the shown image sits among the images attached together: one sent
 * message's gallery, or one draft's strip. The viewer never leaves that set.
 */
export interface ImageSetNavigation {
  /** Zero-based position of the shown image. */
  readonly index: number;
  readonly count: number;
  readonly onNavigate: (index: number) => void;
}

/**
 * The shared expanded view for user-attached images - composer strip chips
 * and sent-message gallery thumbs. Thumbnails stay action-free by design;
 * copy and download live only here, on the expanded image.
 *
 * One dialog serves a whole set, so stepping to a neighbour swaps the image
 * inside a frame that stays put. A set of one draws no navigation at all.
 */
export function ExpandedImageDialogContent(props: {
  readonly title: string;
  readonly navigation: ImageSetNavigation;
  readonly onCloseAutoFocus: (event: Event) => void;
  /** The shown image, as an `ExpandedImageBody`. */
  readonly children: ReactNode;
}): ReactNode {
  const contentRef = useRef<HTMLDivElement>(null);
  const previousRef = useRef<HTMLButtonElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const { index, count, onNavigate } = props.navigation;
  const previousIndex = index > 0 ? index - 1 : null;
  const nextIndex = index < count - 1 ? index + 1 : null;

  // Stepping onto either end disables that end's arrow. A disabled button
  // cannot keep focus, so the browser drops it to the document, where the
  // arrow keys below never see a key; the dialog takes it first, as on open.
  function navigate(target: number): void {
    const focused = document.activeElement;
    const disablesFocusedArrow =
      (target === 0 && focused === previousRef.current) ||
      (target === count - 1 && focused === nextRef.current);
    if (disablesFocusedArrow) contentRef.current?.focus();
    onNavigate(target);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.defaultPrevented) return;
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
      return;
    }
    if (event.key === "ArrowLeft" && previousIndex !== null) {
      event.preventDefault();
      navigate(previousIndex);
    } else if (event.key === "ArrowRight" && nextIndex !== null) {
      event.preventDefault();
      navigate(nextIndex);
    }
  }

  return (
    <DialogContent
      className="w-[min(95vw,80rem)] max-w-[min(95vw,80rem,var(--safe-area-width))] sm:max-w-[min(95vw,80rem,var(--safe-area-width))]"
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
      onKeyDown={handleKeyDown}
    >
      <DialogTitle className="sr-only">{props.title}</DialogTitle>
      <div className="relative">
        {props.children}
        {count > 1 ? (
          <>
            <span
              role="status"
              aria-label={`Image ${index + 1} of ${count}`}
              className="absolute left-3 top-3 rounded-md border bg-popover px-2 py-1 text-ui-xs font-medium tabular-nums shadow-sm"
            >
              {index + 1} / {count}
            </span>
            <ImageSetArrow
              direction="previous"
              target={previousIndex}
              onPress={navigate}
              buttonRef={previousRef}
            />
            <ImageSetArrow
              direction="next"
              target={nextIndex}
              onPress={navigate}
              buttonRef={nextRef}
            />
          </>
        ) : null}
      </div>
    </DialogContent>
  );
}

/**
 * One edge arrow, on the same raised plate as the zoom cluster so it stays
 * legible over any image. `target` is null at that end of the set.
 */
function ImageSetArrow({
  buttonRef,
  ...props
}: {
  readonly direction: "previous" | "next";
  readonly target: number | null;
  readonly onPress: (target: number) => void;
  readonly buttonRef: RefObject<HTMLButtonElement | null>;
}): ReactNode {
  const isPrevious = props.direction === "previous";
  const label = isPrevious ? "Previous image" : "Next image";
  const target = props.target;
  return (
    <div
      className={cn(
        "absolute top-1/2 -translate-y-1/2 rounded-md border bg-popover p-1 shadow-sm",
        isPrevious ? "left-3" : "right-3",
      )}
    >
      <TooltipWrapper
        label={isPrevious ? `${label} (←)` : `${label} (→)`}
        side={isPrevious ? "right" : "left"}
        sideOffset={undefined}
        align={undefined}
      >
        <Button
          ref={buttonRef}
          type="button"
          variant="ghost"
          size="icon-sm-touch"
          disabled={target === null}
          onClick={() => {
            if (target !== null) props.onPress(target);
          }}
          aria-label={label}
          aria-keyshortcuts={isPrevious ? "ArrowLeft" : "ArrowRight"}
        >
          {isPrevious ? (
            <ChevronLeft className="size-4" />
          ) : (
            <ChevronRight className="size-4" />
          )}
        </Button>
      </TooltipWrapper>
    </div>
  );
}

/** One image of the set, in whichever state its bytes are in. */
export function ExpandedImageBody(props: {
  readonly alt: string;
  readonly image: ExpandedImageState;
  readonly suggestedName: string | null;
}): ReactNode {
  const image = props.image;
  if (image.status === "loading") {
    return (
      <div
        className={cn(
          "animate-pulse rounded-lg bg-foreground/10",
          EXPANDED_IMAGE_STAGE_BOX,
        )}
        aria-hidden
      />
    );
  }
  if (image.status === "unavailable") {
    return (
      <div
        className={cn(
          "flex flex-col items-center justify-center gap-2 rounded-lg bg-foreground/5 px-4 py-8 text-center text-muted-foreground",
          EXPANDED_IMAGE_STAGE_BOX,
        )}
        role="status"
      >
        <ImageOff className="size-8" aria-hidden />
        <p className="text-ui-sm">Image unavailable</p>
      </div>
    );
  }
  return (
    <ZoomableImageDialogBody
      src={image.src}
      alt={props.alt}
      actions={
        <ExpandedImageActionBar
          src={image.src}
          mediaType={image.mediaType}
          alt={props.alt}
          suggestedName={props.suggestedName}
        />
      }
    />
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
  const fileSave = useFileSaveHost();
  const openSaved = useOpenSavedFile();
  const canCopyOnShell = useCanCopyImages();
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
        fileSave,
      }),
    onError: (error, action) =>
      toastFromRunnerError(error, `Failed to ${action} image`),
  });

  return (
    <ImageActions
      pendingAction={imageAction.isPending ? imageAction.variables : null}
      // The media type must take a clipboard image AND the shell must actually
      // reach the system clipboard with one.
      canCopy={isClipboardImageMediaType(props.mediaType) && canCopyOnShell}
      canShare={hasSeparateDownloadRoute(fileSave)}
      canDownload={canDownloadToDevice(fileSave)}
      remote={null}
      onCopy={() => imageAction.mutate("copy")}
      onShare={() => imageAction.mutate("share")}
      onDownload={() => imageAction.mutate("download")}
    />
  );
}
