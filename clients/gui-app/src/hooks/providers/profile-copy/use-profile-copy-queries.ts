import type { UseQueryResult } from "@tanstack/react-query";
import type {
  HostRpcError,
  RequestOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { PROFILE_COPY_MAX_INCOMING_PAGE } from "@traycer/protocol/host/profile-copy-schemas";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { isPermanentProfileCopyError } from "@/hooks/providers/profile-copy/profile-copy-cache";
import type {
  ProfileCopyAttempt,
  ProfileCopyDraftResponse,
  ProfileCopyIncomingResponse,
  ProfileCopyOperationResponse,
  ProfileCopyPreviewResponse,
} from "@/lib/profile-copy/profile-copy-model";

/**
 * The four profile-copy reads. Each takes the host it dials as an ARGUMENT -
 * captured when the surface opened - and never reads a host from context, so
 * a Settings scope change cannot move one.
 */

export type ProfileCopyPreviewRequest = RequestOfMethod<
  HostRpcRegistry,
  "providers.profileCopy.preview"
>;

/** How long a preview answer is reused before "Check again" is needed. */
const PREVIEW_STALE_TIME_MS = 30_000;

/**
 * The source host's per-destination answer for EXACTLY `request`'s list: its
 * `previewRevision` covers that list, so a start must send the same one.
 * `null` renders nothing and dials nothing.
 */
export function useProfileCopyPreviewQuery(
  sourceHostId: string,
  request: ProfileCopyPreviewRequest | null,
): UseQueryResult<ProfileCopyPreviewResponse, HostRpcError> {
  const client = useHostClientForHostId(sourceHostId);
  return useHostQuery<HostRpcRegistry, "providers.profileCopy.preview">({
    client,
    method: "providers.profileCopy.preview",
    // Disabled below while `null`; the placeholder is only a well-typed key.
    params: request ?? {
      sourceHostId,
      sourceProfileId: "",
      providerId: "claude",
      destinationHostIds: [],
    },
    cacheKeyIdentity: undefined,
    options: {
      enabled: request !== null,
      staleTime: PREVIEW_STALE_TIME_MS,
      // A refusal here is an answer the dialog renders, not a blip to retry.
      retry: false,
    },
  });
}

/**
 * The source host's chain heads for one operation. Polled by the policy
 * table's condition lanes only while observed, only until every row is
 * settled, and never again after an error no later read can change.
 */
export function useProfileCopyStatusQuery(
  sourceHostId: string,
  operationId: string,
): UseQueryResult<ProfileCopyOperationResponse, HostRpcError> {
  const client = useHostClientForHostId(sourceHostId);
  return useHostQuery<HostRpcRegistry, "providers.profileCopy.status">({
    client,
    method: "providers.profileCopy.status",
    params: { sourceHostId, operationId },
    cacheKeyIdentity: undefined,
    options: {
      enabled: (query) => !isPermanentProfileCopyError(query.state.error),
    },
  });
}

/** One draft, read on the destination that holds it. */
export function useProfileCopyDraftStatusQuery(
  attempt: ProfileCopyAttempt,
  enabled: boolean,
): UseQueryResult<ProfileCopyDraftResponse, HostRpcError> {
  const client = useHostClientForHostId(attempt.destinationHostId);
  return useHostQuery<HostRpcRegistry, "providers.profileCopy.draftStatus">({
    client,
    method: "providers.profileCopy.draftStatus",
    params: { attempt },
    cacheKeyIdentity: undefined,
    options: {
      enabled: (query) =>
        enabled && !isPermanentProfileCopyError(query.state.error),
    },
  });
}

/**
 * The drafts waiting on `destinationHostId`: open, cancelling, and
 * quarantined without a replacement. The first page only - a device with more
 * than a page of unfinished copies says so rather than paging silently.
 */
export function useProfileCopyIncomingQuery(
  destinationHostId: string,
  enabled: boolean,
): UseQueryResult<ProfileCopyIncomingResponse, HostRpcError> {
  const client = useHostClientForHostId(destinationHostId);
  return useHostQuery<HostRpcRegistry, "providers.profileCopy.incoming">({
    client,
    method: "providers.profileCopy.incoming",
    params: {
      destinationHostId,
      cursor: null,
      limit: PROFILE_COPY_MAX_INCOMING_PAGE,
    },
    cacheKeyIdentity: undefined,
    options: {
      enabled: (query) =>
        enabled && !isPermanentProfileCopyError(query.state.error),
    },
  });
}
