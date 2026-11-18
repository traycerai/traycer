import { imageBlobCache } from "@/lib/attachments/image-blob-cache";
import { resetChatAttachmentHostSupport } from "@/lib/attachments/use-chat-image-fetcher";
import { clearTranscriptImageBytesFor } from "@/lib/attachments/transcript-image-bytes-store";
import {
  resetArtifactAttachmentHostSupport,
  resetEpicImageFetcherArmAbort,
} from "@/lib/attachments/use-attachment-blob-src";

/**
 * Drops every in-memory image-path map that is keyed without an account id,
 * then the outgoing durable partition.
 *
 * | Map | Keyed with account? | Teardown |
 * | --- | --- | --- |
 * | `imageBlobCache` entries / in-flight fetches | no (host/epic/chat\|artifact) | `clear()` aborts and revokes |
 * | Arm-abort leases | no (epic handle) | reset |
 * | Artifact host-unsupported probe set | no (hostId+version) | reset |
 * | Chat host-unsupported probe set | no (hostId+version) | reset |
 * | Transcript hydrated index + exclusive queue | per-identity generation, singleton maps | `clearTranscriptImageBytesFor` |
 * | Image witness / reset floors | per chat session | `disposeAllChatSessions` |
 */
export function clearImagePathForIdentityTeardown(
  outgoingIdentity: string | null,
): Promise<void> {
  imageBlobCache.clear();
  resetEpicImageFetcherArmAbort();
  resetArtifactAttachmentHostSupport();
  resetChatAttachmentHostSupport();
  return clearTranscriptImageBytesFor(outgoingIdentity);
}
