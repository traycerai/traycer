import {
  useConfigurationItemsQuery,
  type ConfigurationItem,
} from "./use-configuration-items-query";

export function useConfigurationProviderItemsQuery() {
  return useConfigurationItemsQuery(
    "providers",
    (items: readonly ConfigurationItem[]) =>
      items.filter(
        (item) =>
          item.kind === "managed_profile" ||
          item.kind === "env_override" ||
          item.kind === "pack_policy" ||
          item.kind === "mcp_server",
      ),
  );
}
