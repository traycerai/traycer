import type { UseQueryResult } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  HostRpcError,
  RequestOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostQueryWithResponseMap } from "@/hooks/host/use-host-query";
import { RATE_LIMIT_USAGE_RESPONSE_TIMEOUT_MS } from "@/lib/rate-limits/rate-limit-timing";

export type ProvidersReadModelRoutesRequest = RequestOfMethod<
  HostRpcRegistry,
  "providers.readModelRoutes"
>;

interface ModelRoutesData {
  readonly routes: ReadonlyArray<{
    readonly profileId: string | null;
    readonly resolvedModel: string | null;
    readonly expiresAt: number;
  }>;
}

const NO_REQUEST: ProvidersReadModelRoutesRequest = {
  providerId: "claude-code",
  workingDirectory: "-",
  modelSlug: "-",
  profileIds: [],
};

/**
 * Which model an alias runs on for each requested profile in one folder, from
 * the host's CLI handshakes. A cold answer spawns one, so it may take as long
 * as a usage read. `null` asks nothing.
 */
export function useProvidersReadModelRoutesQuery(input: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly request: ProvidersReadModelRoutesRequest | null;
}): UseQueryResult<ModelRoutesData, HostRpcError> {
  return useHostQueryWithResponseMap<
    HostRpcRegistry,
    "providers.readModelRoutes",
    ModelRoutesData,
    number
  >({
    cacheKeyIdentity: undefined,
    client: input.client,
    method: "providers.readModelRoutes",
    params: input.request ?? NO_REQUEST,
    responseTimeoutMs: RATE_LIMIT_USAGE_RESPONSE_TIMEOUT_MS,
    options: { enabled: input.request !== null, staleTime: 0 },
    captureRequestContext: () => Date.now(),
    // Starting the validity budget before dispatch is conservative even when
    // the reply is delayed, without requiring synchronized host/client clocks.
    mapResponse: ({ response, requestContext }) => ({
      routes: response.routes.map((route) => ({
        profileId: route.profileId,
        resolvedModel: route.resolvedModel,
        expiresAt: (requestContext ?? 0) + route.validForMs,
      })),
    }),
  });
}
