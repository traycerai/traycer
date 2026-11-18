import type { QueryClient } from "@tanstack/react-query";
import type {
  CloudChatSummary,
  CloudChatVisibility,
  ListCloudChatsResponse,
} from "@traycer/protocol/host/epic/cloud-chat";
import { cloudChatListQueryKey } from "@/lib/chats/cloud-chat-list-cache";
import { cloudChatQueryKeys } from "@/lib/query-keys/cloud-chat-query-keys";

function sameCloudChatIdentity(
  left: CloudChatSummary,
  right: CloudChatSummary,
): boolean {
  return (
    left.identity.taskId === right.identity.taskId &&
    left.identity.ownerUserId === right.identity.ownerUserId &&
    left.identity.chatId === right.identity.chatId
  );
}

function upsertCloudChat(
  chats: readonly CloudChatSummary[],
  chat: CloudChatSummary,
): CloudChatSummary[] {
  const index = chats.findIndex((row) => sameCloudChatIdentity(row, chat));
  if (index === -1) return [...chats, chat];
  return chats.map((row, rowIndex) => (rowIndex === index ? chat : row));
}

/**
 * Fold the returned visibility row into the viewer's `epic.listCloudChats`
 * cache so the sidebar menu label and glyph update without waiting for a
 * refetch. Identity is the triple — `chatId` alone is not unique under a task.
 */
export function reconcileCloudChatSummary(
  queryClient: QueryClient,
  args: {
    readonly hostId: string | null;
    readonly viewerUserId: string;
    readonly chat: CloudChatSummary;
  },
): void {
  if (args.hostId === null || args.viewerUserId.length === 0) return;
  queryClient.setQueryData<ListCloudChatsResponse>(
    cloudChatListQueryKey({
      hostId: args.hostId,
      viewerUserId: args.viewerUserId,
      taskId: args.chat.identity.taskId,
    }),
    (previous) => {
      if (previous === undefined) return previous;
      return { chats: upsertCloudChat(previous.chats, args.chat) };
    },
  );
}

/**
 * Apply a master-toggle write to every row the viewer owns on the task.
 * `applyToExisting: true` means "all" in both directions, so every own row
 * takes the written visibility.
 */
export function applyOwnCloudChatVisibility(
  queryClient: QueryClient,
  args: {
    readonly hostId: string | null;
    readonly viewerUserId: string;
    readonly taskId: string;
    readonly visibility: CloudChatVisibility;
  },
): void {
  if (args.hostId === null || args.viewerUserId.length === 0) return;
  queryClient.setQueryData<ListCloudChatsResponse>(
    cloudChatListQueryKey({
      hostId: args.hostId,
      viewerUserId: args.viewerUserId,
      taskId: args.taskId,
    }),
    (previous) => {
      if (previous === undefined) return previous;
      return {
        chats: previous.chats.map((chat) =>
          chat.isOwnedByViewer
            ? { ...chat, visibility: args.visibility }
            : chat,
        ),
      };
    },
  );
}

/**
 * Drop every cloud-chat READ keyed for this viewer on this host (assembled
 * chat, payload bytes). The list itself is a `useHostQuery` key and is
 * updated by {@link reconcileCloudChatSummary} /
 * {@link applyOwnCloudChatVisibility} rather than this prefix.
 */
export function invalidateCloudChatViewerScope(
  queryClient: QueryClient,
  hostId: string | null,
  viewerUserId: string,
): void {
  if (hostId === null || viewerUserId.length === 0) return;
  void queryClient.invalidateQueries({
    queryKey: cloudChatQueryKeys.scope(hostId, viewerUserId),
  });
}
