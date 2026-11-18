import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import { useProvidersListForClient } from "@/hooks/providers/use-providers-list-query";
import { useTeamViewingHost } from "@/hooks/environment/team/use-team-viewing-host";
import type { EnvironmentMcpServer } from "@/hooks/environment/team/use-mcp-servers";
import {
  ORDERED_PROVIDERS,
  providerIdToGuiHarnessId,
} from "@/lib/provider-ordering";
import {
  useConfigurationIsPersonal,
  useConfigurationSource,
} from "./configuration-source";
import { usePickedTeamLabel } from "./team-pick-label";

/** The configuration's name in a sentence: "Personal" or the team's. */
export function useConfigurationName(): string {
  const source = useConfigurationSource();
  const personal = useConfigurationIsPersonal();
  const team =
    usePickedTeamLabel(source.kind === "pool" ? source.environmentId : "") ??
    "this team";
  return personal ? "Personal" : team;
}

/**
 * The providers on the viewing host that take MCP servers, in rail order;
 * every provider when no host answers.
 */
export function useMcpProviders(): readonly ProviderId[] {
  const scope = useTeamViewingHost();
  const catalog = useProvidersListForClient(scope.client, {
    enabled: scope.client !== null,
    subscribed: true,
  });
  const capable = catalog.data?.providers
    .filter((state) => state.nativeCapabilities.mcp !== null)
    .map((state) => state.providerId);
  return ORDERED_PROVIDERS.map((provider) => provider.providerId).filter(
    (id) => capable === undefined || capable.includes(id),
  );
}

/** The providers a server reaches: none while it is disabled. */
export function providersUsing(
  server: EnvironmentMcpServer,
  providers: readonly ProviderId[],
): readonly ProviderId[] {
  const item = server.item;
  if (item === null) return [];
  return providers.filter(
    (id) => !item.offFor.includes(providerIdToGuiHarnessId(id)),
  );
}

export type McpToolToggles = { [harness: string]: { [tool: string]: boolean } };

/** An item value as hosts take it: `offFor` only when it names someone. */
export function mcpItemValue(
  server: EnvironmentMcpServer,
  toolToggles: McpToolToggles,
  offFor: readonly string[],
):
  | { mcpServerId: string; toolToggles: McpToolToggles }
  | { mcpServerId: string; toolToggles: McpToolToggles; offFor: string[] } {
  return offFor.length === 0
    ? { mcpServerId: server.serverId, toolToggles }
    : { mcpServerId: server.serverId, toolToggles, offFor: [...offFor] };
}
