import { lazy, Suspense, useState, type ReactNode } from "react";
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
import { saveBlobToDisk } from "@/lib/files/save-blob-to-disk";
import { copyImageBlobToClipboard } from "@/lib/images/copy-image-to-clipboard";
import { useRunnerOpenExternalLink } from "@/hooks/runner/use-open-external-link-mutation";
import { appLogger } from "@/lib/logger";
import { reportableErrorToast } from "@/lib/reportable-error-toast";
import { cn } from "@/lib/utils";

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
  const [pendingAction, setPendingAction] = useState<ImageAction | null>(null);
  const openExternalLink = useRunnerOpenExternalLink();
  const alt = props.alt.length > 0 ? props.alt : "Image";
  const suggestedName =
    props.suggestedName ?? imageFileName(alt, props.src, props.mediaType);
  const remoteUrl = /^https:/i.test(props.src) ? props.src : null;
  const canCopy =
    remoteUrl === null && isClipboardImageMediaType(props.mediaType);

  const runAction = (action: ImageAction): void => {
    if (pendingAction !== null) return;
    setPendingAction(action);
    void performImageAction(action, props.src, props.mediaType, suggestedName)
      .catch((error: unknown) => {
        appLogger.errorSummary(`[image] ${action} failed`, {}, error);
        reportableErrorToast(`Failed to ${action} image`, undefined, {
          title: `Could not ${action} image`,
          message: null,
          code: null,
          source: "Image viewer",
        });
      })
      .finally(() => setPendingAction(null));
  };

  const actions = (
    <ImageActions
      pendingAction={pendingAction}
      canCopy={canCopy}
      remoteUrl={remoteUrl}
      openExternalPending={openExternalLink.isPending}
      onCopy={() => runAction("copy")}
      onDownload={() => runAction("download")}
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
        <div className="absolute right-2 top-2 z-10 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 motion-reduce:transition-none">
          {actions}
        </div>
      </div>
      <DialogContent
        className="w-[min(95vw,80rem)] max-w-[min(95vw,80rem)] bg-popover/95 p-2 sm:max-w-[min(95vw,80rem)]"
        showCloseButton
      >
        <DialogTitle className="sr-only">{alt}</DialogTitle>
        <div className="relative flex max-h-[90vh] min-h-0 w-full items-center justify-center overflow-hidden rounded-lg bg-muted/30">
          {props.mediaType === "image/svg+xml" ? (
            <div className="h-[min(88vh,52rem)] w-full">
              <Suspense
                fallback={
                  <div className="size-full animate-pulse bg-muted/60 motion-reduce:animate-none" />
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
    <div className="flex items-center gap-1 rounded-md border border-white/15 bg-black/65 p-1 text-white shadow-sm backdrop-blur-sm">
      {props.canCopy ? (
        <ImageActionButton
          label="Copy image"
          disabled={props.pendingAction !== null}
          onClick={props.onCopy}
          icon={<Copy className="size-3.5" aria-hidden />}
        />
      ) : null}
      {props.remoteUrl === null ? (
        <ImageActionButton
          label="Download image"
          disabled={props.pendingAction !== null}
          onClick={props.onDownload}
          icon={<Download className="size-3.5" aria-hidden />}
        />
      ) : (
        <ImageActionButton
          label="Open in browser"
          disabled={props.pendingAction !== null || props.openExternalPending}
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
        {props.icon}
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
  return new Blob([await blob.arrayBuffer()], { type: mediaType });
}

async function performImageAction(
  action: ImageAction,
  src: string,
  mediaType: string | null,
  suggestedName: string,
): Promise<void> {
  const blob = await fetchImageBlob(src, mediaType);
  if (action === "copy") {
    await copyImageBlobToClipboard(blob);
    toast.success("Image copied");
    return;
  }
  const saved = await saveBlobToDisk(blob, suggestedName);
  if (saved !== null) toast.success(`Saved ${saved}`);
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
