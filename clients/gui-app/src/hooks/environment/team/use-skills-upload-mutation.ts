import { useQueryClient } from "@tanstack/react-query";
import { invalidateConfigurationReads } from "@/hooks/environment/environment-host-list-key";
import { useHostScopedMutationForClient } from "@/hooks/host/use-host-scoped-mutation";
import { useConfigurationReadClient } from "./use-configuration-read-client";
import { environmentMutationKeys } from "@/lib/query-keys";
import { cloudVerdictPreflight } from "@/lib/host/cloud-verdict-preflight";

/** Adds a skill to the configuration's room, through the same client as its list. */
export function useConfigurationSkillsUploadMutation() {
  const client = useConfigurationReadClient();
  const queries = useQueryClient();
  return useHostScopedMutationForClient(client, {
    method: "environment.configuration.skills.upload",
    mutationKey: environmentMutationKeys.configurationSkillsUpload(),
    errorMessage: "Couldn't add the skill.",
    invalidateMethods: ["providers.list"],
    prepareRequest: (request) => {
      cloudVerdictPreflight("environment.configuration.skills.upload")();
      return Promise.resolve(request);
    },
    // The page lists the uploaded skill from `skills.list`, which never polls.
    onSuccess: (_result, request) =>
      invalidateConfigurationReads(queries, request.environmentId, [
        "environment.configuration.skills.list",
      ]),
  });
}
