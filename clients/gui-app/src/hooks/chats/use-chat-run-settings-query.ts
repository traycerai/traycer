import type { UseQueryResult } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  HostRpcError,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostQuery } from "@/hooks/host/use-host-query";

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
 */
export function useChatRunSettings(args: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly epicId: string;
  readonly chatId: string;
  readonly enabled: boolean;
}): UseQueryResult<GetChatRunSettingsResponse, HostRpcError> {
  return useHostQuery<HostRpcRegistry, "epic.getChatRunSettings">({
    cacheKeyIdentity: undefined,
    client: args.client,
    method: "epic.getChatRunSettings",
    params: { epicId: args.epicId, chatId: args.chatId },
    options: {
      enabled: args.enabled,
      staleTime: 60_000,
      refetchOnWindowFocus: false,
      poll: false,
    },
  });
}
