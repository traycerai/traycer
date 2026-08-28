import { useEffect } from "react";
import { createStore } from "zustand/vanilla";
import type { BrowserViewNativeTabKey } from "@traycer-clients/shared/platform/browser-view";
import { compositeKey } from "./browser-view-keys";

/**
 * GUI-local on-screen registry for real browser tiles.
 * Keyed host + session + tab. The PiP consults this, never the host `viewed`
 * flag (that conflates screencast viewers with tiles).
 *
 * Refcounted so a session tile and its native/peek child can both report
 * without flickering on remount.
 */
interface VisibleBrowserTileState {
  readonly countsByKeyId: Partial<Record<string, number>>;
}

export const visibleBrowserTileStore = createStore<VisibleBrowserTileState>()(
  () => ({ countsByKeyId: {} }),
);

export function visibleBrowserTileKeyId(key: BrowserViewNativeTabKey): string {
  return compositeKey(key.hostId, key.sessionId, key.tabId);
}

export function registerVisibleBrowserTile(
  key: BrowserViewNativeTabKey,
): () => void {
  const keyId = visibleBrowserTileKeyId(key);
  setCount(keyId, currentCount(keyId) + 1);
  return () => {
    setCount(keyId, Math.max(0, currentCount(keyId) - 1));
  };
}

export function isBrowserTileVisible(key: BrowserViewNativeTabKey): boolean {
  return currentCount(visibleBrowserTileKeyId(key)) > 0;
}

export function subscribeVisibleBrowserTiles(listener: () => void): () => void {
  return visibleBrowserTileStore.subscribe(listener);
}

export function useRegisterVisibleBrowserTile(input: {
  readonly hostId: string | null;
  readonly sessionId: string | null;
  readonly tabId: string | null;
  readonly visible: boolean;
}): void {
  const { hostId, sessionId, tabId, visible } = input;
  useEffect(() => {
    if (!visible || hostId === null || sessionId === null || tabId === null) {
      return;
    }
    return registerVisibleBrowserTile({ hostId, sessionId, tabId });
  }, [hostId, sessionId, tabId, visible]);
}

function currentCount(keyId: string): number {
  return visibleBrowserTileStore.getState().countsByKeyId[keyId] ?? 0;
}

function setCount(keyId: string, count: number): void {
  visibleBrowserTileStore.setState((state) => {
    const countsByKeyId = { ...state.countsByKeyId };
    if (count === 0) delete countsByKeyId[keyId];
    else countsByKeyId[keyId] = count;
    return { countsByKeyId };
  });
}
