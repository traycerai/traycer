import type { CloudChatIdentity } from "@traycer/protocol/host/epic/cloud-chat";
import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";

/**
 * Keys for the cloud-chat READ surface.
 *
 * ## Every key carries the VIEWER, and that is a privacy requirement
 *
 * These responses are the caller's ACL-filtered view and include the caller's
 * OWN private chats, so two people signed in on one installation have different
 * correct answers for the same task on the same host. Without the viewer in the
 * key they would share a cache slot, and the second one would read the first
 * one's chats out of it.
 *
 * The auth-transition invalidator is not enough on its own: it invalidates
 * without removing, so a stale-but-successful result stays readable through the
 * refetch window - which is exactly the window a viewer switch opens.
 *
 * ## Only the queries that BUILD their own keys are here
 *
 * `chat.list` and the payload list go through `useHostQuery`, which owns its own
 * key shape. Builders for those used to sit here too and matched nothing - a
 * future invalidation would have reached for one, produced a key no query uses,
 * and silently done nothing. A key builder with no consumer is worse than
 * absent.
 *
 * ## Every key carries the OWNER, because a chat id is not an identity
 *
 * `chatId` is host-minted and two hosts can mint the same one under a task, so
 * identity is the triple. A key on `(task, chat)` alone would let two genuinely
 * different chats collide in the cache.
 */
export const cloudChatQueryKeys = {
  scope: (hostId: string | null, viewerUserId: string) =>
    [...hostQueryKeys.scope(hostId), "cloud-chat", viewerUserId] as const,

  /**
   * One chat, resolved and assembled.
   *
   * Keyed on the identity triple only, never on the head digest: the read has
   * to run before anybody knows which head it landed on, so a digest in the key
   * would be a value the key's own consumer cannot supply.
   */
  read: (
    hostId: string | null,
    viewerUserId: string,
    identity: CloudChatIdentity,
  ) =>
    [
      ...cloudChatQueryKeys.scope(hostId, viewerUserId),
      "read",
      identity.taskId,
      identity.ownerUserId,
      identity.chatId,
    ] as const,

  /**
   * One payload's bytes.
   *
   * The digest IS in this key, and here it is exactly right: a payload is
   * content-addressed, so the key names immutable bytes and can be cached
   * forever without a staleness question.
   */
  payload: (
    hostId: string | null,
    viewerUserId: string,
    identity: CloudChatIdentity,
    ref: { readonly kind: string; readonly sha256: string },
  ) =>
    [
      ...cloudChatQueryKeys.scope(hostId, viewerUserId),
      "payload",
      identity.taskId,
      identity.ownerUserId,
      identity.chatId,
      ref.kind,
      ref.sha256,
    ] as const,
};
