import {
  useConfigurationItemsQuery,
  type ConfigurationItem,
} from "./use-configuration-items-query";
export function useConfigurationMcpQuery() {
  return useConfigurationItemsQuery(
    "mcp-servers",
    (items: readonly ConfigurationItem[]) =>
      items.filter((item) => item.kind === "mcp_server"),
  );
}
