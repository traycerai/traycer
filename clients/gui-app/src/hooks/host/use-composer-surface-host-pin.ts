import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import {
  useSurfaceHostPin,
  type SurfaceHostPin,
} from "@/hooks/host/use-surface-host-pin";
import { useWindowsBridge } from "@/providers/windows-bridge-context";
import {
  browserTabId,
  subscribeBrowserTabId,
} from "@/lib/browser-tab-identity";
import {
  composerSurfaceKey,
  useSurfaceHostSelectionStore,
} from "@/stores/host/surface-host-selection-store";

/** Window-scoped pin key so landing and the new-conversation modal agree. Browser uses browserTabId(), never a shared "browser" key. */
export function useComposerSurfaceHostKey(): string {
  const bridgeWindowId = useWindowsBridge()?.windowId ?? null;
  // Subscribe to the tab id; it is not lifetime-stable. A duplicate regenerates the original's id off-render, and a one-shot resolve leaves it on the superseded key.
  const readWindowId = useCallback(
    () => bridgeWindowId ?? browserTabId(),
    [bridgeWindowId],
  );
  const windowId = useSyncExternalStore(subscribeBrowserTabId, readWindowId);
  const surfaceKey = useMemo(() => composerSurfaceKey(windowId), [windowId]);
  // Carry the pin onto the new key and clear the source. Idempotent: two mounts in one window must not overwrite a selection already made under the new identity.
  const previousSurfaceKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const previous = previousSurfaceKeyRef.current;
    previousSurfaceKeyRef.current = surfaceKey;
    // First resolution is not a rotation - there is nothing to carry, and
    // treating it as one would move a pin on every mount.
    if (previous === null || previous === surfaceKey) return;
    useSurfaceHostSelectionStore
      .getState()
      .migrateSelection(previous, surfaceKey);
  }, [surfaceKey]);
  return surfaceKey;
}

/** `selection === null` follows the effective host; `resolvedHostId` is what the chip renders and what every create the composer performs must address (selection model §54 - the composer is placement, and its resolved host decides where a chat/epic lives for life). */
export function useComposerSurfaceHostPin(): SurfaceHostPin {
  const surfaceKey = useComposerSurfaceHostKey();
  return useSurfaceHostPin(surfaceKey);
}
