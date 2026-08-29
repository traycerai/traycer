import { useCallback, useRef, useSyncExternalStore } from "react";
import {
  acquireBrowserMediaEntry,
  createBrowserMediaPeer,
  type BrowserMediaEntry,
} from "@/lib/browser-view/tiles/webrtc-media-registry";

/**
 * PiP's half of the video plane: a PASSIVE attach to whatever track the tile's
 * negotiation already produced for this `(hostId, sessionId, tabId)`.
 *
 * PiP is the registry's second consumer, and deliberately the mute one (spec
 * decision 13 - surfaces within one client share the client's track):
 *
 * - It never calls `acceptOffer`, so it starts no negotiation round of its own
 *   and cannot renumber the `negotiationId` the tile's round runs on.
 * - It never calls `reportFirstDecodedFrame` / `reportFailure`, so one sink's
 *   deadline can never tear down media the other is painting, and PiP's own
 *   screencast subscriber is never the one that reported `live` - the host
 *   disables the JPEG pump per SUBSCRIBER, so PiP's frames keep flowing.
 * - The host does not even offer to a `role: "pip"` viewer (see
 *   `browser-screencast-plane.ts`, video-plane hook 1/3).
 *
 * So the shape is: render the shared track if one exists, fall back to the
 * JPEG path if it does not. Tile closed, PiP still up: the refcount keeps the
 * client's `RTCPeerConnection` object alive, but the HOST tears the media down
 * anyway - the tile's detach releases the capture helper, which finds no
 * non-idle viewer left for that tab and closes it (`releaseHelper` ->
 * `closeHelper`). The track ends, the registry's own `onFailure` fires, and
 * the snapshot goes `failed` with a null stream. PiP drops back to JPEG with
 * no gap, because its own pump never stopped.
 *
 * The acquire is what holds that refcount, and it lives in the
 * `useSyncExternalStore` subscription because that is the one callback whose
 * teardown React guarantees. The peer factory is handed over only to satisfy
 * the registry's constructor (a record PiP creates first would use it, and it
 * is the same factory the tile passes) and is never invoked from here.
 */
export function usePipSharedVideoStream(input: {
  readonly hostId: string;
  readonly sessionId: string;
  readonly tabId: string;
}): MediaStream | null {
  const { hostId, sessionId, tabId } = input;
  const entryRef = useRef<BrowserMediaEntry | null>(null);
  const attachable =
    hostId.length > 0 && sessionId.length > 0 && tabId.length > 0;

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!attachable) return () => {};
      const handle = acquireBrowserMediaEntry({
        key: { hostId, sessionId, tabId },
        createPeer: createBrowserMediaPeer,
      });
      entryRef.current = handle.entry;
      onStoreChange();
      const unsubscribe = handle.entry.subscribe(onStoreChange);
      return () => {
        unsubscribe();
        entryRef.current = null;
        handle.release();
      };
    },
    [attachable, hostId, sessionId, tabId],
  );

  const readStream = useCallback((): MediaStream | null => {
    const snapshot = entryRef.current?.getSnapshot() ?? null;
    if (snapshot === null || snapshot.phase !== "streaming") return null;
    return snapshot.stream;
  }, []);

  return useSyncExternalStore(subscribe, readStream, readStream);
}
