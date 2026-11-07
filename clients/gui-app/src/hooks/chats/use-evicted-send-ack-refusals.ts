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
 * Only refusals that arrive while this is mounted count: an earlier ack or
 * notice was said before this tile watched. The ack signal survives a notice
 * replaced by SEND_NOT_RECORDED when a newer draft wins restoration.
 */
export function useEvictedSendAckRefusals(
  handle: ChatSessionStoreHandle,
  refuse: (() => void) | null,
): void {
  useEffect(() => {
    if (refuse === null) return;
    const initialState = handle.store.getState();
    const initial = initialState.errorNotices;
    const seenRefusals = new WeakSet<{ readonly clientActionId: string }>();
    if (initialState.evictedSendRefusal !== null)
      seenRefusals.add(initialState.evictedSendRefusal);
    const seen = new WeakSet<ChatErrorNotice>(initial);
    // The ring this last scanned, not the listener's `previous`: a listener
    // that sets the store inside an update has zustand call this one with the
    // nested state first and the outer update's result as `previous`.
    let scanned = initial;
    return handle.store.subscribe((state) => {
      const ack = state.evictedSendRefusal;
      if (ack !== null && !seenRefusals.has(ack)) {
        seenRefusals.add(ack);
        refuse();
      }
      if (state.errorNotices === scanned) return;
      scanned = state.errorNotices;
      for (const notice of scanned) {
        if (seen.has(notice)) continue;
        seen.add(notice);
        // The ack signal already said this, even if its notice instead had
        // to quote a displaced prompt as SEND_NOT_RECORDED.
        if (ack !== null && notice.clientActionId === ack.clientActionId)
          continue;
        if (isEvictedChatRefusal(notice.code)) refuse();
      }
    });
  }, [handle, refuse]);
}
