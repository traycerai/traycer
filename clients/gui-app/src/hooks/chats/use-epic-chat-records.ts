import { useEffect, useMemo } from "react";
import type { QueryClient } from "@tanstack/react-query";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useHostClient } from "@/lib/host/runtime";
import { hostQueryKeys } from "@/lib/query-keys";
import { useMaybeOpenEpicHandle } from "@/providers/use-open-epic-handle";

/**
 * Feeds the epic session's record table from the host's chat registry.
 *
 * ## What this closes
 *
 * `OpenEpicStore.chats` used to have exactly one producer: the epic Y.Doc's
 * `chats` map. Since chat-sync-v2 nothing maintains that map - a chat created
 * after the upgrade never gets an entry (ticket 19) and the upgrade sweep
 * deletes the entries it can prove published (ticket 20) - so the renderer's
 * record set was a frozen, shrinking remainder. A chat with no record has no
 * tree row, no rename/archive affordances, and (through a record-gated
 * subscribe) opened as its read-only published copy on its own owning host.
 * This hook is the other producer; the store unions the two.
 *
 * ## Doc-only mode is a designed state
 *
 * A host that predates `epic.listChatRecords` answers `E_HOST_UNSUPPORTED`. The
 * store is then never told about any records and `chats` stays exactly the doc
 * projection - which is that host's own, correct, record table, since a host
 * without this method is a host that still maintained the doc. No toast, no
 * empty state: there is nothing for the user to act on, and the retry predicate
 * stops immediately rather than spending attempts on a permanent answer.
 *
 * A transport FAILURE is treated the same way this file treats every partial
 * answer: the last known rows stay published. Clearing them on a failed refetch
 * would make every network blip delete the tree rows the channel exists to
 * restore.
 *
 * ## Change signal
 *
 * Polled (20s, `HOST_METHOD_POLL_TABLE`) plus explicit invalidation from the
 * chat mutations this client makes ({@link invalidateEpicChatRecords}). There is
 * no push edge to ride: these facts are committed to the chat database, which
 * has no per-epic wire channel to this renderer - the epic Y.Doc's update stream
 * is the only one, and it is precisely what stopped carrying them.
 */
export function useEpicSyncChatRecords(epicId: string): void {
  // The app-wide active host, matching the epic session itself: the session is
  // acquired for `useReactiveActiveHostId()` and rebuilt when it changes, so
  // asking any other host for this epic's records would answer about a registry
  // the session is not projecting.
  const client = useHostClient();
  const handle = useMaybeOpenEpicHandle();
  const params = useMemo(() => ({ epicId }), [epicId]);
  // Viewer-scoped, exactly like the cloud-chat reads: the response is one
  // identity's own chats, so two users on one installation have different
  // correct answers and must never share a cache slot.
  const viewerUserId = useCloudChatViewerId();
  const query = useHostQuery<HostRpcRegistry, "epic.listChatRecords">({
    cacheKeyIdentity: [viewerUserId],
    client,
    method: "epic.listChatRecords",
    params,
    options: {
      enabled: epicId.length > 0 && viewerUserId.length > 0,
      staleTime: 10_000,
      // Opt in to the table's fixed cadence. A `fixed` poll policy is OPT-IN
      // in `useHostQuery` (only `condition` policies poll by default), so
      // without this the 20s the table declares - and the paragraph above
      // promises - is never armed: `refetchInterval` stays `false` and the
      // only thing left refreshing the list is a window-focus refetch.
      poll: true,
      retry: (failureCount, error) =>
        error.code !== "E_HOST_UNSUPPORTED" && failureCount < 2,
    },
  });

  const chats = query.data?.chats ?? null;
  const store = handle?.store ?? null;
  useEffect(() => {
    if (chats === null || store === null) return;
    store.getState().applyChatRecords(chats);
  }, [chats, store]);
}

/**
 * Drops this host's cached record list so the next read re-asks.
 *
 * Called by the chat mutations after the host has committed one, because the
 * commit lands in the chat database and NOTHING carries it back to this
 * renderer on its own: a rename, re-parent or archive of a chat with no doc
 * entry is invisible until this list is read again. Without it those
 * affordances would appear to do nothing for up to one poll interval, which is
 * the same "the click did nothing" the record channel exists to fix.
 *
 * Scoped to the method (every epic's list on that host), not to one epic's
 * params: a mutation knows the record it changed, and the epic-scoped key is
 * the params object it would have to reconstruct exactly to hit the slot.
 *
 * ## Why plain invalidation, and not an explicit fetch
 *
 * TanStack's defaults already cover the three states this key can be in when a
 * mutation lands, so nothing more is needed here:
 *  - MOUNTED AND ENABLED (the create-then-open case: the modal and the fork
 *    dialog both live inside the epic route, which mounts the sync hook) -
 *    `refetchType` defaults to `"active"`, so it refetches immediately; and
 *    `refetchQueries` defaults to `cancelRefetch: true`, so a read that was
 *    already in flight when the mutation landed - and would have answered from
 *    BEFORE the write - is cancelled and re-issued rather than allowed to
 *    settle and clear the invalidation.
 *  - CACHED BUT INACTIVE - marked invalid, hence stale, so the next observer
 *    to mount fetches rather than serving the cached rows.
 *  - NOT IN THE CACHE AT ALL (the epic just opened) - the first mount fetches
 *    anyway.
 * A `refetchType: "all"` would additionally re-read every OTHER open epic's
 * list on this host, since this key is method-scoped, for no gain.
 */
export function invalidateEpicChatRecords(
  queryClient: QueryClient,
  hostId: string | null,
): void {
  void queryClient.invalidateQueries({
    queryKey: hostQueryKeys.methodScope(hostId, "epic.listChatRecords"),
  });
}
