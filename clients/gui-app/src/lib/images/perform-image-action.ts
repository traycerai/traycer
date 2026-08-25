import { toast } from "sonner";

import { saveBlobToDisk } from "@/lib/files/save-blob-to-disk";
import { copyImageBlobToClipboard } from "@/lib/images/copy-image-to-clipboard";

export type ImageAction = "copy" | "download";

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
