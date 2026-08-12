import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { ListCloudChatsResponse } from "@traycer/protocol/host/epic/cloud-chat";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { cloudRowIsViewersOwn } from "@/lib/chats/unified-chat-list";
import { queryKeys } from "@/lib/query-keys";
import { useAuthStore } from "@/stores/auth/auth-store";

/**
 * The `epic.listCloudChats` answer, read WITHOUT a React observer.
 *
 * `useCloudChatList` (`hooks/chats/use-cloud-chat-queries.ts`) is the only thing
 * that ever fetches this list, and every React consumer reads it through that
 * hook. This module exists for the one consumer that has no hooks at all: the
 * imperative back/forward navigation path, which must decide whether a closed
 * chat tile is worth restoring while it is halfway through a synchronous
 * `history.go`. It cannot mount an observer, it cannot await a fetch, and it
 * cannot be handed the answer as a prop.
 *
 * So it reads the cache the hook has already filled. That is not a second
 * fetcher and not a second source of truth - a surface that never mounted the
 * hook simply has no entry, which is a case this module REPORTS rather than
 * papers over.
 */

const LIST_CLOUD_CHATS_METHOD = "epic.listCloudChats" as const;

const EMPTY_CHAT_ID_SET: ReadonlySet<string> = new Set<string>();

/**
 * The `cacheKeyIdentity` `useCloudChatList` declares, as its ONE owner.
 *
 * `useHostQuery` appends this to its own base key, and `cloudChatListQueryKey`
 * below appends it to the same base rebuilt imperatively - so the identity
 * component must have exactly one spelling, consumed by both sides, or the two
 * keys drift apart at a seam no type checker watches. The viewer rides every
 * cloud-chat key because these responses are ACL-filtered per viewer: two
 * viewers on one installation have different correct answers, so a reader that
 * dropped the viewer component would happily serve one account's chats to the
 * other.
 */
export function cloudChatListCacheKeyIdentity(
  viewerUserId: string,
): ReadonlyArray<string> {
  return [viewerUserId];
}

/**
 * The exact cache slot `useCloudChatList` writes.
 *
 * Assembled from the same builder `useHostQuery` uses (`queryKeys.hostMethod`)
 * plus that hook's declared `cacheKeyIdentity` - which the hook imports from
 * {@link cloudChatListCacheKeyIdentity} above, so the shared component has one
 * owner rather than two spellings agreed in prose.
 *
 * A key format agreed in prose is the classic fail-safe bug: both sides compile,
 * both sides look right, and the lookup silently answers "nothing" forever. The
 * agreement here is pinned by a test that mounts the real hook and then reads
 * the slot back through this builder - not by this comment.
 */
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

/**
 * The signed-in viewer, for the caller that cannot use `useCloudChatViewerId`.
 *
 * Same store, same field, same `""`-means-unresolved convention as that hook -
 * restated here only because this file's caller is not a component.
 */
export function cloudChatViewerIdSnapshot(): string {
  return useAuthStore.getState().contextMetadata?.userId ?? "";
}

/**
 * The viewer's own cloud chat ids under `taskId`, or `null` when this cache
 * holds no answer that may be ACTED ON.
 *
 * That distinction is the whole point, and it is the imperative twin of
 * `cloudChatListAuthorizesRecordSweep`. "No cloud row for this chat" is only
 * evidence of deletion once the list has actually answered: an in-flight or
 * transiently failed list reports every chat as absent, and a caller that reads
 * that as "deleted" destroys exactly the never-adopted chats the cloud-known
 * exemption exists to keep.
 *
 * - a SET - the list answered, or will never answer, so membership is evidence
 * - `null` - pending, never requested, or failed in a way a retry could fix
 *
 * The two arms that produce a set:
 * 1. success - the rows themselves, filtered to the viewer's own.
 * 2. `E_HOST_UNSUPPORTED` - an older host will keep answering that forever,
 *    there are no cloud rows to consult through it, and policing on local
 *    records alone is that host's correct pre-cloud-list behavior.
 *
 * A request that cannot even be formed (no host, no viewer, no task) is `null`,
 * NOT an empty set. "Nothing could ask" and "the cloud lists nothing" are
 * different facts, and only the second is evidence: an unresolved host binding
 * or a sign-in still settling is a boot-order state a retry fixes, exactly the
 * `null` contract above - while an empty SET here would let a transient race
 * authorize the caller's permanent discard.
 *
 * VIEWER-OWNED rows only, matching every other consumer of this list: `chatId`
 * is host-minted and the list carries collaborators' rows too, so an id-only set
 * would let a collaborator's unrelated row vouch for a chat of the viewer's that
 * is genuinely gone.
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
