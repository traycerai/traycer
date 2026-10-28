import { useQueryClient } from "@tanstack/react-query";
import { useConfigurationSource } from "@/components/settings/environment/configuration-source";
import { useConfigurationReadClient } from "./use-configuration-read-client";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";
import { invalidateConfigurationReads } from "@/hooks/environment/environment-host-list-key";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useHostSupportsMethod } from "@/hooks/host/use-host-supports-method";
import { useHostScopedMutationForClient } from "@/hooks/host/use-host-scoped-mutation";
import { cloudVerdictPreflight } from "@/lib/host/cloud-verdict-preflight";
import { environmentMutationKeys } from "@/lib/query-keys";

/** The guide, from the configuration's room: no host has to be running it. */
export function useConfigurationGuideQuery() {
  const source = useConfigurationSource();
  const client = useConfigurationReadClient();
  const viewerId = useCloudChatViewerId();
  const authorized = useAuthStore((state) =>
    authorizesCloudCapability(state.status),
  );
  return useHostQuery({
    cacheKeyIdentity: [viewerId],
    client,
    method: "environment.configuration.guide.get",
    params: {
      environmentId: source.kind === "pool" ? source.environmentId : "",
    },
    preflight: cloudVerdictPreflight("environment.configuration.guide.get"),
    options: {
      enabled: source.kind === "pool" && viewerId.length > 0 && authorized,
    },
  });
}

/**
 * Whether the tier that serves the guide takes its writes: the pool once it
 * advertises them, or the picked host in a build without one.
 */
export function useConfigurationGuideWritable(): boolean {
  const client = useConfigurationReadClient();
  return useHostSupportsMethod(
    client.getActiveHostId(),
    "environment.configuration.guide.set",
  );
}

/** Set and reset, through the same client as the read. */
export function useConfigurationGuideMutations() {
  const client = useConfigurationReadClient();
  const queries = useQueryClient();
  const reread = (environmentId: string): void =>
    invalidateConfigurationReads(queries, environmentId, [
      "environment.configuration.guide.get",
    ]);
  const set = useHostScopedMutationForClient(client, {
    method: "environment.configuration.guide.set",
    mutationKey: environmentMutationKeys.configurationGuideSet(),
    errorMessage: "Couldn't save the guide.",
    invalidateMethods: [],
    prepareRequest: (request) => {
      cloudVerdictPreflight("environment.configuration.guide.set")();
      return Promise.resolve(request);
    },
    onSuccess: (_result, request) => reread(request.environmentId),
  });
  const reset = useHostScopedMutationForClient(client, {
    method: "environment.configuration.guide.reset",
    mutationKey: environmentMutationKeys.configurationGuideReset(),
    errorMessage: "Couldn't reset the guide.",
    invalidateMethods: [],
    prepareRequest: (request) => {
      cloudVerdictPreflight("environment.configuration.guide.reset")();
      return Promise.resolve(request);
    },
    onSuccess: (_result, request) => reread(request.environmentId),
  });
  return { set, reset };
}
