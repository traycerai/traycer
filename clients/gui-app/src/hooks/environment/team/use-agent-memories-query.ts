import type { UseQueryResult } from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { useConfigurationSource } from "@/components/settings/environment/configuration-source";
import { useHostQueryWithResponseMap } from "@/hooks/host/use-host-query";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import {
  useConfigurationItemsQuery,
  type ConfigurationItem,
} from "./use-configuration-items-query";

interface AgentMemoriesSnapshot {
  readonly enabled: boolean;
  /** The item's row revision, which a write must name; null on a host read. */
  readonly revision: number | null;
}

/**
 * Whether the configuration this page shows lets its agents take part in its
 * shared memories. Read from the configuration on its own pages and from the
 * window's host otherwise, the same two sources as agent browser access.
 *
 * No item is off: an environment that has never been asked keeps the
 * behaviour it had.
 */
export function useEnvironmentAgentMemoriesQuery(
  hostEnabled: boolean,
): UseQueryResult<AgentMemoriesSnapshot, HostRpcError> {
  const source = useConfigurationSource();
  const own = useHostQueryWithResponseMap<
    HostRpcRegistry,
    "config.agentMemories.get",
    AgentMemoriesSnapshot
  >({
    cacheKeyIdentity: ["configuration-source"],
    client: useHostClient(),
    method: "config.agentMemories.get",
    params: {},
    mapResponse: ({ response }) => ({ ...response, revision: null }),
    options: { enabled: source.kind === "host" && hostEnabled },
  });
  const team = useConfigurationItemsQuery("agent-memories", agentMemoriesOf);
  return source.kind === "pool" ? team : own;
}

function agentMemoriesOf(
  items: readonly ConfigurationItem[],
): AgentMemoriesSnapshot {
  const item = items.find(
    (row) => row.kind === "agent_memory" && row.key === "memory",
  );
  if (item === undefined) return { enabled: false, revision: null };
  const value = item.value;
  if (
    value === null ||
    typeof value !== "object" ||
    !("enabled" in value) ||
    typeof value.enabled !== "boolean"
  ) {
    throw new Error("Couldn't read the agent memories setting.");
  }
  return { enabled: value.enabled, revision: item.revision };
}
