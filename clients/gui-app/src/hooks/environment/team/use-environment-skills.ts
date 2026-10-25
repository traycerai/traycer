import type { UseQueryResult } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { EnvironmentConfigurationSkillsListResponse } from "@traycer/protocol/host/environment/configuration-contracts";
import { useConfigurationSource } from "@/components/settings/environment/configuration-source";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";
import { invalidateConfigurationReads } from "@/hooks/environment/environment-host-list-key";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useHostScopedMutationForClient } from "@/hooks/host/use-host-scoped-mutation";
import type { HostRpcRegistry } from "@/lib/host";
import { cloudVerdictPreflight } from "@/lib/host/cloud-verdict-preflight";
import { environmentMutationKeys } from "@/lib/query-keys";
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";

/**
 * The configuration's skills, from a host that serves it: `client` is the
 * viewing host. Answered `not_served` by any other host. `enabled` is the
 * caller's: false while that host has not negotiated the method.
 */
export function useEnvironmentSkillsQuery(
  client: HostClient<HostRpcRegistry> | null,
  enabled: boolean,
): UseQueryResult<EnvironmentConfigurationSkillsListResponse, HostRpcError> {
  const source = useConfigurationSource();
  const viewerId = useCloudChatViewerId();
  const authorized = useAuthStore((state) =>
    authorizesCloudCapability(state.status),
  );
  return useHostQuery({
    cacheKeyIdentity: [viewerId],
    client,
    method: "environment.configuration.skills.list",
    params: {
      environmentId: source.kind === "pool" ? source.environmentId : "",
    },
    preflight: cloudVerdictPreflight("environment.configuration.skills.list"),
    options: {
      enabled:
        enabled &&
        client !== null &&
        source.kind === "pool" &&
        viewerId.length > 0 &&
        authorized,
    },
  });
}

/** Remove a skill and switch it per provider, on the viewing host that serves it. */
export function useEnvironmentSkillMutations(
  client: HostClient<HostRpcRegistry> | null,
) {
  const queries = useQueryClient();
  const remove = useHostScopedMutationForClient(client, {
    method: "environment.configuration.skills.remove",
    mutationKey: environmentMutationKeys.configurationSkillsRemove(),
    errorMessage: "Couldn't remove this skill.",
    invalidateMethods: ["providers.list"],
    prepareRequest: (request) => {
      cloudVerdictPreflight("environment.configuration.skills.remove")();
      return Promise.resolve(request);
    },
    onSuccess: (_result, request) =>
      invalidateConfigurationReads(queries, request.environmentId, [
        "environment.configuration.skills.list",
      ]),
  });
  const setProviders = useHostScopedMutationForClient(client, {
    method: "environment.configuration.skills.setProviders",
    mutationKey: environmentMutationKeys.configurationSkillsSetProviders(),
    errorMessage: "Couldn't save these settings.",
    // A stale answer rereads too: the editor saves again against the new revision.
    invalidateMethods: ["providers.list"],
    prepareRequest: (request) => {
      cloudVerdictPreflight("environment.configuration.skills.setProviders")();
      return Promise.resolve(request);
    },
    onSuccess: (_result, request) =>
      invalidateConfigurationReads(queries, request.environmentId, [
        "environment.configuration.skills.list",
      ]),
  });
  return { remove, setProviders };
}
