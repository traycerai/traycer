import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";
import { useChatById } from "@/lib/epic-selectors";
import { useCloudChatList } from "@/hooks/chats/use-cloud-chat-queries";

/** Local record outranks the cloud row. null means unknown; never invent an owner (the host would trust a fabricated one). */

/**
 * `""` is not an owner. The wire field is `z.string().min(1).nullable()`; forwarding empty fails validation instead of degrading to settings-only.
 */
function usableOwnerUserId(value: string | null): string | null {
  return value !== null && value.length > 0 ? value : null;
}

export interface ResolveCloneSourceOwnerArgs {
  /** The source chat, or `null` when the surface has no chat in hand. */
  readonly chatId: string | null;
  /** `ChatProjection.userId` - the doc record's owner field. */
  readonly localRecordOwnerUserId: string | null;
  /** `epic.listCloudChats`' rows, or `null` when the list has not answered. */
  readonly cloudChats: readonly CloudChatSummary[] | null;
  /**
   * Owner's host, used only to break a tie, never to filter. Pass `null` unless the value is the owner's host; a serving host would resolve a colliding id to the viewer's row.
   */
  readonly sourceOwnerHostId: string | null;
}

/**
 * Identity is `(taskId, chatId, ownerUserId)`, not `chatId` alone. Ambiguous scan returns `null`; `sourceOwnerHostId` breaks ties rather than pre-filtering.
 */
export function resolveCloneSourceOwnerUserId(
  args: ResolveCloneSourceOwnerArgs,
): string | null {
  if (args.chatId === null) return null;
  const localOwnerUserId = usableOwnerUserId(args.localRecordOwnerUserId);
  if (localOwnerUserId !== null) return localOwnerUserId;
  const rows = (args.cloudChats ?? []).filter(
    (chat) => chat.identity.chatId === args.chatId,
  );
  if (rows.length === 1) {
    return usableOwnerUserId(rows[0].identity.ownerUserId);
  }
  if (rows.length === 0 || args.sourceOwnerHostId === null) return null;
  const onSourceHost = rows.filter(
    (chat) => chat.ownerHostId === args.sourceOwnerHostId,
  );
  if (onSourceHost.length !== 1) return null;
  return usableOwnerUserId(onSourceHost[0].identity.ownerUserId);
}

export interface UseCloneSourceOwnerUserIdArgs {
  /** The app-wide client, matching the one `tab-group-view` and the sidebar already read this list through - the same client means the same query key, so a surface that renders beside them pays no second request. */
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly epicId: string;
  readonly chatId: string | null;
  /** The source chat's bound host, when the surface knows it. */
  readonly sourceOwnerHostId: string | null;
}

export function useCloneSourceOwnerUserId(
  args: UseCloneSourceOwnerUserIdArgs,
): string | null {
  const chatRecord = useChatById(args.chatId);
  const localRecordOwnerUserId = chatRecord?.userId ?? null;
  // The list is consulted only when the local record cannot answer. Where it
  // can, this stays a pure projection read and costs nothing.
  const needsCloudRow =
    args.chatId !== null && usableOwnerUserId(localRecordOwnerUserId) === null;
  const cloudChats = useCloudChatList({
    client: args.client,
    taskId: args.epicId,
    enabled: needsCloudRow,
  });
  return resolveCloneSourceOwnerUserId({
    chatId: args.chatId,
    localRecordOwnerUserId,
    cloudChats: cloudChats.data?.chats ?? null,
    sourceOwnerHostId: args.sourceOwnerHostId,
  });
}
