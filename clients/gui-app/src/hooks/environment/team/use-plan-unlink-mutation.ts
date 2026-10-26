import { usePoolTierHostClient } from "@/hooks/host/use-pool-tier";
import { useQueryClient } from "@tanstack/react-query";
import { invalidateConfigurationReads } from "@/hooks/environment/environment-host-list-key";
import { useHostScopedMutationForClient } from "@/hooks/host/use-host-scoped-mutation";
import { useHostClient } from "@/lib/host";
import { cloudVerdictPreflight } from "@/lib/host/cloud-verdict-preflight";
import { environmentMutationKeys } from "@/lib/query-keys";

export function useConfigurationPlanUnlinkMutation() {
  const queries = useQueryClient();
  return useHostScopedMutationForClient(
    usePoolTierHostClient(useHostClient()),
    {
      method: "environment.plans.unlink",
      mutationKey: environmentMutationKeys.plansUnlink(),
      errorMessage: "Couldn't unlink this plan.",
      invalidateMethods: ["environment.list"],
      prepareRequest: (request) => {
        cloudVerdictPreflight("environment.plans.unlink")();
        return Promise.resolve(request);
      },
      onSuccess: (_result, request) =>
        invalidateConfigurationReads(queries, request.environmentId, [
          "environment.plans.list",
          "environment.configuration.items",
        ]),
    },
  );
}
