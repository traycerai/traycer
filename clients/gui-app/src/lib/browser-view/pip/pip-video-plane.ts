import { useCallback, useRef, useSyncExternalStore } from "react";
import { compositeKey } from "@/lib/browser-view/tiles/browser-view-keys";
import {
  acquireBrowserMediaEntry,
  createBrowserMediaPeer,
  type BrowserMediaEntry,
} from "@/lib/browser-view/tiles/webrtc-media-registry";

/**
 * Passive PiP attach to the tile's shared track: never `acceptOffer`, never report first-frame/failure.
 * Acquire lives in the `useSyncExternalStore` subscription so React teardown releases the refcount.
 */
export function usePipSharedVideoStream(input: {
  readonly hostId: string;
  readonly sessionId: string;
  readonly tabId: string;
}): MediaStream | null {
  const { hostId, sessionId, tabId } = input;
  const entryRef = useRef<{
    readonly key: string;
    readonly entry: BrowserMediaEntry;
  } | null>(null);
  const key = compositeKey(hostId, sessionId, tabId);
  const attachable =
    hostId.length > 0 && sessionId.length > 0 && tabId.length > 0;

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!attachable) return () => {};
      const handle = acquireBrowserMediaEntry({
        key: { hostId, sessionId, tabId },
        createPeer: createBrowserMediaPeer,
      });
      entryRef.current = { key, entry: handle.entry };
      onStoreChange();
      const unsubscribe = handle.entry.subscribe(onStoreChange);
      return () => {
        unsubscribe();
        entryRef.current = null;
        handle.release();
      };
    },
    [attachable, hostId, key, sessionId, tabId],
  );

  // Keyed: React reads the snapshot during a render whose key has already changed but whose subscription has not been re-run yet, and the entry still held here is the PREVIOUS tab's - painting its track in this tab's mirror.
  const readStream = useCallback((): MediaStream | null => {
    const held = entryRef.current;
    if (held === null || held.key !== key) return null;
    const snapshot = held.entry.getSnapshot();
    if (snapshot.phase !== "streaming") return null;
    return snapshot.stream;
  }, [key]);

  return useSyncExternalStore(subscribe, readStream, readStream);
}
