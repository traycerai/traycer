import { useMemo } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { EnvironmentListResponse } from "@traycer/protocol/host/environment/contracts";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostQueryWithResponseMap } from "@/hooks/host/use-host-query";
import { resolvePoolTierHostClient } from "@/lib/host/binding-host-client";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";
import { useViewReplicaPaint } from "@/lib/view-replica/view-replica-store";
import {
  environmentListReplicaAddress,
  environmentListReplicaService,
  rememberEnvironmentList,
} from "@/lib/view-replica/environment-list-replica";

// Stable params identity so the host-scoped query key stays referentially
// constant across renders.
const EMPTY_PARAMS = {};

interface EnvironmentListDispatch {
  readonly observedAt: number;
}

function captureDispatch(): EnvironmentListDispatch {
  return { observedAt: Date.now() };
}

/**
 * Every environment the signed-in user belongs to - the personal one first,
 * then one per team - as `environment.list` answers it on `client`.
 *
 * The client is an ARGUMENT, not read from context: Home asks the app-wide
 * host, the Settings host-environment picker asks the scoped host, and a
 * create form asks the host it will create on. The list is account-wide, so
 * in a build with a server pool it is the pool's whichever client is passed
 * (`resolvePoolTierHostClient`); in a build without one, which host carries
 * the request decides whether it is answered at all (`enabled` is the
 * capability gate the caller already resolved with `useHostMethodSupport`,
 * which reads the same tier).
 *
 * The answer is the ACCOUNT's, so its key carries the viewer and the read waits
 * until the viewer resolves, as `useAutoPolicyQuery` explains: an account
 * switch marks host keys stale without dropping them, and an unpartitioned
 * entry would serve the previous account's environments to the next one.
 *
 * Until the serving tier answers, the replica tier's list paints as
 * placeholder data, and every answer is kept there, stamped with when it was
 * asked for.
 */
export function useEnvironmentListQuery(
  client: HostClient<HostRpcRegistry> | null,
  enabled: boolean,
): UseQueryResult<EnvironmentListResponse, HostRpcError> {
  const servingClient = useMemo(
    () => (client === null ? null : resolvePoolTierHostClient(client)),
    [client],
  );
  const viewerUserId = useCloudChatViewerId();
  const servingHostId = servingClient?.getActiveHostId() ?? null;
  const replicaPage = useViewReplicaPaint(
    environmentListReplicaService,
    viewerUserId.length === 0
      ? null
      : environmentListReplicaAddress(viewerUserId, servingHostId),
  );
  return useHostQueryWithResponseMap<
    HostRpcRegistry,
    "environment.list",
    EnvironmentListResponse,
    EnvironmentListDispatch
  >({
    cacheKeyIdentity: [viewerUserId],
    client: servingClient,
    method: "environment.list",
    params: EMPTY_PARAMS,
    captureRequestContext: captureDispatch,
    mapResponse: ({ response, requestContext }) => {
      if (requestContext !== undefined && viewerUserId.length > 0) {
        rememberEnvironmentList({
          accountId: viewerUserId,
          servingHostId,
          page: response,
          observedAt: requestContext.observedAt,
        });
      }
      return response;
    },
    options: {
      enabled: enabled && viewerUserId.length > 0,
      refetchOnWindowFocus: false,
      placeholderData: replicaPage ?? undefined,
    },
  });
}
