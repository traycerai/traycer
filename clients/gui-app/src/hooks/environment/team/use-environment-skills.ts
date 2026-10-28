import type { UseQueryResult } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  EnvironmentConfigurationSkillsListResponseV11,
  EnvironmentConfigurationSkillsStateResponse,
} from "@traycer/protocol/host/environment/configuration-contracts";
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
 * The configuration's skills, from its room: `client` is
 * `useConfigurationReadClient`'s, so no host has to be running it. A build
 * with no pool asks the picked host, and any other host answers
 * `not_served`. `enabled` is the caller's: false while the serving tier has
 * not negotiated the method.
 */
export function useEnvironmentSkillsQuery(
  client: HostClient<HostRpcRegistry>,
  enabled: boolean,
): UseQueryResult<EnvironmentConfigurationSkillsListResponseV11, HostRpcError> {
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
      poll: true,
      enabled:
        enabled && source.kind === "pool" && viewerId.length > 0 && authorized,
    },
  });
}

/** The reads a skill write moves: the room's list and the serving host's state. */
const SKILL_READS = [
  "environment.configuration.skills.list",
  "environment.configuration.skills.state",
] as const;

/**
 * What the host serving the configuration knows of its skills and the pool
 * does not (each one's version, whether an update is available, the
 * built-ins it can restore), from the viewing host (`client`), which
 * answers `not_served` unless it serves the configuration. It reads what the
 * last check of each skill's source found; `useEnvironmentSkillsCheck`
 * checks again.
 */
export function useEnvironmentSkillsStateQuery(
  client: HostClient<HostRpcRegistry> | null,
  enabled: boolean,
): UseQueryResult<EnvironmentConfigurationSkillsStateResponse, HostRpcError> {
  const source = useConfigurationSource();
  const viewerId = useCloudChatViewerId();
  const authorized = useAuthStore((state) =>
    authorizesCloudCapability(state.status),
  );
  return useHostQuery({
    cacheKeyIdentity: [viewerId],
    client,
    method: "environment.configuration.skills.state",
    params: {
      environmentId: source.kind === "pool" ? source.environmentId : "",
      refresh: false,
    },
    preflight: cloudVerdictPreflight("environment.configuration.skills.state"),
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

/**
 * Remove a skill, switch it per provider and set its update policy, through
 * the tier that serves the configuration's room (`client`, the read
 * client's).
 */
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
      invalidateConfigurationReads(queries, request.environmentId, SKILL_READS),
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
      invalidateConfigurationReads(queries, request.environmentId, SKILL_READS),
  });
  const setPolicy = useHostScopedMutationForClient(client, {
    method: "environment.configuration.skills.setPolicy",
    mutationKey: environmentMutationKeys.configurationSkillsSetPolicy(),
    errorMessage: "Couldn't save this skill's updates setting.",
    // The policy moves what each provider's view holds.
    invalidateMethods: ["providers.list"],
    prepareRequest: (request) => {
      cloudVerdictPreflight("environment.configuration.skills.setPolicy")();
      return Promise.resolve(request);
    },
    onSuccess: (_result, request) =>
      invalidateConfigurationReads(queries, request.environmentId, SKILL_READS),
  });
  return { remove, setProviders, setPolicy };
}

/**
 * Update a skill to its upstream's version, restore a removed built-in,
 * import skills from a source and check every skill's source again, on the
 * viewing host (`client`): only a host serving the configuration holds its
 * build's skills and reaches their sources.
 */
export function useEnvironmentSkillHostMutations(
  client: HostClient<HostRpcRegistry> | null,
) {
  const queries = useQueryClient();
  const update = useHostScopedMutationForClient(client, {
    method: "environment.configuration.skills.update",
    mutationKey: environmentMutationKeys.configurationSkillsUpdate(),
    errorMessage: "Couldn't update this skill.",
    invalidateMethods: ["providers.list"],
    prepareRequest: (request) => {
      cloudVerdictPreflight("environment.configuration.skills.update")();
      return Promise.resolve(request);
    },
    onSuccess: (_result, request) =>
      invalidateConfigurationReads(queries, request.environmentId, SKILL_READS),
  });
  const restoreBundled = useHostScopedMutationForClient(client, {
    method: "environment.configuration.skills.restoreBundled",
    mutationKey: environmentMutationKeys.configurationSkillsRestoreBundled(),
    errorMessage: "Couldn't restore this skill.",
    invalidateMethods: ["providers.list"],
    prepareRequest: (request) => {
      cloudVerdictPreflight(
        "environment.configuration.skills.restoreBundled",
      )();
      return Promise.resolve(request);
    },
    onSuccess: (_result, request) =>
      invalidateConfigurationReads(queries, request.environmentId, SKILL_READS),
  });
  const importSkills = useHostScopedMutationForClient(client, {
    method: "environment.configuration.skills.import",
    mutationKey: environmentMutationKeys.configurationSkillsImport(),
    errorMessage: "Couldn't import from this source.",
    invalidateMethods: ["providers.list"],
    prepareRequest: (request) => {
      cloudVerdictPreflight("environment.configuration.skills.import")();
      return Promise.resolve(request);
    },
    onSuccess: (result, request) => {
      if (result.outcome === "installed")
        invalidateConfigurationReads(
          queries,
          request.environmentId,
          SKILL_READS,
        );
    },
  });
  // A check of every skill's source, whose answer the state read shows.
  const checkUpdates = useHostScopedMutationForClient(client, {
    method: "environment.configuration.skills.state",
    mutationKey: environmentMutationKeys.configurationSkillsCheckUpdates(),
    errorMessage: "Couldn't check for updates.",
    invalidateMethods: [],
    prepareRequest: (request) => {
      cloudVerdictPreflight("environment.configuration.skills.state")();
      return Promise.resolve(request);
    },
    onSuccess: (_result, request) =>
      invalidateConfigurationReads(queries, request.environmentId, SKILL_READS),
  });
  return { update, restoreBundled, importSkills, checkUpdates };
}
