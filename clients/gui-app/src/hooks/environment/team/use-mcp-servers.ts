import type { UseMutationResult, UseQueryResult } from "@tanstack/react-query";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { putConfigurationMcpServer } from "@traycer-clients/shared/environment/configuration-settings";
import type {
  HostRpcError,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  EnvironmentConfigurationMcpServerPutRequestV11,
  EnvironmentConfigurationMcpServerPutResponseV11,
  EnvironmentMcpServerCredentialV11,
} from "@traycer/protocol/host/environment/configuration-contracts";
import { useConfigurationSource } from "@/components/settings/environment/configuration-source";
import { invalidateConfigurationReads } from "@/hooks/environment/environment-host-list-key";
import { useAddressedEnvironment } from "@/hooks/environment/use-addressed-environment";
import {
  useEnvironmentCloud,
  useEnvironmentCloudMutation,
  useEnvironmentCloudQuery,
} from "@/hooks/environment/use-environment-cloud";
import { hostClientUnavailableError } from "@/hooks/host/use-host-query";
import { environmentCloudHostError } from "@/lib/environment/environment-cloud-calls";
import type { HostRpcRegistry } from "@/lib/host";
import { cloudVerdictPreflight } from "@/lib/host/cloud-verdict-preflight";
import { toastFromHostError } from "@/lib/host-error-toast";
import { withHostQueryErrorBoundary } from "@/lib/query/host-query-error-boundary";
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

/** A server's save, as its mutation's variables hold it: never its credential. */
export interface McpServerSave {
  readonly request: Omit<
    EnvironmentConfigurationMcpServerPutRequestV11,
    "credential"
  >;
  /**
   * The revision of the server's item the editor showed; null for a new
   * server, and for one shown with no item. A save whose item moved since is
   * refused, as the host refused a revision conflict.
   */
  readonly seenItemRevision: number | null;
}

const SAVE_METHOD = "environment.configuration.mcpServers.put";

/**
 * A server's declaration (`mcpServers.put`). The credential is read by
 * `readCredential` when the save is sent, so a typed value never becomes the
 * mutation's variables and reaches no mutation cache; null while it is still
 * missing, when nothing is sent.
 */
export function useConfigurationMcpServerSave(
  readCredential: () => EnvironmentMcpServerCredentialV11 | null,
): UseMutationResult<
  EnvironmentConfigurationMcpServerPutResponseV11,
  HostRpcError,
  McpServerSave
> {
  const queries = useQueryClient();
  const cloud = useEnvironmentCloud();
  return useMutation<
    EnvironmentConfigurationMcpServerPutResponseV11,
    HostRpcError,
    McpServerSave
  >({
    mutationKey: environmentMutationKeys.configurationMcpServersPut(),
    mutationFn: ({ request, seenItemRevision }) =>
      withHostQueryErrorBoundary(SAVE_METHOD, async () => {
        cloudVerdictPreflight(SAVE_METHOD)();
        const credential = readCredential();
        if (cloud === null || credential === null)
          throw hostClientUnavailableError(SAVE_METHOD);
        try {
          return await putConfigurationMcpServer(
            cloud(),
            { ...request, credential },
            seenItemRevision,
          );
        } catch (error) {
          throw environmentCloudHostError(SAVE_METHOD, error);
        }
      }),
    onSuccess: (_result, { request }) =>
      invalidateConfigurationReads(
        queries,
        request.environmentId,
        MCP_SERVER_READS,
      ),
    onError: (error) => {
      toastFromHostError(error, "Couldn't save this server.");
    },
  });
}

/**
 * A server's removal (`delete`), its Enabled switch (`setEnabled`), and its
 * item (`putItem`: the per-provider and per-tool switches).
 */
export function useConfigurationMcpServerMutations() {
  const queries = useQueryClient();
  // A configuration write refreshes every cached projection of its server
  // list, including readers mounted under another host scope.
  const reread = (environmentId: string): void =>
    invalidateConfigurationReads(queries, environmentId, MCP_SERVER_READS);
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
  return { remove, putItem, setEnabled };
}
