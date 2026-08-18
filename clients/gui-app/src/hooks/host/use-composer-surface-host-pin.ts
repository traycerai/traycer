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

/**
 * The composer's surface key: window-scoped (selection model §2 / M4).
 *
 * The composer is the one multi-instance surface whose instances must AGREE -
 * a window shows at most one placement composer at a time (the landing
 * composer, or the app-wide new-conversation modal opened over it), and they
 * all place new work on the same machine. Keying per component instance would
 * let the modal silently contradict the landing chip behind it.
 *
 * Outside desktop there is no windows bridge, so the browser TAB is the window
 * - and it has to be identified, not assumed. This used to fold every browser
 * tab onto the literal key `"browser"`, and because the pin store persists to
 * localStorage (origin-wide, not per-tab) a pin chosen in one tab was hydrated
 * by the next one opened or reloaded. The composer is PLACEMENT, so that tab's
 * new epics and chats were created on a machine another tab had picked, for
 * life. The doc here said it folded "the whole browser tab onto one key"; it
 * folded every tab onto one key, which is the bug.
 *
 * `browserTabId()` is the shared claim protocol, not a `sessionStorage` read -
 * see its module for why the difference matters (a duplicated tab inherits its
 * origin's `sessionStorage`). Desktop keeps its bridge `windowId`, which is
 * already stable and finite.
 */
export function useComposerSurfaceHostKey(): string {
  const bridgeWindowId = useWindowsBridge()?.windowId ?? null;
  // SUBSCRIBED, not resolved once. The tab id is NOT stable for a tab's
  // lifetime, which is what an earlier version of this comment claimed: when a
  // tab is duplicated, the tab that observes the collision - the one already
  // holding the id, i.e. the ORIGINAL - regenerates, asynchronously and off
  // any render. Resolving it straight into the memo below left this key on the
  // superseded id, so the original kept reading the pin its duplicate was also
  // reading, until an unrelated render happened to move it.
  //
  // Desktop is untouched: `readWindowId` short-circuits on the bridge, so a
  // desktop window still mints no tab identity and opens no claim channel.
  const readWindowId = useCallback(
    () => bridgeWindowId ?? browserTabId(),
    [bridgeWindowId],
  );
  const windowId = useSyncExternalStore(subscribeBrowserTabId, readWindowId);
  const surfaceKey = useMemo(() => composerSurfaceKey(windowId), [windowId]);
  // THE PIN MOVES WITH THE KEY. Rotating the id without carrying the selection
  // loses the placement of the tab that rotates - which is the ORIGINAL, the
  // one that observed the collision - at the exact moment of a duplication it
  // did not initiate. Clearing the source is the other half: the duplicate is
  // now reading the old key, and a fresh tab inheriting a pin it never chose is
  // the cross-tab bleed the per-tab identity exists to prevent.
  //
  // Idempotent by construction, which matters because a window can mount this
  // hook twice (the landing composer and the new-conversation modal over it):
  // the migration is a no-op once the source key is gone, and it refuses to
  // overwrite a selection already made under the new identity.
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

/**
 * This window's composer host pin. `selection === null` follows the effective
 * host; `resolvedHostId` is what the chip renders and what every create the
 * composer performs must address (selection model §54 - the composer is
 * placement, and its resolved host decides where a chat/epic lives for life).
 *
 * Writing it is the ONLY thing the composer's host picker does: it never
 * moves the app-wide selection, which is Settings ▸ Activate's alone.
 */
export function useComposerSurfaceHostPin(): SurfaceHostPin {
  const surfaceKey = useComposerSurfaceHostKey();
  return useSurfaceHostPin(surfaceKey);
}
