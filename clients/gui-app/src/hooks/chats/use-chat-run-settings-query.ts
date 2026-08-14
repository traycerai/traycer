import { useMemo } from "react";
import type { QueryClient, UseQueryResult } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  HostRpcError,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";
import { hostQueryKeys } from "@/lib/query-keys";

type GetChatRunSettingsResponse = ResponseOfMethod<
  HostRpcRegistry,
  "epic.getChatRunSettings"
>;

/**
 * One chat's persisted run-settings tuple, read from the host that OWNS it.
 *
 * ## Why a host read at all
 *
 * The renderer's chat record table used to carry `settings` because the epic
 * Y.Doc's chat entry did. Since the single-write pivot nothing writes that
 * entry - `chatProjectionFromRecord` honestly reports `settings: null`, because
 * the registry row it projects carries only a harness-id summary - so every
 * surface rendering resolved settings for a chat it has not opened has no local
 * source left. This is that source.
 *
 * ## Passive, and gated by the caller's MOUNT
 *
 * No polling and no focus refetch. Run settings change only when the user
 * changes them, and the one caller (the sidebar hover card) unmounts on close,
 * so a re-open is already a fresh read whenever the entry has gone stale. The
 * `staleTime` is what keeps re-hovering the same row from re-asking the host on
 * every pass of the pointer.
 *
 * ## `client` decides WHICH host, and it is not the tab's
 *
 * Callers pass a client pinned to the chat's own `originHostId`
 * (`useHostClientForHostId`), never the tab-bound or app-active one. A chat
 * living on another of the viewer's hosts is served by that host, which is the
 * only machine holding its chat store - asking the tab's host would get a
 * truthful `null` for a chat whose settings exist perfectly well elsewhere.
 * When that host is not in the directory there is no client to pin, the query
 * never runs, and the caller renders what the record row already gave it.
 *
 * ## VIEWER-scoped, because the RESPONSE is
 *
 * The resolver answers from the calling identity's own registry entry and hands
 * back `{ settings: null }` for a chat the caller does not own, so the reply is
 * a fact about one viewer and must not be cached as a fact about the host/chat
 * pair. The viewer rides the cache key for the same reason spelled out in
 * `use-chat-replica-read.ts`: an auth transition invalidates host queries but
 * does not EVICT their data, so an unscoped slot could hand the next account
 * the previous account's model, permission mode and profile. No viewer resolved
 * means no request, rather than an unattributed one.
 */
export function useChatRunSettings(args: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly epicId: string;
  readonly chatId: string;
  readonly enabled: boolean;
}): UseQueryResult<GetChatRunSettingsResponse, HostRpcError> {
  const viewerUserId = useCloudChatViewerId();
  const params = useMemo(
    () => ({ epicId: args.epicId, chatId: args.chatId }),
    [args.epicId, args.chatId],
  );
  return useHostQuery<HostRpcRegistry, "epic.getChatRunSettings">({
    cacheKeyIdentity: [viewerUserId],
    client: args.client,
    method: "epic.getChatRunSettings",
    params,
    options: {
      enabled: args.enabled && viewerUserId.length > 0,
      staleTime: 60_000,
      refetchOnWindowFocus: false,
      // A host predating this method answers the declared `E_HOST_UNSUPPORTED`,
      // which is PERMANENT - retrying it just doubles a doomed request and its
      // warning log on every hover, and an errored query refetches on the next
      // mount no matter what `staleTime` says. Same predicate as every other
      // optional chat read here. Note this cannot be left to the poll table:
      // `epic.getChatRunSettings` is a `poll: null` method, so `useHostQuery`
      // injects no `retry: false` of its own (only `kind: "condition"` methods
      // get that), and the production default retry would otherwise apply.
      retry: (failureCount, error) =>
        error.code !== "E_HOST_UNSUPPORTED" && failureCount < 2,
    },
  });
}

/**
 * Drop this host's cached run-settings tuples after a write.
 *
 * The host store is the only thing a settings write updates - for a
 * registry-only chat the record row still summarises to a harness id, and for a
 * pre-pivot chat the doc entry is frozen - so nothing about a successful
 * `epic.updateChatRunSettings` / `epic.updateChatProfile` reaches this cache on
 * its own. Without this, changing a model or profile in the composer leaves an
 * already-hovered card showing the old values for a `staleTime` (and for as
 * long as it stays mounted, since a mounted observer will not refetch a fresh
 * entry at all).
 *
 * Method-scoped rather than per chat: the key carries the params AND the viewer,
 * so a `chatId`-precise invalidation would have to reconstruct both, and the
 * entries this drops are single small tuples refetched only on a hover.
 */
export function invalidateChatRunSettings(
  queryClient: QueryClient,
  hostId: string | null,
): void {
  void queryClient.invalidateQueries({
    queryKey: hostQueryKeys.methodScope(hostId, "epic.getChatRunSettings"),
  });
}
