import type { ReactNode } from "react";
import { Copy, Download, ExternalLink } from "lucide-react";
import { toast } from "sonner";

import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { saveBlobToDisk } from "@/lib/files/save-blob-to-disk";
import { copyImageBlobToClipboard } from "@/lib/images/copy-image-to-clipboard";

export type ImageAction = "copy" | "download";

/** Remote images swap Download for Open-in-browser; local blobs pass null. */
export interface ImageRemoteOpen {
  readonly pending: boolean;
  readonly onOpen: () => void;
}

export function ImageActions(props: {
  readonly pendingAction: ImageAction | null;
  readonly canCopy: boolean;
  readonly remote: ImageRemoteOpen | null;
  readonly onCopy: () => void;
  readonly onDownload: () => void;
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
      {props.remote === null ? (
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
          disabled={props.pendingAction !== null || props.remote.pending}
          pending={props.remote.pending}
          onClick={props.remote.onOpen}
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

export async function performImageAction(
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

export function imageFileName(
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
