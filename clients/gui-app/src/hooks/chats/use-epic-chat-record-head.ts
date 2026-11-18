import { use, useCallback, useSyncExternalStore } from "react";
import type { ChatRecordHeadStamp } from "@traycer/protocol/host/epic/chat-records";
import { EpicSessionContext } from "@/lib/registries/epic-session-registry";
import { chatRecordKey } from "@/stores/epics/open-epic/chat-record-head";

/**
 * The cloud publication head the epic session's record table holds for one
 * chat, or `null` - no publication yet, an owner host that predates the head
 * on the row, or no epic session to read.
 *
 * ## Keyed on the record IDENTITY, read off the head plane
 *
 * `(ownerUserId, chatId)`, never `chatId` alone: the id is host-minted and a
 * collaborator can hold the same one under this task. And it reads
 * `chatRecordHeads` rather than `chats.byId` because the projection is
 * filtered to the signed-in owner while the published-copy tile is opened
 * for a collaborator's chat precisely as often as for the viewer's own.
 *
 * ## A selector, so a head change re-renders only its subscriber
 *
 * The stamp objects in the table are stable across publishes that leave them
 * unchanged (see `applyChatRecordHeadRows`), so `useSyncExternalStore`
 * compares by identity and a metadata-only row write costs this subscriber
 * nothing.
 *
 * ## `epicId` is a guard, not a lookup
 *
 * The handle comes from the surrounding `EpicSessionContext` (read directly,
 * the way `useMaybeOpenEpicHandle` reads it), which is the one an epic
 * surface is already rendered under; the id is checked against it so a
 * caller can never read one epic's table for another's chat. A surface
 * outside any epic session - or one whose session is for a different epic -
 * reads `null`, which every consumer treats as today's behaviour.
 */
export function useEpicChatRecordHead(
  epicId: string,
  ownerUserId: string | null,
  chatId: string,
): ChatRecordHeadStamp | null {
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
  const getSnapshot = useCallback((): ChatRecordHeadStamp | null => {
    if (store === null || key === null) return null;
    const heads = store.getState().chatRecordHeads;
    return Object.hasOwn(heads, key) ? heads[key] : null;
  }, [store, key]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
