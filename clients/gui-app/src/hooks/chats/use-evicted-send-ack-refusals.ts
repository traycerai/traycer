import { useEffect } from "react";
import type { ChatErrorNotice } from "@traycer/protocol/host/agent/gui/subscribe";
import {
  evictedChatRefusalOfCode,
  type EvictedChatRefusal,
} from "@/lib/chats/evicted-chat-refusal";
import type { ChatSessionStoreHandle } from "@/stores/chats/chat-session-store";

/**
 * Hands `refuse` each refusal a chat's host sent on a rejected message's ack
 * because it could not bring the chat back (`CHAT_EVICTED_*`): the host held
 * no records and the client did not know it, so the message went to the host
 * instead of being parked. The composer's line says it, so the toast layer
 * shows none (`ChatTileErrorNoticeToasts`).
 *
 * Only notices that arrive while this is mounted count: one already in the
 * ring was said before this tile watched. A refusal whose message claimed the
 * failed-send slot is handed over once the slot is consumed, so the draft it
 * records is the message back in the composer, not the one before it.
 */
export function useEvictedSendAckRefusals(
  handle: ChatSessionStoreHandle,
  refuse: ((refusal: EvictedChatRefusal) => void) | null,
): void {
  useEffect(() => {
    if (refuse === null) return;
    const seen = new WeakSet<ChatErrorNotice>(
      handle.store.getState().errorNotices,
    );
    let awaiting: {
      readonly clientActionId: string;
      readonly refusal: EvictedChatRefusal;
    } | null = null;
    return handle.store.subscribe((state, previous) => {
      if (
        awaiting !== null &&
        state.failedSendRestoration?.clientActionId !== awaiting.clientActionId
      ) {
        const { refusal } = awaiting;
        awaiting = null;
        refuse(refusal);
      }
      if (state.errorNotices === previous.errorNotices) return;
      for (const notice of state.errorNotices) {
        if (seen.has(notice)) continue;
        seen.add(notice);
        const refusal = evictedChatRefusalOfCode(notice.code);
        if (refusal === null) continue;
        const clientActionId = notice.clientActionId;
        if (
          clientActionId !== null &&
          state.failedSendRestoration?.clientActionId === clientActionId
        ) {
          awaiting = { clientActionId, refusal };
          continue;
        }
        refuse(refusal);
      }
    });
  }, [handle, refuse]);
}
