import type { FileBytesHeader } from "@/lib/files/byte-source";
import { formatByteSize } from "@/lib/format-byte-size";

/**
 * `{width}x{height} · {size}` (image-preview tech plan section 4). Either
 * half can be missing (SVG without declared dimensions has null width/height;
 * an epic-file address carries no header at all, so it has neither; a
 * fallback state has no header object at all) - the caption degrades to
 * whatever half is known rather than showing a placeholder for the other,
 * and to nothing when neither is.
 */
export function formatImagePreviewCaption(
  header: FileBytesHeader | null,
): string | null {
  if (header === null) return null;
  const dimensions =
    header.width !== null && header.height !== null
      ? `${header.width}x${header.height}`
      : null;
  const size =
    header.sizeBytes === null ? null : formatByteSize(header.sizeBytes);
  if (size === null) return dimensions;
  if (dimensions === null) return size;
  return `${dimensions} · ${size}`;
}
