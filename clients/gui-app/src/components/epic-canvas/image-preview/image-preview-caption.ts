import type { FileAssetMeta } from "@/hooks/assets/use-file-asset";
import { formatByteSize } from "@/lib/format-byte-size";

/**
 * `{width}x{height} · {size}` (image-preview tech plan section 4). Either
 * half can be missing (SVG without declared dimensions has null width/height;
 * a fallback state has no meta at all) - the caption degrades to whatever
 * half is known rather than showing a placeholder for the other.
 */
export function formatImagePreviewCaption(
  meta: FileAssetMeta | null,
): string | null {
  if (meta === null) return null;
  const dimensions =
    meta.width !== null && meta.height !== null
      ? `${meta.width}x${meta.height}`
      : null;
  const size = formatByteSize(meta.sizeBytes);
  if (dimensions === null) return size;
  return `${dimensions} · ${size}`;
}
