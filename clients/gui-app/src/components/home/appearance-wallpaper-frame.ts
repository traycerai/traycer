/**
 * The last completed dither. A host switch remounts the start page, and a
 * new canvas is transparent until its effect finishes. That empty frame is
 * the full-screen flash. The layout effect copies this bitmap on before the
 * browser paints, so the picture never leaves.
 *
 * One frame is enough: the start page has one visible raster, and a resize
 * replaces it. Keeping every size would retain a full bitmap per step of a
 * window drag.
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

function releaseWallpaperFrame(canvas: HTMLCanvasElement): void {
  // Zeroing the bitmap lets the browser drop the pixel buffer. Removing the
  // map entry alone keeps that buffer alive for as long as the element is.
  canvas.width = 0;
  canvas.height = 0;
}

export function retainWallpaperFrame(
  style: string,
  source: HTMLCanvasElement,
): void {
  if (source.width === 0 || source.height === 0) return;
  const id = wallpaperFrameId(style, source.width, source.height);
  const copy =
    retainedWallpaperFrames.get(id) ?? document.createElement("canvas");
  copy.width = source.width;
  copy.height = source.height;
  const context = copy.getContext("2d");
  if (context === null) return;
  context.drawImage(source, 0, 0);
  for (const [key, canvas] of retainedWallpaperFrames) {
    if (key === id) continue;
    releaseWallpaperFrame(canvas);
    retainedWallpaperFrames.delete(key);
  }
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
