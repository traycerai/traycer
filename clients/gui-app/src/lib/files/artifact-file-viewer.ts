import {
  documentAssetKindOf,
  isImageAssetPath,
} from "@/lib/assets/image-extension-allowlist";

export type ArtifactFileViewer =
  | "image"
  | "pdf"
  | "docx"
  | "video"
  | "audio"
  | "text";

/** Uses the same image/document gates as workspace files, plus native media. */
export function artifactFileViewer(
  name: string,
  mediaType: string,
): ArtifactFileViewer | null {
  const document = documentAssetKindOf(name);
  if (document !== null) return document;
  if (mediaType === "application/pdf") return "pdf";
  if (
    mediaType ===
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  )
    return "docx";
  if (
    isImageAssetPath(name) ||
    /\.(avif|bmp)$/i.test(name) ||
    mediaType.startsWith("image/")
  )
    return "image";
  if (mediaType.startsWith("video/") || /\.(mp4|webm|mov|m4v)$/i.test(name))
    return "video";
  if (mediaType.startsWith("audio/")) return "audio";
  if (
    mediaType.startsWith("text/") ||
    ["application/json", "application/javascript", "application/xml"].includes(
      mediaType,
    )
  )
    return "text";
  return null;
}
