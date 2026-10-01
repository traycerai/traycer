/**
 * Who a dither frame belongs to. The landing page and the sidebar are both
 * full-bleed "page" treatments, but they rasterize at different sizes. A
 * Settings thumbnail is smaller still. One shared slot lets whichever
 * surface painted last delete the landing page's frame, and the next host
 * switch has nothing to restore.
 *
 * Previews are not a slot. A thumbnail does not have to survive a remount,
 * and there are many of them. They paint their own canvas and leave these
 * two frames alone.
 *
 * Each slot keeps one bitmap. A resize of that surface replaces it.
 *
 * Kept beside the component so the component file only exports components.
 * A non-component export there breaks fast refresh.
 */
export type WallpaperFrameSlot = "page" | "sidebar";

interface RetainedWallpaperFrame {
  readonly id: string;
  readonly canvas: HTMLCanvasElement;
}

const retainedWallpaperFrames = new Map<
  WallpaperFrameSlot,
  RetainedWallpaperFrame
>();

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
  slot: WallpaperFrameSlot,
  style: string,
  source: HTMLCanvasElement,
): void {
  if (source.width === 0 || source.height === 0) return;
  const id = wallpaperFrameId(style, source.width, source.height);
  const existing = retainedWallpaperFrames.get(slot);
  const copy =
    existing?.id === id ? existing.canvas : document.createElement("canvas");
  copy.width = source.width;
  copy.height = source.height;
  const context = copy.getContext("2d");
  if (context === null) return;
  context.drawImage(source, 0, 0);
  if (existing !== undefined && existing.canvas !== copy) {
    releaseWallpaperFrame(existing.canvas);
  }
  retainedWallpaperFrames.set(slot, { id, canvas: copy });
}

/** Draws the retained frame when this canvas's raster size matches. */
export function restoreWallpaperFrame(
  slot: WallpaperFrameSlot,
  style: string,
  canvas: HTMLCanvasElement,
  size: { readonly width: number; readonly height: number },
): boolean {
  if (size.width <= 0 || size.height <= 0) return false;
  const retained = retainedWallpaperFrames.get(slot);
  if (retained === undefined) return false;
  if (retained.id !== wallpaperFrameId(style, size.width, size.height)) {
    return false;
  }
  const context = canvas.getContext("2d");
  if (context === null) return false;
  canvas.width = size.width;
  canvas.height = size.height;
  context.drawImage(retained.canvas, 0, 0);
  return true;
}

/** Drops retained dither frames. Tests only. */
export function resetRetainedWallpaperFramesForTests(): void {
  retainedWallpaperFrames.clear();
}
