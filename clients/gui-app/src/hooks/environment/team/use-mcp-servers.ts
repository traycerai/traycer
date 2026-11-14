import type { UseQueryResult } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import type {
  HostRpcError,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { useConfigurationSource } from "@/components/settings/environment/configuration-source";
import { invalidateConfigurationReads } from "@/hooks/environment/environment-host-list-key";
import { useAddressedEnvironment } from "@/hooks/environment/use-addressed-environment";
import {
  useEnvironmentCloudMutation,
  useEnvironmentCloudQuery,
} from "@/hooks/environment/use-environment-cloud";
import type { HostRpcRegistry } from "@/lib/host";
import { environmentMutationKeys } from "@/lib/query-keys";

export type EnvironmentMcpServer = ResponseOfMethod<
  HostRpcRegistry,
  "environment.configuration.mcpServers.list"
>["servers"][number];

/**
 * The configuration's MCP servers, each with its `mcp_server` item, read by
 * the app itself from authn on the viewer's sign-in.
 */
export function useConfigurationMcpServersQuery(): UseQueryResult<
  readonly EnvironmentMcpServer[],
  HostRpcError
> {
  const source = useConfigurationSource();
  return useEnvironmentCloudQuery({
    method: "environment.configuration.mcpServers.list",
    params: {
      environmentId: source.kind === "pool" ? source.environmentId : "",
    },
    cacheKeyIdentity: [],
    mapResponse: (response): readonly EnvironmentMcpServer[] =>
      response.servers,
    enabled: source.kind === "pool",
    poll: false,
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
  const servers = useEnvironmentCloudQuery({
    method: "environment.configuration.mcpServers.list",
    params: { environmentId: environmentId ?? "" },
    cacheKeyIdentity: [],
    mapResponse: (response): readonly EnvironmentMcpServer[] =>
      response.servers,
    enabled: enabled && resolved && environmentId !== null,
    poll: false,
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
  const queries = useQueryClient();
  // A configuration write refreshes every cached projection of its server
  // list, including readers mounted under another host scope.
  const reread = (environmentId: string): void =>
    invalidateConfigurationReads(queries, environmentId, MCP_SERVER_READS);
  const put = useEnvironmentCloudMutation({
    method: "environment.configuration.mcpServers.put",
    mutationKey: environmentMutationKeys.configurationMcpServersPut(),
    errorMessage: "Couldn't save this server.",
    invalidateMethods: [],
    onSuccess: (_result, request) => reread(request.environmentId),
  });
  const remove = useEnvironmentCloudMutation({
    method: "environment.configuration.mcpServers.delete",
    mutationKey: environmentMutationKeys.configurationMcpServersDelete(),
    errorMessage: "Couldn't remove this server.",
    invalidateMethods: [],
    onSuccess: (_result, request) => reread(request.environmentId),
  });
  const putItem = useEnvironmentCloudMutation({
    method: "environment.configuration.items.put",
    mutationKey: environmentMutationKeys.configurationItemsPut(),
    errorMessage: "Couldn't save these settings.",
    invalidateMethods: [],
    onSuccess: (_result, request) => reread(request.environmentId),
  });
  const setEnabled = useEnvironmentCloudMutation({
    method: "environment.configuration.mcpServers.setEnabled",
    mutationKey: environmentMutationKeys.configurationMcpServersSetEnabled(),
    // The toast names the server and the way it was switched.
    errorMessage: null,
    invalidateMethods: [],
    onSuccess: (_result, request) => reread(request.environmentId),
  });
  return { put, remove, putItem, setEnabled };
}
