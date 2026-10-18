import type { UseQueryResult } from "@tanstack/react-query";
import type { EnvironmentListResponse } from "@traycer/protocol/host/environment/contracts";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostQuery } from "@/hooks/host/use-host-query";

// Stable params identity so the host-scoped query key stays referentially
// constant across renders.
const EMPTY_PARAMS = {};

/**
 * Every environment the signed-in user belongs to - the personal one first,
 * then one per team - as `environment.list` answers it on `client`.
 *
 * The client is an ARGUMENT, not read from context: Home asks the app-wide
 * host, the Settings host-environment picker asks the scoped host, and a
 * create form asks the host it will create on. The answer is the same list on
 * every host (it is the cloud's), but which host carries the request decides
 * whether it is answered at all (`enabled` is the capability gate the caller
 * already resolved with `useHostMethodSupport`).
 */
export function useEnvironmentListQuery(
  client: HostClient<HostRpcRegistry> | null,
  enabled: boolean,
): UseQueryResult<EnvironmentListResponse, HostRpcError> {
  return useHostQuery<HostRpcRegistry, "environment.list">({
    cacheKeyIdentity: undefined,
    client,
    method: "environment.list",
    params: EMPTY_PARAMS,
    options: { enabled, refetchOnWindowFocus: false },
  });
}
