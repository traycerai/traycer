import { useEffect } from "react";

/**
 * GUI-local on-screen registry for real browser tiles.
 * Keyed host + session + tab. The PiP consults this, never the host `viewed`
 * flag (that conflates screencast viewers with tiles).
 *
 * Refcounted so a session tile and its native/peek child can both report
 * without flickering on remount.
 */
export interface VisibleBrowserTileKey {
  readonly hostId: string;
  readonly sessionId: string;
  readonly tabId: string;
}

export function visibleBrowserTileKeyId(key: VisibleBrowserTileKey): string {
  return `${key.hostId}\u001f${key.sessionId}\u001f${key.tabId}`;
}

const countsByKeyId = new Map<string, number>();
const listeners = new Set<() => void>();

export function registerVisibleBrowserTile(
  key: VisibleBrowserTileKey,
): () => void {
  const keyId = visibleBrowserTileKeyId(key);
  countsByKeyId.set(keyId, (countsByKeyId.get(keyId) ?? 0) + 1);
  emitVisibleBrowserTilesChanged();
  return () => {
    const current = countsByKeyId.get(keyId) ?? 0;
    if (current <= 1) countsByKeyId.delete(keyId);
    else countsByKeyId.set(keyId, current - 1);
    emitVisibleBrowserTilesChanged();
  };
}

export function isBrowserTileVisible(key: VisibleBrowserTileKey): boolean {
  return (countsByKeyId.get(visibleBrowserTileKeyId(key)) ?? 0) > 0;
}

export function subscribeVisibleBrowserTiles(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function resetVisibleBrowserTileRegistryForTests(): void {
  countsByKeyId.clear();
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

function emitVisibleBrowserTilesChanged(): void {
  listeners.forEach((listener) => {
    listener();
  });
}
