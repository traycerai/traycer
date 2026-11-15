import { use, useCallback, useSyncExternalStore } from "react";
import {
  EpicSessionContext,
  getOpenEpicRegistry,
} from "@/lib/registries/epic-session-registry";
import {
  chatRecordKey,
  chatRecordKeyNamesChat,
} from "@/stores/epics/open-epic/chat-record-head";

/**
 * Who started one chat, as the host that holds it says on the chat's row: a
 * user id, the literal `"system"`, or `null` when nothing says (an older host,
 * another computer's replica row, or no epic session to read).
 *
 * Keyed on the record identity and read off the epic session's starter plane,
 * as `useEpicChatRecordHead` reads the head; `epicId` guards against reading
 * one epic's table for another's chat.
 */
export function useEpicChatStarter(
  epicId: string,
  ownerUserId: string | null,
  chatId: string,
): string | null {
  const handle = use(EpicSessionContext);
  const store =
    handle !== null && handle.epicId === epicId ? handle.store : null;
  const key =
    ownerUserId === null || ownerUserId.length === 0
      ? null
      : chatRecordKey(ownerUserId, chatId);
  const subscribe = useCallback(
    (onChange: () => void) =>
      store === null ? () => undefined : store.subscribe(onChange),
    [store],
  );
  const getSnapshot = useCallback((): string | null => {
    if (store === null || key === null) return null;
    const starters = store.getState().chatRecordStarters;
    return Object.hasOwn(starters, key) ? starters[key] : null;
  }, [store, key]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * {@link useEpicChatStarter} for a surface outside the task, which knows the
 * chat by id alone (a notification row): read from the task's live session
 * while one is open, else `null`. Asks the host for nothing. Two owners'
 * same-id chats that disagree say nothing.
 */
export function useOpenEpicChatStarter(
  epicId: string | null,
  chatId: string | null,
): string | null {
  const registry = getOpenEpicRegistry();
  const subscribe = useCallback(
    (onChange: () => void) => {
      let unsubscribeStore = (): void => undefined;
      const bindStore = (): void => {
        unsubscribeStore();
        const handle = epicId === null ? null : registry.peek(epicId);
        unsubscribeStore =
          handle === null ? () => undefined : handle.store.subscribe(onChange);
      };
      bindStore();
      const unsubscribeRegistry = registry.subscribe(() => {
        bindStore();
        onChange();
      });
      return () => {
        unsubscribeRegistry();
        unsubscribeStore();
      };
    },
    [registry, epicId],
  );
  const getSnapshot = useCallback((): string | null => {
    if (epicId === null || chatId === null) return null;
    const handle = registry.peek(epicId);
    if (handle === null) return null;
    const starters = handle.store.getState().chatRecordStarters;
    const stated = new Set(
      Object.keys(starters)
        .filter((key) => chatRecordKeyNamesChat(key, chatId))
        .map((key) => starters[key]),
    );
    return stated.size === 1 ? [...stated][0] : null;
  }, [registry, epicId, chatId]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
