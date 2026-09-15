import type { DraftKind } from "@traycer/protocol/host";
import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { isCloudChatsUnsupported } from "@/lib/chats/cloud-chat-read-port";
import { cloudDraftIdentityKey } from "./cloud-draft-kinds";
import { isDraftsCapabilityMissing } from "./draft-capability";
import { draftKindIsHostBound } from "./draft-portability";

/**
 * Cloud-chat "absent section, not a broken tab". Any settled list error
 * hides the directory — including an access refusal, which arrives as
 * FORBIDDEN (`EpicAccessForbiddenError`).
 */
export function cloudDraftsDirectoryIsVisible(input: {
  readonly scopeId: string | null;
  readonly error: HostRpcError | null;
  readonly isPending: boolean;
  readonly isSuccess: boolean;
}): boolean {
  if (input.scopeId === null || input.scopeId.length === 0) return false;
  if (isCloudChatsUnsupported(input.error)) return false;
  if (isDraftsCapabilityMissing(input.error)) return false;
  return input.isSuccess || input.isPending;
}

/**
 * The published drafts a device on `hostId` can actually open.
 *
 * Three exclusions, and none of them is cosmetic:
 *
 * - its OWN rows, which are already live through `drafts.subscribe`;
 * - a **host-bound** kind, which names a chat that lives on its owner, so the
 *   row offers a surface this device has no way to reach;
 * - a kind that is **not yet known**, because the kind lives inside the head
 *   document and only the ingest's byte-pipe read decodes it. Hiding until
 *   known is the safe direction: the alternative lists a chat draft on every
 *   head-read failure, which is the case this filter exists to remove.
 */
export function openableCloudDrafts(input: {
  readonly chats: ReadonlyArray<CloudChatSummary>;
  readonly hostId: string | null;
  readonly kinds: ReadonlyMap<string, DraftKind>;
}): ReadonlyArray<CloudChatSummary> {
  const { hostId } = input;
  if (hostId === null) return [];
  return input.chats.filter((chat) => {
    if (chat.ownerHostId === hostId) return false;
    const kind = input.kinds.get(cloudDraftIdentityKey(chat));
    return kind !== undefined && !draftKindIsHostBound(kind);
  });
}
