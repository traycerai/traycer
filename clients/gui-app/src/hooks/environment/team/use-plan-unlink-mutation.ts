import { useHostScopedMutationForClient } from "@/hooks/host/use-host-scoped-mutation";
import { useHostClient } from "@/lib/host";
import { cloudVerdictPreflight } from "@/lib/host/cloud-verdict-preflight";
import { environmentMutationKeys } from "@/lib/query-keys";

export function useConfigurationPlanUnlinkMutation() {
  return useHostScopedMutationForClient(useHostClient(), {
    method: "environment.plans.unlink",
    mutationKey: environmentMutationKeys.plansUnlink(),
    errorMessage: "Couldn't unlink this plan.",
    invalidateMethods: [
      "environment.plans.list",
      "environment.list",
      "environment.configuration.items",
    ],
    prepareRequest: (request) => {
      cloudVerdictPreflight("environment.plans.unlink")();
      return Promise.resolve(request);
    },
  });
}
