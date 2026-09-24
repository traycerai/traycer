/**
 * The bytes of one identity blob, read through `resolveIdentityBlobSource`.
 *
 * A bare `useQuery` rather than `useHostQuery`: the read is a chunk LOOP over
 * `agentIdentity.files.readBlob`, not one request, so the host hook's
 * one-method-one-key shape does not fit. Keyed by the object's `sha256` so an
 * overwrite at the same path is a different cache slot, never a stale preview.
 *
 * A `pending` answer (bytes not mirrored on the host yet) is a settled result,
 * not an error - the body renders it as "still downloading" with a retry - so
 * the query does not poll on its own.
 */
import {
  queryOptions,
  useQuery,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import {
  resolveIdentityBlobSource,
  type IdentityBlobSource,
} from "@/lib/identities/blob-source";
import { identityQueryKeys } from "@/lib/query-keys/identity-query-keys";

export interface IdentityBlobQueryInput {
  readonly hostId: string;
  readonly identityId: string;
  readonly path: string;
  readonly sha256: string;
  readonly mediaType: string;
}

export function useIdentityBlobQueryForClient(
  client: HostClient<HostRpcRegistry> | null,
  input: IdentityBlobQueryInput,
  enabled: boolean,
): UseQueryResult<IdentityBlobSource> {
  return useQuery({
    // `client` addresses `input.hostId`, which the key already carries;
    // keying on the client object would refetch on client identity drift.
    // eslint-disable-next-line @tanstack/query/exhaustive-deps
    ...queryOptions<IdentityBlobSource>({
      queryKey: identityQueryKeys.blob(input),
      queryFn: () =>
        resolveIdentityBlobSource(client, {
          identityId: input.identityId,
          path: input.path,
          sha256: input.sha256,
          mediaType: input.mediaType,
        }),
      staleTime: Number.POSITIVE_INFINITY,
      gcTime: 5 * 60 * 1000,
    }),
    enabled: enabled && client !== null,
  });
}
