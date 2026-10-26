import {
  useConfigurationItemsQuery,
  type ConfigurationItem,
} from "./use-configuration-items-query";
import { configurationPolicyValueSchema } from "./configuration-item-values";
import { useQueryClient } from "@tanstack/react-query";
import { invalidateConfigurationReads } from "@/hooks/environment/environment-host-list-key";
import { useHostScopedMutationForClient } from "@/hooks/host/use-host-scoped-mutation";
import { useHostClient } from "@/lib/host";
import { environmentMutationKeys } from "@/lib/query-keys";
import { cloudVerdictPreflight } from "@/lib/host/cloud-verdict-preflight";

export function useConfigurationPolicyQuery() {
  return useConfigurationItemsQuery(
    "approval-policy",
    (items: readonly ConfigurationItem[]) => {
      const row = items.find(
        (item) => item.kind === "auto_policy" && item.key === "policy",
      );
      return row === undefined
        ? { body: "", revision: null }
        : {
            body: configurationPolicyValueSchema.parse(row.value).body,
            revision: row.revision,
          };
    },
  );
}

export function useConfigurationPolicyMutation() {
  const queries = useQueryClient();
  return useHostScopedMutationForClient(useHostClient(), {
    method: "environment.configuration.policy.put",
    mutationKey: environmentMutationKeys.configurationPolicyPut(),
    errorMessage: "Couldn't save the approval policy.",
    invalidateMethods: [],
    prepareRequest: (request) => {
      cloudVerdictPreflight("environment.configuration.policy.put")();
      return Promise.resolve(request);
    },
    onSuccess: (_result, request) =>
      invalidateConfigurationReads(queries, request.environmentId, [
        "environment.configuration.items",
      ]),
  });
}
