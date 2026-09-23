/**
 * Read hooks for the `agentIdentity.*` family, all `…ForClient`: every caller
 * is either an identity tab (bound to `useTabHostClient()`) or the Identities
 * list, which resolves its own host. There is deliberately no default-host
 * wrapper - an identity surface reaching for the app-wide host is the mistake
 * `AGENTS.md` names.
 */
import type { UseQueryResult } from "@tanstack/react-query";
import type {
  HostRpcError,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostQuery } from "@/hooks/host/use-host-query";

export function useIdentityListForClient(
  client: HostClient<HostRpcRegistry> | null,
  enabled: boolean,
): UseQueryResult<
  ResponseOfMethod<HostRpcRegistry, "agentIdentity.list">,
  HostRpcError
> {
  return useHostQuery<HostRpcRegistry, "agentIdentity.list">({
    cacheKeyIdentity: undefined,
    client,
    method: "agentIdentity.list",
    params: {},
    options: { enabled },
  });
}

export const IDENTITY_HISTORY_PAGE_SIZE = 200;

export function useIdentityHistoryListForClient(
  client: HostClient<HostRpcRegistry> | null,
  input: { readonly identityId: string; readonly path: string | null },
): UseQueryResult<
  ResponseOfMethod<HostRpcRegistry, "agentIdentity.history.list">,
  HostRpcError
> {
  return useHostQuery<HostRpcRegistry, "agentIdentity.history.list">({
    cacheKeyIdentity: undefined,
    client,
    method: "agentIdentity.history.list",
    params: {
      identityId: input.identityId,
      path: input.path ?? "",
      cursor: null,
      limit: IDENTITY_HISTORY_PAGE_SIZE,
    },
    options: { enabled: input.path !== null },
  });
}
