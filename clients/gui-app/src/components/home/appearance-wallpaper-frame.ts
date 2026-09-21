/**
 * Last completed dither, per style and raster size. A host switch remounts
 * the start page, and a new canvas is transparent until its effect finishes.
 * That empty frame is the full-screen flash. The layout effect copies the
 * retained bitmap on before the browser paints, so the picture never leaves.
 *
 * Kept beside the component so the component file only exports components.
 * A non-component export there breaks fast refresh.
 */
const retainedWallpaperFrames = new Map<string, HTMLCanvasElement>();

function wallpaperFrameId(
  style: string,
  width: number,
  height: number,
): string {
  return `${style}\u001f${width}x${height}`;
}

export function retainWallpaperFrame(
  style: string,
  source: HTMLCanvasElement,
): void {
  if (source.width === 0 || source.height === 0) return;
  for (const key of retainedWallpaperFrames.keys()) {
    if (!key.startsWith(`${style}\u001f`)) retainedWallpaperFrames.delete(key);
  }
  const id = wallpaperFrameId(style, source.width, source.height);
  const copy =
    retainedWallpaperFrames.get(id) ?? document.createElement("canvas");
  copy.width = source.width;
  copy.height = source.height;
  copy.getContext("2d")?.drawImage(source, 0, 0);
  retainedWallpaperFrames.set(id, copy);
}

/** Draws the retained frame when this canvas's raster size matches. */
export function restoreWallpaperFrame(
  style: string,
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
): boolean {
  if (width <= 0 || height <= 0) return false;
  const copy = retainedWallpaperFrames.get(
    wallpaperFrameId(style, width, height),
  );
  if (copy === undefined) return false;
  const context = canvas.getContext("2d");
  if (context === null) return false;
  canvas.width = width;
  canvas.height = height;
  context.drawImage(copy, 0, 0);
  return true;
}

/** Drops retained dither frames. Tests only. */
export function resetRetainedWallpaperFramesForTests(): void {
  retainedWallpaperFrames.clear();
}
