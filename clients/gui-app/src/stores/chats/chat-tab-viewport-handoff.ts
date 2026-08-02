/**
 * Ticket 20 (painted-chat lifecycle audit, finding 1): cross-pane drag, edge
 * split/wrap, dissolve promotion, and header tear-off retain a chat tile's
 * `instanceId` but delete+create its keyed layer in ONE store update. React
 * renders the replacement fiber - including its render-time
 * `restoreChatTabState` state initializer - BEFORE the removed fiber's
 * `useLayoutEffect` unmount cleanup ever runs (render happens before ANY
 * commit-phase effect), so the replacement necessarily reads whatever was
 * ALREADY in the tab-key scroll cache instead of the position the reader
 * actually left the transcript at.
 *
 * This module-scope registry lets the canvas store's structural-mutation
 * action creators flush a chat tile's CURRENT live viewport into the cache
 * SYNCHRONOUSLY, before the `set()` that moves it - same registry-read shape
 * as the ticket-15 close-sweep promotion (`promoteChatTabPersistenceToDurable`
 * in `chat-tab-persistence-eviction.ts`), reused rather than reinvented. A
 * mounted `ChatMessages` registers its capture callback for the lifetime of
 * the mount (`chat-messages.tsx`); the callback runs the SAME coherent-
 * snapshot logic the component's own unmount cleanup uses, so both paths can
 * never drift out of sync with each other.
 */
import { appLogger } from "@/lib/logger";

type ChatTabViewportCapture = () => void;

const liveViewportCaptures = new Map<string, ChatTabViewportCapture>();

/**
 * Registers `capture` for `instanceId` while a `ChatMessages` tile is
 * mounted; returns the unregister function for the component's own unmount
 * cleanup. There is never more than one live mount per `instanceId`.
 */
export function registerChatTabViewportCapture(
  instanceId: string,
  capture: ChatTabViewportCapture,
): () => void {
  liveViewportCaptures.set(instanceId, capture);
  return () => {
    if (liveViewportCaptures.get(instanceId) === capture) {
      liveViewportCaptures.delete(instanceId);
    }
  };
}

/**
 * Calls the registered capture callback for each of `instanceIds`, if (and
 * only if) that tile is currently mounted - a no-op for any id with no live
 * registration (not a chat tile, or already unmounted). Defensive by design:
 * a caller unsure whether a specific structural mutation will actually move
 * a given tile (e.g. an edge split's target pane, which only wraps - and
 * therefore only remounts - under some parent-direction shapes) can flush it
 * unconditionally: capturing a tile's current position when it turns out NOT
 * to move is harmless, since the tile stays mounted and its own later
 * save/unmount simply overwrites the entry again.
 */
export function flushChatTabViewportHandoff(
  instanceIds: ReadonlyArray<string>,
): void {
  for (const instanceId of instanceIds) {
    try {
      liveViewportCaptures.get(instanceId)?.();
    } catch (error) {
      appLogger.error(
        "chat tab viewport capture failed during structural handoff",
        { instanceId },
        error,
      );
    }
  }
}
