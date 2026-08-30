import { toast } from "sonner";

import type { IFileSaveHost } from "@traycer-clients/shared/platform/runner-host";
import { saveBlobToDisk, type SavedFile } from "@/lib/files/save-blob-to-disk";
import { toastSavedFile } from "@/lib/files/saved-file-toast";
import { copyImageBlobToClipboard } from "@/lib/images/copy-image-to-clipboard";

export type ImageAction = "copy" | "download";

async function fetchImageBlob(
  src: string,
  mediaType: string | null,
): Promise<Blob> {
  const response = await fetch(src);
  if (!response.ok) throw new Error(`Image fetch failed (${response.status})`);
  const blob = await response.blob();
  // A missing or generic octet-stream Content-Type would make ClipboardItem
  // reject the copy; the caller's known media type is the trustworthy one.
  const untyped =
    blob.type.length === 0 || blob.type === "application/octet-stream";
  if (!untyped || mediaType === null) return blob;
  return new Blob([blob], { type: mediaType });
}

export async function performImageAction(params: {
  readonly action: ImageAction;
  readonly src: string;
  readonly mediaType: string | null;
  readonly suggestedName: string;
  readonly openSaved: (saved: SavedFile) => void;
  /** The shell's native save route; `null` falls back to the browser APIs. */
  readonly fileSave: IFileSaveHost | null;
}): Promise<void> {
  const blob = await fetchImageBlob(params.src, params.mediaType);
  if (params.action === "copy") {
    await copyImageBlobToClipboard(blob);
    toast.success("Image copied");
    return;
  }
  const saved = await saveBlobToDisk(
    blob,
    params.suggestedName,
    params.fileSave,
  );
  if (saved !== null) toastSavedFile(saved, params.openSaved, params.fileSave);
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
