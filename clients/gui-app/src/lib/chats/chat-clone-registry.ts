/**
 * Continues a chat on another host from a surface that sits beside its tile
 * rather than inside it: the composer's sandbox refusal and a bound send's
 * pending row. The chat's own tile registers its opener while mounted - the
 * chat's fork dialog on the whole chat, which moves the composer's draft to
 * the clone once the clone exists - and those surfaces call it by chat id.
 *
 * A stack per chat, like the active model picker's: a second pane on the same
 * chat answers while it is mounted and hands back to the first when it goes.
 */
import { useSyncExternalStore } from "react";

const openersByChatId = new Map<string, Array<() => void>>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function registerChatCloneOpener(
  chatId: string,
  open: () => void,
): () => void {
  const openers = openersByChatId.get(chatId) ?? [];
  openersByChatId.set(chatId, [...openers, open]);
  notify();
  return () => {
    const current = openersByChatId.get(chatId) ?? [];
    const remaining = current.filter((entry) => entry !== open);
    if (remaining.length === 0) openersByChatId.delete(chatId);
    else openersByChatId.set(chatId, remaining);
    notify();
  };
}

/** Opens the clone flow for `chatId`; `false` when no tile of it is mounted. */
export function openChatClone(chatId: string): boolean {
  const openers = openersByChatId.get(chatId);
  if (openers === undefined) return false;
  openers[openers.length - 1]();
  return true;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Whether a tile of `chatId` can open its clone flow, so the remedy is offered. */
export function useChatCloneAvailable(chatId: string): boolean {
  const read = (): boolean => openersByChatId.has(chatId);
  return useSyncExternalStore(subscribe, read, read);
}
