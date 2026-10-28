import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import { usePoolTierHostClient } from "@/hooks/host/use-pool-tier";
import type { UseQueryResult } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import type {
  HostRpcError,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { useConfigurationSource } from "@/components/settings/environment/configuration-source";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";
import { invalidateConfigurationReads } from "@/hooks/environment/environment-host-list-key";
import { useAddressedEnvironment } from "@/hooks/environment/use-addressed-environment";
import { useHostQueryWithResponseMap } from "@/hooks/host/use-host-query";
import { useHostScopedMutationForClient } from "@/hooks/host/use-host-scoped-mutation";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { cloudVerdictPreflight } from "@/lib/host/cloud-verdict-preflight";
import { environmentMutationKeys } from "@/lib/query-keys";
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";

export type EnvironmentMcpServer = ResponseOfMethod<
  HostRpcRegistry,
  "environment.configuration.mcpServers.list"
>["servers"][number];

/**
 * The configuration's MCP servers, each with its `mcp_server` item, read
 * through the configuration's serving tier on the viewer's session.
 */
export function useConfigurationMcpServersQuery(): UseQueryResult<
  readonly EnvironmentMcpServer[],
  HostRpcError
> {
  const source = useConfigurationSource();
  const client = usePoolTierHostClient(useHostClient());
  const { hostId } = useReactiveHostReadiness(client);
  const revisionSupported = useHostMethodSupport(
    hostId,
    "environment.configuration.revision",
  );
  const viewerId = useCloudChatViewerId();
  const authorized = useAuthStore((state) =>
    authorizesCloudCapability(state.status),
  );
  return useHostQueryWithResponseMap<
    HostRpcRegistry,
    "environment.configuration.mcpServers.list",
    readonly EnvironmentMcpServer[]
  >({
    cacheKeyIdentity: [viewerId],
    client,
    method: "environment.configuration.mcpServers.list",
    params: {
      environmentId: source.kind === "pool" ? source.environmentId : "",
    },
    preflight: cloudVerdictPreflight(
      "environment.configuration.mcpServers.list",
    ),
    mapResponse: ({ response }) => response.servers,
    options: {
      poll: revisionSupported !== true,
      enabled: source.kind === "pool" && viewerId.length > 0 && authorized,
    },
  });
}

/**
 * The names of the MCP servers whose credential is the secret `secretId`, in
 * the environment a Secrets page names: a team's or Personal's, never a
 * Local row's, which has no MCP servers page. Empty until known, and while
 * `enabled` is false.
 */
export function useSecretMcpServerNames(
  secretId: string,
  enabled: boolean,
): readonly string[] {
  const { environmentId, resolved } = useAddressedEnvironment();
  const client = usePoolTierHostClient(useHostClient());
  const { hostId } = useReactiveHostReadiness(client);
  const revisionSupported = useHostMethodSupport(
    hostId,
    "environment.configuration.revision",
  );
  const viewerId = useCloudChatViewerId();
  const authorized = useAuthStore((state) =>
    authorizesCloudCapability(state.status),
  );
  const servers = useHostQueryWithResponseMap<
    HostRpcRegistry,
    "environment.configuration.mcpServers.list",
    readonly EnvironmentMcpServer[]
  >({
    cacheKeyIdentity: [viewerId],
    client,
    method: "environment.configuration.mcpServers.list",
    params: { environmentId: environmentId ?? "" },
    preflight: cloudVerdictPreflight(
      "environment.configuration.mcpServers.list",
    ),
    mapResponse: ({ response }) => response.servers,
    options: {
      poll: revisionSupported !== true,
      enabled:
        enabled &&
        resolved &&
        environmentId !== null &&
        viewerId.length > 0 &&
        authorized,
    },
  });
  if (!enabled || environmentId === null) return NO_SERVER_NAMES;
  return (servers.data ?? [])
    .filter(
      (server) =>
        server.credential.kind === "secret" &&
        server.credential.secretId === secretId,
    )
    .map((server) => server.name);
}

const NO_SERVER_NAMES: readonly string[] = [];

/** Every read a server write moves: the servers, their items, the hosts' reports. */
const MCP_SERVER_READS = [
  "environment.configuration.mcpServers.list",
  "environment.configuration.items",
] as const;

/**
 * A server's declaration (`put`, `delete`), its Enabled switch
 * (`setEnabled`), and its item (`putItem`: the per-provider and per-tool
 * switches).
 */
export function useConfigurationMcpServerMutations() {
  const client = usePoolTierHostClient(useHostClient());
  const queries = useQueryClient();
  // A configuration write refreshes every cached projection of its server
  // list, including readers mounted under another host scope.
  const reread = (environmentId: string): void =>
    invalidateConfigurationReads(queries, environmentId, MCP_SERVER_READS);
  const put = useHostScopedMutationForClient(client, {
    method: "environment.configuration.mcpServers.put",
    mutationKey: environmentMutationKeys.configurationMcpServersPut(),
    errorMessage: "Couldn't save this server.",
    invalidateMethods: [],
    prepareRequest: (request) => {
      cloudVerdictPreflight("environment.configuration.mcpServers.put")();
      return Promise.resolve(request);
    },
    onSuccess: (_result, request) => reread(request.environmentId),
  });
  const remove = useHostScopedMutationForClient(client, {
    method: "environment.configuration.mcpServers.delete",
    mutationKey: environmentMutationKeys.configurationMcpServersDelete(),
    errorMessage: "Couldn't remove this server.",
    invalidateMethods: [],
    prepareRequest: (request) => {
      cloudVerdictPreflight("environment.configuration.mcpServers.delete")();
      return Promise.resolve(request);
    },
    onSuccess: (_result, request) => reread(request.environmentId),
  });
  const putItem = useHostScopedMutationForClient(client, {
    method: "environment.configuration.items.put",
    mutationKey: environmentMutationKeys.configurationItemsPut(),
    errorMessage: "Couldn't save these settings.",
    invalidateMethods: [],
    prepareRequest: (request) => {
      cloudVerdictPreflight("environment.configuration.items.put")();
      return Promise.resolve(request);
    },
    onSuccess: (_result, request) => reread(request.environmentId),
  });
  const setEnabled = useHostScopedMutationForClient(client, {
    method: "environment.configuration.mcpServers.setEnabled",
    mutationKey: environmentMutationKeys.configurationMcpServersSetEnabled(),
    // The toast names the server and the way it was switched.
    errorMessage: null,
    invalidateMethods: [],
    prepareRequest: (request) => {
      cloudVerdictPreflight(
        "environment.configuration.mcpServers.setEnabled",
      )();
      return Promise.resolve(request);
    },
    onSuccess: (_result, request) => reread(request.environmentId),
  });
  return { put, remove, putItem, setEnabled };
}
