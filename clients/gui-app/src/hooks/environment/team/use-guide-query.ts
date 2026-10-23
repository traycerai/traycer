import { useQueryClient } from "@tanstack/react-query";
import { useConfigurationSource } from "@/components/settings/environment/configuration-source";
import { useTeamViewingHost } from "./use-team-viewing-host";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useHostScopedMutationForClient } from "@/hooks/host/use-host-scoped-mutation";
import { cloudVerdictPreflight } from "@/lib/host/cloud-verdict-preflight";
import { environmentMutationKeys, hostQueryKeys } from "@/lib/query-keys";

export function useConfigurationGuideQuery() {
  const source = useConfigurationSource();
  const scope = useTeamViewingHost();
  const viewerId = useCloudChatViewerId();
  const authorized = useAuthStore((state) =>
    authorizesCloudCapability(state.status),
  );
  return useHostQuery({
    cacheKeyIdentity: [viewerId],
    client: scope.client,
    method: "environment.configuration.guide.get",
    params: {
      environmentId: source.kind === "pool" ? source.environmentId : "",
    },
    preflight: cloudVerdictPreflight("environment.configuration.guide.get"),
    options: {
      enabled:
        source.kind === "pool" &&
        scope.client !== null &&
        viewerId.length > 0 &&
        authorized,
    },
  });
}

export function useConfigurationGuideMutations() {
  const scope = useTeamViewingHost();
  const queries = useQueryClient();
  const reread = (environmentId: string, hostId: string | null): void => {
    void queries.invalidateQueries({
      queryKey: hostQueryKeys.method(
        hostId,
        "environment.configuration.guide.get",
        { environmentId },
      ),
    });
  };
  const set = useHostScopedMutationForClient(scope.client, {
    method: "environment.configuration.guide.set",
    mutationKey: environmentMutationKeys.configurationGuideSet(),
    errorMessage: "Couldn't save the guide.",
    invalidateMethods: [],
    prepareRequest: (request) => {
      cloudVerdictPreflight("environment.configuration.guide.set")();
      return Promise.resolve(request);
    },
    onSuccess: (_result, request, hostId) =>
      reread(request.environmentId, hostId),
  });
  const reset = useHostScopedMutationForClient(scope.client, {
    method: "environment.configuration.guide.reset",
    mutationKey: environmentMutationKeys.configurationGuideReset(),
    errorMessage: "Couldn't reset the guide.",
    invalidateMethods: [],
    prepareRequest: (request) => {
      cloudVerdictPreflight("environment.configuration.guide.reset")();
      return Promise.resolve(request);
    },
    onSuccess: (_result, request, hostId) =>
      reread(request.environmentId, hostId),
  });
  return { set, reset };
}
