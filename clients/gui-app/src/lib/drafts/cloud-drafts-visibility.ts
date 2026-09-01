import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { isCloudChatsUnsupported } from "@/lib/chats/cloud-chat-read-port";
import { isDraftsCapabilityMissing } from "./draft-capability";

/**
 * Cloud-chat "absent section, not a broken tab". Any settled list error
 * hides the directory — including free-tier, which arrives as FORBIDDEN
 * (`EpicAccessForbiddenError`), not `FREE_TIER_NO_CLOUD_SYNC`.
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
