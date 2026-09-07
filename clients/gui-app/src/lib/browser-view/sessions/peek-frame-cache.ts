import { useCallback, useEffect, useSyncExternalStore } from "react";
import { compositeKey } from "@/lib/browser-view/tiles/browser-view-keys";
import type { ScreencastImage } from "@/lib/browser-view/sessions/use-screencast-session";

/** Best-effort last-known frame per tab, outside React state on purpose. */
const lastFrameCache = new Map<string, ScreencastImage>();

/**
 * Every tile open/close cycle mints a fresh `instanceId`, so keys are never reused and the targeted `clearLastBrowserPeekFrame` cannot reclaim the strays.
 * Insertion-order eviction bounds what the strays can cost.
 */
const LAST_FRAME_CACHE_LIMIT = 20;

function retainLastFrame(key: string, image: ScreencastImage): void {
  lastFrameCache.delete(key);
  lastFrameCache.set(key, image);
  for (const stale of lastFrameCache.keys()) {
    if (lastFrameCache.size <= LAST_FRAME_CACHE_LIMIT) break;
    lastFrameCache.delete(stale);
  }
}

/**
 * The one key builder for a browser peek tile's frame cache / dormant placeholder lookup - host+session+tab+tile-instance.
 * Shared by the tile and by `browser-session-tile.tsx`'s placeholder/self-close reads, so the shape cannot drift between the write side and any of its readers.
 */
export function browserPeekFrameKey(node: {
  readonly hostId: string;
  readonly sessionId: string;
  readonly tabId: string;
  readonly instanceId: string;
}): string {
  return compositeKey(node.hostId, node.sessionId, node.tabId, node.instanceId);
}

export function getLastBrowserPeekFrame(key: string): ScreencastImage | null {
  return lastFrameCache.get(key) ?? null;
}

export function clearLastBrowserPeekFrame(key: string): void {
  lastFrameCache.delete(key);
}

export function useRetainLastBrowserPeekFrame(
  key: string,
  image: ScreencastImage | null,
): void {
  useEffect(() => {
    if (image !== null) retainLastFrame(key, image);
  }, [key, image]);
}

/** Never notifies: this cache is read at mount, not subscribed to. */
function subscribeToNothing(): () => void {
  return () => {};
}

/** The dormant placeholder's read of the cache. */
export function useLastBrowserPeekFrame(key: string): ScreencastImage | null {
  const read = useCallback(() => getLastBrowserPeekFrame(key), [key]);
  return useSyncExternalStore(subscribeToNothing, read, read);
}

const VIDEO_SNAPSHOT_JPEG_QUALITY = 0.7;
const VIDEO_SNAPSHOT_MAX_EDGE_PX = 960;

/**
 * Draws a `<video>` element's currently decoded frame into the same cache the JPEG pump writes, under the same key - so the dormant placeholder still has something to show when a tab's last live pixels arrived over WebRTC.
 */
export function snapshotVideoFrameIntoPeekCache(
  key: string,
  video: HTMLVideoElement,
  wasActivePlane: boolean,
): void {
  if (!wasActivePlane) return;
  if (video.videoWidth <= 0 || video.videoHeight <= 0) return;
  // The placeholder renders this at opacity-30/grayscale/object-contain, so native resolution buys nothing and costs a ~16MiB RGBA buffer plus a synchronous `toDataURL` on the main thread during unmount.
  const scale = Math.min(
    1,
    VIDEO_SNAPSHOT_MAX_EDGE_PX / Math.max(video.videoWidth, video.videoHeight),
  );
  const canvas = document.createElement("canvas");
  // Clamped: an extreme aspect ratio can round a scaled axis to 0, and
  // `toDataURL` on a zero-dimension canvas throws inside this unmount path.
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  const context = canvas.getContext("2d");
  if (context === null) return;
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  retainLastFrame(key, {
    src: canvas.toDataURL("image/jpeg", VIDEO_SNAPSHOT_JPEG_QUALITY),
    sequence: -1, // never read back; the dormant placeholder only reads `.src`.
  });
}
