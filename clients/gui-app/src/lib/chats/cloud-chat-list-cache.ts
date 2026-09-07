import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { ListCloudChatsResponse } from "@traycer/protocol/host/epic/cloud-chat";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { cloudRowIsViewersOwn } from "@/lib/chats/unified-chat-list";
import { queryKeys } from "@/lib/query-keys";
import { useAuthStore } from "@/stores/auth/auth-store";

/** The `epic.listCloudChats` answer, read WITHOUT a React observer. */

const LIST_CLOUD_CHATS_METHOD = "epic.listCloudChats" as const;

const EMPTY_CHAT_ID_SET: ReadonlySet<string> = new Set<string>();

/** The `cacheKeyIdentity` `useCloudChatList` declares, as its ONE owner. */
export function cloudChatListCacheKeyIdentity(
  viewerUserId: string,
): ReadonlyArray<string> {
  return [viewerUserId];
}

/** The exact cache slot `useCloudChatList` writes. */
export function cloudChatListQueryKey(args: {
  readonly hostId: string | null;
  readonly viewerUserId: string;
  readonly taskId: string;
}): QueryKey {
  return [
    ...queryKeys.hostMethod<HostRpcRegistry, typeof LIST_CLOUD_CHATS_METHOD>(
      args.hostId,
      LIST_CLOUD_CHATS_METHOD,
      { taskId: args.taskId },
    ),
    ...cloudChatListCacheKeyIdentity(args.viewerUserId),
  ];
}

/** The signed-in viewer, for the caller that cannot use `useCloudChatViewerId`. */
export function cloudChatViewerIdSnapshot(): string {
  return useAuthStore.getState().contextMetadata?.userId ?? "";
}

/**
 * Viewer's own cloud chat ids, or `null` when this cache holds no answer that may be acted on.
 * A request that cannot be formed is `null`, not an empty set.
 */
export function readCloudKnownChatIds(
  queryClient: QueryClient,
  args: {
    readonly hostId: string | null;
    readonly viewerUserId: string;
    readonly taskId: string;
  },
): ReadonlySet<string> | null {
  if (
    args.hostId === null ||
    args.viewerUserId.length === 0 ||
    args.taskId.length === 0
  ) {
    return null;
  }
  const state = queryClient.getQueryState<ListCloudChatsResponse, HostRpcError>(
    cloudChatListQueryKey(args),
  );
  if (state === undefined) return null;
  if (state.status === "error") {
    return state.error?.code === "E_HOST_UNSUPPORTED"
      ? EMPTY_CHAT_ID_SET
      : null;
  }
  if (state.status !== "success" || state.data === undefined) return null;
  return new Set(
    state.data.chats
      .filter(cloudRowIsViewersOwn)
      .map((chat) => chat.identity.chatId),
  );
}
