import { useHostScopedMutationForClient } from "@/hooks/host/use-host-scoped-mutation";
import { useTeamViewingHost } from "./use-team-viewing-host";
import { environmentMutationKeys } from "@/lib/query-keys";
import { cloudVerdictPreflight } from "@/lib/host/cloud-verdict-preflight";

export function useConfigurationSkillsUploadMutation() {
  const scope = useTeamViewingHost();
  return useHostScopedMutationForClient(scope.client, {
    method: "environment.configuration.skills.upload",
    mutationKey: environmentMutationKeys.configurationSkillsUpload(),
    errorMessage: "Couldn't add the skill.",
    invalidateMethods: ["providers.list"],
    prepareRequest: (request) => {
      cloudVerdictPreflight("environment.configuration.skills.upload")();
      return Promise.resolve(request);
    },
  });
}
