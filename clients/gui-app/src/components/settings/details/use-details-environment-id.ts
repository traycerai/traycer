import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { useEnvironmentListQuery } from "@/hooks/bots/use-environment-list-query";
import type { HostRpcRegistry } from "@/lib/host";
import { useEnvironmentPick } from "@/stores/settings/settings-environment-pick-store";

/** Resolves Personal from the authorized list; a team pick never falls back. */
export function useDetailsEnvironmentId(
  client: HostClient<HostRpcRegistry>,
): string | null {
  const pick = useEnvironmentPick();
  const environments = useEnvironmentListQuery(client, pick.kind !== "team");
  if (pick.kind === "team") return pick.environmentId;
  if (environments.isError) return null;
  return (
    environments.data?.environments.find(
      (environment) => environment.ownerKind === "user",
    )?.environmentId ?? null
  );
}
