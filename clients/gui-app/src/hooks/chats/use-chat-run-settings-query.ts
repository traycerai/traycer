import { useMemo } from "react";
import type { QueryClient, UseQueryResult } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  HostRpcError,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { GET_CHAT_RUN_SETTINGS_BATCH_MAX_IDS } from "@traycer/protocol/host/epic/chat-records";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useHostQueries } from "@/hooks/host/use-host-queries";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";
import { hostQueryKeys } from "@/lib/query-keys";

type GetChatRunSettingsResponse = ResponseOfMethod<
  HostRpcRegistry,
  "epic.getChatRunSettings"
>;
type GetChatRunSettingsBatchResponse = ResponseOfMethod<
  HostRpcRegistry,
  "epic.getChatRunSettingsBatch"
>;

export type ChatRunSettingsBatchRead = {
  readonly data: GetChatRunSettingsResponse | undefined;
  readonly isPending: boolean;
  readonly isError: boolean;
};

const RUN_SETTINGS_QUERY_OPTIONS = {
  staleTime: 60_000,
  refetchOnWindowFocus: false,
  retry: (failureCount: number, error: HostRpcError) =>
    error.code !== "E_HOST_UNSUPPORTED" && failureCount < 2,
} as const;

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
 * changes them, and settings mutations explicitly invalidate this cache. The
 * `staleTime` keeps passive consumers from re-asking the host on every mount.
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
 * Persisted run-settings tuples for a set of chats owned by one host.
 *
 * The caller must establish the ownership boundary before passing `chatIds`:
 * one requester cannot resolve records owned by another host.
 *
 * On a host that advertised `epic.getChatRunSettingsBatch`, this is one RPC
 * per 50 ids. On an older host it falls back to one `epic.getChatRunSettings`
 * per chat, the same singles {@link useChatRunSettings} uses.
 */
export function useChatRunSettingsBatch(args: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly epicId: string;
  readonly chatIds: ReadonlyArray<string>;
  readonly enabled: boolean;
}): ReadonlyArray<ChatRunSettingsBatchRead> {
  const viewerUserId = useCloudChatViewerId();
  const hostId = args.client?.getActiveHostId() ?? null;
  const batchSupported = useHostMethodSupport(
    hostId,
    "epic.getChatRunSettingsBatch",
  );
  const canQuery = args.enabled && viewerUserId.length > 0;
  // `null` is "handshake not yet known". Firing N singles in that window, then
  // switching to the batch once the manifest lands, is a launch burst the
  // batch method exists to avoid. Wait. `false` is a completed handshake
  // without the method: those hosts stay on singles.
  const useBatch = batchSupported === true;
  const useSingles = batchSupported === false;
  const batchRequests = useMemo(
    () =>
      chunkChatIds(args.chatIds, GET_CHAT_RUN_SETTINGS_BATCH_MAX_IDS).map(
        (chatIds) => ({
          method: "epic.getChatRunSettingsBatch" as const,
          params: { epicId: args.epicId, chatIds: [...chatIds] },
        }),
      ),
    [args.chatIds, args.epicId],
  );
  const singleRequests = useMemo(
    () =>
      useSingles
        ? args.chatIds.map((chatId) => ({
            method: "epic.getChatRunSettings" as const,
            params: { epicId: args.epicId, chatId },
          }))
        : [],
    [args.chatIds, args.epicId, useSingles],
  );
  const batchResults = useHostQueries<
    HostRpcRegistry,
    "epic.getChatRunSettingsBatch",
    BatchSettingsByChatId
  >({
    cacheKeyIdentity: viewerUserId,
    client: args.client,
    requests: batchRequests,
    options: {
      enabled: canQuery && useBatch,
      ...RUN_SETTINGS_QUERY_OPTIONS,
    },
    combine: combineBatchSettings,
  });
  const singleResults = useHostQueries<
    HostRpcRegistry,
    "epic.getChatRunSettings"
  >({
    cacheKeyIdentity: viewerUserId,
    client: args.client,
    requests: singleRequests,
    options: {
      enabled: canQuery && useSingles,
      ...RUN_SETTINGS_QUERY_OPTIONS,
    },
  });
  return useMemo(() => {
    if (useBatch) {
      const unresolved = batchResults.pending || batchResults.failed;
      return args.chatIds.map((chatId) => {
        const settings = batchResults.byChatId.get(chatId);
        return {
          data: unresolved ? undefined : { settings: settings ?? null },
          isPending: batchResults.pending,
          isError: batchResults.failed,
        };
      });
    }
    return singleResults.map((result) => ({
      data: result.data,
      isPending: result.isPending,
      isError: result.isError,
    }));
  }, [args.chatIds, batchResults, singleResults, useBatch]);
}

type BatchSettingsByChatId = {
  readonly byChatId: ReadonlyMap<
    string,
    GetChatRunSettingsResponse["settings"]
  >;
  readonly pending: boolean;
  readonly failed: boolean;
};

function combineBatchSettings(
  results: Array<UseQueryResult<GetChatRunSettingsBatchResponse, HostRpcError>>,
): BatchSettingsByChatId {
  const byChatId = new Map<string, GetChatRunSettingsResponse["settings"]>();
  for (const result of results) {
    if (result.data === undefined) continue;
    for (const entry of result.data.entries) {
      byChatId.set(entry.chatId, entry.settings);
    }
  }
  return {
    byChatId,
    pending: results.some((result) => result.isPending),
    failed: results.some((result) => result.isError),
  };
}

function chunkChatIds(
  ids: ReadonlyArray<string>,
  maxPerChunk: number,
): ReadonlyArray<ReadonlyArray<string>> {
  if (ids.length === 0) return [];
  return Array.from(
    { length: Math.ceil(ids.length / maxPerChunk) },
    (_unused, index) =>
      ids.slice(index * maxPerChunk, (index + 1) * maxPerChunk),
  );
}

/**
 * Drop this host's cached run-settings tuples after a write.
 *
 * The host store is the only thing a settings write updates - for a
 * registry-only chat the record row still summarises to a harness id, and for a
 * pre-pivot chat the doc entry is frozen - so nothing about a successful
 * `epic.updateChatRunSettings` / `epic.updateChatProfile` reaches this cache on
 * its own. Without this, changing a model or profile in the composer leaves
 * mounted consumers showing the old values because a fresh cached entry does
 * not refetch merely because an observer is present.
 *
 * Method-scoped rather than per chat: the key carries the params AND the viewer,
 * so a `chatId`-precise invalidation would have to reconstruct both, and the
 * entries this drops are single small tuples refetched only while a passive
 * consumer needs them.
 */
export function invalidateChatRunSettings(
  queryClient: QueryClient,
  hostId: string | null,
): void {
  void queryClient.invalidateQueries({
    queryKey: hostQueryKeys.methodScope(hostId, "epic.getChatRunSettings"),
  });
  void queryClient.invalidateQueries({
    queryKey: hostQueryKeys.methodScope(hostId, "epic.getChatRunSettingsBatch"),
  });
}
