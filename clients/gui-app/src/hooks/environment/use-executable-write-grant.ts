import { useCallback } from "react";
import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import { withExecutableWriteGrant } from "@/lib/environment/executable-write-grant";
import { useHostBinding, type HostRpcRegistry } from "@/lib/host";

/**
 * Fills a sink-reaching request's `executableWriteGrant` at dispatch, on the
 * client it is about to be sent on. Pass it as a host mutation's
 * `prepareRequest`; the request's own `executableWriteGrant: null` is what it
 * replaces.
 */
export type ExecutableWriteGrantPreparer = <
  Request extends { readonly executableWriteGrant: string | null },
>(
  request: Request,
  client: HostRequester<HostRpcRegistry>,
) => Promise<Request>;

export function useExecutableWriteGrant(): ExecutableWriteGrantPreparer {
  // The non-throwing accessor: a signed-out shell has no session to mint on,
  // and its writes go without a grant.
  const minter = useHostBinding()?.auth ?? null;
  return useCallback(
    <Request extends { readonly executableWriteGrant: string | null }>(
      request: Request,
      client: HostRequester<HostRpcRegistry>,
    ): Promise<Request> => withExecutableWriteGrant(minter, client, request),
    [minter],
  );
}
