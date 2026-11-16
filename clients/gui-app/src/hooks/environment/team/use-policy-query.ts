import {
  useConfigurationItemsQuery,
  type ConfigurationItem,
} from "./use-configuration-items-query";
import { configurationPolicyValueSchema } from "./configuration-item-values";
import { useQueryClient } from "@tanstack/react-query";
import { invalidateConfigurationReads } from "@/hooks/environment/environment-host-list-key";
import { useEnvironmentCloudMutation } from "@/hooks/environment/use-environment-cloud";
import { environmentMutationKeys } from "@/lib/query-keys";

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
  return useEnvironmentCloudMutation({
    method: "environment.configuration.policy.put",
    mutationKey: environmentMutationKeys.configurationPolicyPut(),
    errorMessage: "Couldn't save the approval policy.",
    invalidateMethods: [],
    onSuccess: (_result, request) =>
      invalidateConfigurationReads(queries, request.environmentId, [
        "environment.configuration.items",
      ]),
  });
}
