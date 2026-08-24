import { lazy, Suspense, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { Copy, Download, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { isClipboardImageMediaType } from "@traycer-clients/shared/images/clipboard-image-media";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { saveBlobToDisk, type SavedFile } from "@/lib/files/save-blob-to-disk";
import { toastSavedFile } from "@/lib/files/saved-file-toast";
import { useOpenSavedFile } from "@/hooks/files/use-open-saved-file";
import { copyImageBlobToClipboard } from "@/lib/images/copy-image-to-clipboard";
import { useRunnerOpenExternalLink } from "@/hooks/runner/use-open-external-link-mutation";
import { imageMutationKeys } from "@/lib/query-keys";
import { toastFromRunnerError } from "@/lib/runner-error-toast";
import { cn } from "@/lib/utils";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";

interface ImageLightboxProps {
  readonly src: string;
  readonly alt: string;
  readonly mediaType: string | null;
  readonly suggestedName: string | null;
  readonly children: ReactNode;
  readonly className: string | undefined;
}

type ImageAction = "copy" | "download";

const UntrustedSvgLightbox = lazy(() =>
  import("./untrusted-svg-lightbox").then((module) => ({
    default: module.UntrustedSvgLightbox,
  })),
);

export function ImageLightbox(props: ImageLightboxProps): ReactNode {
  const openExternalLink = useRunnerOpenExternalLink();
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
      }),
    onError: (error, action) =>
      toastFromRunnerError(error, `Failed to ${action} image`),
  });

  const actions = (
    <ImageActions
      pendingAction={imageAction.isPending ? imageAction.variables : null}
      canCopy={canCopy}
      remoteUrl={remoteUrl}
      openExternalPending={openExternalLink.isPending}
      onCopy={() => imageAction.mutate("copy")}
      onDownload={() => imageAction.mutate("download")}
      onOpenExternal={() => {
        if (remoteUrl !== null) openExternalLink.mutate(remoteUrl);
      }}
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

function ImageActions(props: {
  readonly pendingAction: ImageAction | null;
  readonly canCopy: boolean;
  readonly remoteUrl: string | null;
  readonly openExternalPending: boolean;
  readonly onCopy: () => void;
  readonly onDownload: () => void;
  readonly onOpenExternal: () => void;
}): ReactNode {
  return (
    <div className="flex items-center gap-1 rounded-md border border-white/15 bg-black/65 p-1 text-white shadow-sm backdrop-blur-sm @max-[8rem]:gap-0 @max-[8rem]:border-0 @max-[8rem]:p-0">
      {props.canCopy ? (
        <ImageActionButton
          label="Copy image"
          disabled={props.pendingAction !== null}
          pending={props.pendingAction === "copy"}
          onClick={props.onCopy}
          icon={<Copy className="size-3.5" aria-hidden />}
        />
      ) : null}
      {props.remoteUrl === null ? (
        <ImageActionButton
          label="Download image"
          disabled={props.pendingAction !== null}
          pending={props.pendingAction === "download"}
          onClick={props.onDownload}
          icon={<Download className="size-3.5" aria-hidden />}
        />
      ) : (
        <ImageActionButton
          label="Open in browser"
          disabled={props.pendingAction !== null || props.openExternalPending}
          pending={props.openExternalPending}
          onClick={props.onOpenExternal}
          icon={<ExternalLink className="size-3.5" aria-hidden />}
        />
      )}
    </div>
  );
}

function ImageActionButton(props: {
  readonly label: string;
  readonly disabled: boolean;
  readonly pending: boolean;
  readonly onClick: () => void;
  readonly icon: ReactNode;
}): ReactNode {
  return (
    <TooltipWrapper
      label={props.label}
      side="top"
      sideOffset={6}
      align="center"
    >
      <button
        type="button"
        disabled={props.disabled}
        onClick={props.onClick}
        className="flex size-7 items-center justify-center rounded-sm text-white/85 outline-none transition-colors hover:bg-white/15 hover:text-white focus-visible:ring-1 focus-visible:ring-white disabled:opacity-50"
        aria-label={props.label}
      >
        {props.pending ? (
          <AgentSpinningDots
            className="text-current"
            testId="image-action-spinner"
            variant={undefined}
          />
        ) : (
          props.icon
        )}
      </button>
    </TooltipWrapper>
  );
}

async function fetchImageBlob(
  src: string,
  mediaType: string | null,
): Promise<Blob> {
  const response = await fetch(src);
  if (!response.ok) throw new Error(`Image fetch failed (${response.status})`);
  const blob = await response.blob();
  if (blob.type.length > 0 || mediaType === null) return blob;
  return new Blob([blob], { type: mediaType });
}

async function performImageAction(params: {
  readonly action: ImageAction;
  readonly src: string;
  readonly mediaType: string | null;
  readonly suggestedName: string;
  readonly openSaved: (saved: SavedFile) => void;
}): Promise<void> {
  const blob = await fetchImageBlob(params.src, params.mediaType);
  if (params.action === "copy") {
    await copyImageBlobToClipboard(blob);
    toast.success("Image copied");
    return;
  }
  const saved = await saveBlobToDisk(blob, params.suggestedName);
  if (saved !== null) toastSavedFile(saved, params.openSaved);
}

function imageFileName(
  alt: string,
  src: string,
  mediaType: string | null,
): string {
  const sourceName = sourceFileName(src);
  if (sourceName !== null) return sourceName;
  const stem =
    alt
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48) || "image";
  return `${stem}.${imageExtension(mediaType)}`;
}

function sourceFileName(src: string): string | null {
  if (src.startsWith("blob:") || src.startsWith("data:")) return null;
  try {
    const name = new URL(src).pathname.split("/").at(-1);
    return name === undefined || name.length === 0 ? null : name;
  } catch {
    return null;
  }
}

function imageExtension(mediaType: string | null): string {
  if (mediaType === "image/jpeg") return "jpg";
  if (mediaType === "image/gif") return "gif";
  if (mediaType === "image/webp") return "webp";
  if (mediaType === "image/svg+xml") return "svg";
  return "png";
}
