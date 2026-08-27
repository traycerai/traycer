import { useCallback, useSyncExternalStore } from "react";
import {
  getBrowserViewSnapshot,
  subscribeBrowserViewSnapshot,
  type BrowserViewSnapshotState,
} from "@/lib/browser-view/tiles/browser-overlay-coordinator";
import type { BrowserViewTileKey } from "@traycer-clients/shared/platform/browser-view";

export function useBrowserViewSnapshot(
  tileKey: BrowserViewTileKey,
): BrowserViewSnapshotState | null {
  const subscribe = useCallback(
    (listener: () => void) => subscribeBrowserViewSnapshot(tileKey, listener),
    [tileKey],
  );
  const readSnapshot = useCallback(
    () => getBrowserViewSnapshot(tileKey),
    [tileKey],
  );
  return useSyncExternalStore(subscribe, readSnapshot, () => null);
}
