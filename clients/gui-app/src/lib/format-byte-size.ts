/**
 * The one byte-size formatter for asset surfaces (image captions, PDF diff
 * blocks). Binary-suffix labels (KiB/MiB) because the math is 1024-based
 * and the preview size-cap copy already speaks MiB - one honest unit
 * convention across the feature (live-testing review, D5).
 */
export function formatByteSize(sizeBytes: number): string {
  if (sizeBytes >= 1024 * 1024) {
    return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MiB`;
  }
  if (sizeBytes >= 1024) {
    return `${(sizeBytes / 1024).toFixed(1)} KiB`;
  }
  return `${sizeBytes} B`;
}
