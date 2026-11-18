import {
  useConfigurationItemsQuery,
  type ConfigurationItem,
} from "./use-configuration-items-query";

export function useConfigurationVariablesQuery() {
  return useConfigurationItemsQuery(
    "variables-and-shells",
    (items: readonly ConfigurationItem[]) =>
      items.filter((item) => item.kind === "variable" || item.kind === "shell"),
  );
}
