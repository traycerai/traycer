import type { ImageGenerationResult } from "@traycer/protocol/persistence/epic/content-blocks";

export function imageResultFileName(
  result: ImageGenerationResult,
): string | null {
  if (result.filePath === null) return null;
  const name = result.filePath.split(/[\\/]/).at(-1);
  return name === undefined || name.length === 0 ? null : name;
}

export function recordedImageAspectRatio(size: {
  readonly width: number | null;
  readonly height: number | null;
}): number | null {
  if (
    size.width === null ||
    size.height === null ||
    !Number.isFinite(size.width) ||
    !Number.isFinite(size.height) ||
    size.width <= 0 ||
    size.height <= 0
  ) {
    return null;
  }
  return Math.min(4, Math.max(0.25, size.width / size.height));
}

export function genericToolImageCaption(
  result: ImageGenerationResult,
  index: number,
): string {
  return result.alt !== null && result.alt.trim().length > 0
    ? result.alt
    : `Image ${index + 1}`;
}
