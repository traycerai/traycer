import type { CloudChatIdentity } from "@traycer/protocol/host/epic/cloud-chat";
import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";

/** Keys for the cloud-chat READ surface. */
export const cloudChatQueryKeys = {
  scope: (hostId: string | null, viewerUserId: string) =>
    [...hostQueryKeys.scope(hostId), "cloud-chat", viewerUserId] as const,

  /** One chat, resolved and assembled. */
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

  /** One payload's bytes. */
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
