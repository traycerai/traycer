import type { UseQueryResult } from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { EMPTY_CLI_CONFIG } from "@traycer/protocol/config/schema";
import { useConfigurationSource } from "@/components/settings/environment/configuration-source";
import { useHostQueryWithResponseMap } from "@/hooks/host/use-host-query";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import {
  useConfigurationItemsQuery,
  type ConfigurationItem,
} from "./use-configuration-items-query";

interface BrowserAccessSnapshot {
  readonly agentAccess: boolean;
  readonly revision: number | null;
}

export function useEnvironmentBrowserAccessQuery(
  hostEnabled: boolean,
): UseQueryResult<BrowserAccessSnapshot, HostRpcError> {
  const source = useConfigurationSource();
  const own = useHostQueryWithResponseMap<
    HostRpcRegistry,
    "config.browser.get",
    BrowserAccessSnapshot
  >({
    cacheKeyIdentity: ["configuration-source"],
    client: useHostClient(),
    method: "config.browser.get",
    params: {},
    mapResponse: ({ response }) => ({ ...response, revision: null }),
    options: { enabled: source.kind === "host" && hostEnabled },
  });
  const team = useConfigurationItemsQuery(
    "browser-agent-access",
    browserAccessOf,
  );
  return source.kind === "pool" ? team : own;
}

function browserAccessOf(
  items: readonly ConfigurationItem[],
): BrowserAccessSnapshot {
  const item = items.find(
    (row) => row.kind === "browser_agent_access" && row.key === "browser",
  );
  if (item === undefined)
    return {
      agentAccess: EMPTY_CLI_CONFIG.browser.agentAccess,
      revision: null,
    };
  const value = item.value;
  if (
    value === null ||
    typeof value !== "object" ||
    !("enabled" in value) ||
    typeof value.enabled !== "boolean"
  ) {
    throw new Error("Couldn't read agent browser access.");
  }
  return { agentAccess: value.enabled, revision: item.revision };
}
