import type { TierGroup } from "@traycer/protocol/host/fallback-policy";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useHostMethodSchemaVersion } from "@/hooks/host/use-host-supports-method";
import { useTeamViewingHost } from "./use-team-viewing-host";

const METHOD = "providers.fallbackPolicy.previewTierGroups";

/** Preview the explicit draft on the team host, including blank pattern rows. */
export function useConfigurationRoutingPreviewQuery(
  groups: readonly TierGroup[],
) {
  const scope = useTeamViewingHost();
  const line = useHostMethodSchemaVersion(
    scope.viewingHost?.hostId ?? null,
    METHOD,
  );
  const patterns =
    line !== null &&
    ((line.major === 1 && line.minor >= 1) || line.major === 2);
  return useHostQuery({
    client: scope.client,
    cacheKeyIdentity: undefined,
    method: METHOD,
    params: { groups: [...groups] },
    requiredHostMethodVersion: () =>
      line === null ? null : { method: METHOD, version: line },
    options: {
      enabled: scope.client !== null && patterns && groups.length > 0,
      staleTime: 30_000,
    },
  });
}
