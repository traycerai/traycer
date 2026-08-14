import type { ImageAssetMeta } from "@/hooks/assets/use-image-asset";

/**
 * `{width}x{height} · {size}` (image-preview tech plan section 4). Either
 * half can be missing (SVG without declared dimensions has null width/height;
 * a fallback state has no meta at all) - the caption degrades to whatever
 * half is known rather than showing a placeholder for the other.
 */
export function formatImagePreviewCaption(
  meta: ImageAssetMeta | null,
): string | null {
  if (meta === null) return null;
  const dimensions =
    meta.width !== null && meta.height !== null
      ? `${meta.width}x${meta.height}`
      : null;
  const size = formatImageByteSize(meta.sizeBytes);
  if (dimensions === null) return size;
  return `${dimensions} · ${size}`;
}

export function formatImageByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(1)} KB`;
  const mib = kib / 1024;
  return `${mib.toFixed(1)} MB`;
}
