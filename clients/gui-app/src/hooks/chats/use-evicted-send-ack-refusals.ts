import { useEffect } from "react";
import type { ChatErrorNotice } from "@traycer/protocol/host/agent/gui/subscribe";
import {
  evictedChatRefusalOfCode,
  type EvictedChatRefusal,
} from "@/lib/chats/evicted-chat-refusal";
import { SEND_NOT_RECORDED_NOTICE_CODE } from "@/stores/chats/chat-queue-reconciler";
import type { ChatSessionStoreHandle } from "@/stores/chats/chat-session-store";

interface PendingRefusal {
  readonly clientActionId: string | null;
  readonly refusal: EvictedChatRefusal;
}

interface NoticeScan {
  readonly fresh: readonly PendingRefusal[];
  /** Actions displaced into `SEND_NOT_RECORDED`: not in the composer. */
  readonly displaced: ReadonlySet<string>;
}

const NOTHING_NEW: NoticeScan = { fresh: [], displaced: new Set() };

/**
 * Whether a notice settles its message's action here: a `CHAT_EVICTED_*`
 * refusal, or `SEND_NOT_RECORDED`, which says the message itself and never
 * reaches the composer.
 */
function settlesAction(notice: ChatErrorNotice): boolean {
  return (
    notice.code === SEND_NOT_RECORDED_NOTICE_CODE ||
    evictedChatRefusalOfCode(notice.code) !== null
  );
}

/**
 * The refusals and displacements among the notices not seen yet. The first
 * notice for an action settles it: a later one for that action is not a
 * refusal, but a displacement still counts, since a refusal waiting on its
 * slot can be displaced after it settled.
 */
function scanNotices(
  notices: readonly ChatErrorNotice[],
  seen: WeakSet<ChatErrorNotice>,
  settled: Set<string>,
): NoticeScan {
  const fresh: PendingRefusal[] = [];
  const displaced = new Set<string>();
  for (const notice of notices) {
    if (seen.has(notice)) continue;
    seen.add(notice);
    const clientActionId = notice.clientActionId;
    if (notice.code === SEND_NOT_RECORDED_NOTICE_CODE) {
      if (clientActionId === null) continue;
      settled.add(clientActionId);
      displaced.add(clientActionId);
      continue;
    }
    if (clientActionId !== null && settled.has(clientActionId)) continue;
    const refusal = evictedChatRefusalOfCode(notice.code);
    if (refusal === null) continue;
    if (clientActionId !== null) settled.add(clientActionId);
    fresh.push({ clientActionId, refusal });
  }
  return { fresh, displaced };
}

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
 *
 * One action refuses at most once. The host answers a refused message twice,
 * on its ack and then in its own notice, so the first notice for an action
 * settles it and every later one for that action is ignored. A message
 * displaced into `SEND_NOT_RECORDED` is not in the composer, so it settles
 * with no refusal, a hand-over still waiting on its slot included.
 */
export function useEvictedSendAckRefusals(
  handle: ChatSessionStoreHandle,
  refuse: ((refusal: EvictedChatRefusal) => void) | null,
): void {
  useEffect(() => {
    if (refuse === null) return;
    const initial = handle.store.getState().errorNotices;
    const seen = new WeakSet<ChatErrorNotice>(initial);
    const settled = new Set<string>();
    for (const notice of initial) {
      if (notice.clientActionId !== null && settlesAction(notice)) {
        settled.add(notice.clientActionId);
      }
    }
    let awaiting:
      | (PendingRefusal & { readonly clientActionId: string })
      | null = null;
    // The ring this last scanned, not the listener's `previous`: a listener
    // that sets the store inside an update has zustand call this one with the
    // nested state first and the outer update's result as `previous`, so the
    // ring reads unchanged while the slot already moved.
    let scanned = initial;
    return handle.store.subscribe((state) => {
      const { fresh, displaced } =
        state.errorNotices === scanned
          ? NOTHING_NEW
          : scanNotices(state.errorNotices, seen, settled);
      scanned = state.errorNotices;
      const slot = state.failedSendRestoration?.clientActionId ?? null;
      if (awaiting !== null && displaced.has(awaiting.clientActionId)) {
        awaiting = null;
      }
      if (awaiting !== null && slot !== awaiting.clientActionId) {
        const { refusal } = awaiting;
        awaiting = null;
        refuse(refusal);
      }
      for (const { clientActionId, refusal } of fresh) {
        if (clientActionId !== null && displaced.has(clientActionId)) continue;
        if (clientActionId !== null && slot === clientActionId) {
          awaiting = { clientActionId, refusal };
          continue;
        }
        refuse(refusal);
      }
    });
  }, [handle, refuse]);
}
