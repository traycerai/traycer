import { useCallback, useSyncExternalStore } from "react";
import type { ChatServingKey } from "@traycer-clients/shared/host-client/host-rpc-routing";

/**
 * Chats a tile is continuing on their own host although the serving witness
 * still reads them at rest.
 *
 * A chat's host answers `epic.hydrateChat` as soon as it holds the chat's
 * records again. Clearing the server's eviction fact is a separate,
 * best-effort call, so the witness may stay at rest for a while, or for good
 * if that call fails, until the chat's next publication clears it. The
 * host's answer is therefore the release: from then on the chat is served by
 * its own host, whose records are back, so the transcript does not blank.
 *
 * Counted per chat, because two tiles may show one chat. A holder releases
 * when the witness no longer holds the chat at rest, or when its tile
 * closes.
 */
const holders = new Map<string, number>();
const listeners = new Set<() => void>();

function keyOf(chat: ChatServingKey): string {
  return JSON.stringify([chat.hostId, chat.epicId, chat.chatId]);
}

function notify(): void {
  for (const listener of listeners) listener();
}

/** Continues `chat` on its own host until the returned release runs. */
export function holdChatOnItsHost(chat: ChatServingKey): () => void {
  const key = keyOf(chat);
  holders.set(key, (holders.get(key) ?? 0) + 1);
  notify();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (holders.get(key) ?? 1) - 1;
    if (remaining > 0) holders.set(key, remaining);
    else holders.delete(key);
    notify();
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useChatContinuingOnItsHost(chat: ChatServingKey): boolean {
  const key = keyOf(chat);
  const read = useCallback(() => holders.has(key), [key]);
  return useSyncExternalStore(subscribe, read, read);
}
