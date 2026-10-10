import { appLogger } from "@/lib/logger";
import type { DesktopWindowsBridge } from "@/lib/windows/types";
import {
  hasBrowserMediaEntries,
  subscribeBrowserMediaPresence,
} from "./webrtc-media-registry";

/**
 * Keep this desktop window rendering while it is unseen exactly as long as it
 * holds a browser tile's WebRTC media entry.
 *
 * Desktop windows are background-throttled, so a covered, minimised or hidden
 * window goes `"hidden"` and stops rendering, like a background tab. The video
 * plane's receiver is the one consumer that must not stop: throttled, its
 * stats timers and `requestVideoFrameCallback` go silent and the sender
 * ratchets its capture rate down for the rest of the session (#1613). Main
 * owns the switch (`electron-main/windows/background-rendering.ts`); this
 * module reports the registry's edges, deduplicated, and re-asserts the
 * current answer at install, which is what puts each new document's demand in
 * place.
 *
 * The demand is "any media entry", which is broader than "a plane that is
 * streaming": it also holds while a tile negotiates, after a fallback to JPEG,
 * and through the release grace. That errs toward the pre-#2355 behaviour,
 * and only for as long as a remote browser tile is mounted.
 *
 * Capability-probed: a preload without `backgroundRendering` belongs to a
 * main that never throttles GUI windows, so there is nothing to ask for.
 */
export function installDesktopBackgroundRendering(
  bridge: DesktopWindowsBridge,
): () => void {
  const channel = bridge.backgroundRendering;
  if (channel === undefined) return () => undefined;
  let lastSent: boolean | null = null;
  const send = (required: boolean): void => {
    if (lastSent === required) return;
    lastSent = required;
    void channel.setRequired(required).catch((cause: unknown) => {
      // Unknown again, so the next edge is sent rather than deduplicated
      // against an answer main never applied.
      if (lastSent === required) lastSent = null;
      appLogger.warn("[browser-view] could not set background rendering", {
        required,
        cause: cause instanceof Error ? cause.message : String(cause),
      });
    });
  };
  send(hasBrowserMediaEntries());
  const unsubscribe = subscribeBrowserMediaPresence(send);
  return () => {
    unsubscribe();
    send(false);
  };
}
