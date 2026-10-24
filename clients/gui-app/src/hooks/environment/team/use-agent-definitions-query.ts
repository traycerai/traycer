import type { UseQueryResult } from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { EnvironmentAgentDefinitionsListResponse } from "@traycer/protocol/host/environment-schemas";
import { useConfigurationSource } from "@/components/settings/environment/configuration-source";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useHostClient } from "@/lib/host";
import {
  useConfigurationItemsQuery,
  type ConfigurationItem,
} from "./use-configuration-items-query";

/** Definitions remain revisioned items; the guide uses the configuration room. */
export function useEnvironmentAgentDefinitionsQuery(
  hostEnabled: boolean,
): UseQueryResult<EnvironmentAgentDefinitionsListResponse, HostRpcError> {
  const source = useConfigurationSource();
  const own = useHostQuery({
    cacheKeyIdentity: undefined,
    client: useHostClient(),
    method: "environment.agentDefinitions.list",
    params: {},
    options: { enabled: source.kind === "host" && hostEnabled },
  });
  const team = useConfigurationItemsQuery("agent-definitions", definitionsOf);
  return source.kind === "pool" ? team : own;
}

function definitionsOf(
  items: readonly ConfigurationItem[],
): EnvironmentAgentDefinitionsListResponse {
  return {
    definitions: items.flatMap((item) => {
      if (item.kind !== "agent_definition") return [];
      const value = item.value;
      if (
        value === null ||
        typeof value !== "object" ||
        !("text" in value) ||
        typeof value.text !== "string"
      ) {
        throw new Error("Couldn't read an agent definition.");
      }
      return [{ name: item.key, text: value.text, revision: item.revision }];
    }),
  };
}
