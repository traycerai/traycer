/**
 * Query keys for identity reads that do not go through `useHostQuery`.
 *
 * The blob read is a chunked LOOP over `agentIdentity.files.readBlob`, not one
 * request, so it runs as a bare `useQuery` keyed here. Scoped under the host
 * key so a host-wide invalidation clears it with everything else.
 */
import { hostQueryKeys } from "./host-query-keys";

export const identityQueryKeys = {
  blob: (input: {
    readonly hostId: string;
    readonly identityId: string;
    readonly path: string;
    readonly sha256: string;
  }) =>
    [
      ...hostQueryKeys.scope(input.hostId),
      "agentIdentity.blob",
      input.identityId,
      input.path,
      input.sha256,
    ] as const,
};
