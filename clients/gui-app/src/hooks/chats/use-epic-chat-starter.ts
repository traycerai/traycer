import { use, useCallback, useSyncExternalStore } from "react";
import { EpicSessionContext } from "@/lib/registries/epic-session-registry";
import { chatRecordKey } from "@/stores/epics/open-epic/chat-record-head";

/**
 * `null` when nothing says (an older host, another computer's replica row, no
 * session). `epicId` guards against reading one epic's table for another's chat.
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
