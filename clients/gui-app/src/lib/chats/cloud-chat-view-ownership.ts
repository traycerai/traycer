import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";

/** A copy/composer comparison, never a read or live-action grant. */
export function cloudChatBelongsToViewer(
  chat: CloudChatSummary,
  viewerUserId: string | null,
): boolean {
  return (
    viewerUserId !== null &&
    (chat.identity.ownerUserId === viewerUserId ||
      chat.creatorUserId === viewerUserId)
  );
}
