import { useEffect } from "react";
import type { ChatErrorNotice } from "@traycer/protocol/host/agent/gui/subscribe";
import { isEvictedChatRefusal } from "@/lib/chats/evicted-chat-refusal";
import type { ChatSessionStoreHandle } from "@/stores/chats/chat-session-store";

/**
 * Calls `refuse` for each refusal a chat's host sent on a rejected message's
 * ack because it could not bring the chat back (`CHAT_EVICTED_*`): the host
 * held no records and the client did not know it, so the message went to the
 * host instead of being parked. The message itself fails like any failed send
 * (`onActionAck`); this only sends the next one through the hydrate first.
 *
 * Only notices that arrive while this is mounted count: one already in the
 * ring was said before this tile watched.
 */
export function useEvictedSendAckRefusals(
  handle: ChatSessionStoreHandle,
  refuse: (() => void) | null,
): void {
  useEffect(() => {
    if (refuse === null) return;
    const initial = handle.store.getState().errorNotices;
    const seen = new WeakSet<ChatErrorNotice>(initial);
    // The ring this last scanned, not the listener's `previous`: a listener
    // that sets the store inside an update has zustand call this one with the
    // nested state first and the outer update's result as `previous`.
    let scanned = initial;
    return handle.store.subscribe((state) => {
      if (state.errorNotices === scanned) return;
      scanned = state.errorNotices;
      for (const notice of scanned) {
        if (seen.has(notice)) continue;
        seen.add(notice);
        if (isEvictedChatRefusal(notice.code)) refuse();
      }
    });
  }, [handle, refuse]);
}
