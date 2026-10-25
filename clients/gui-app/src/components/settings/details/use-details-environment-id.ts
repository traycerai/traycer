import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { usePersonalEnvironment } from "@/hooks/environment/use-addressed-environment";
import type { HostRpcRegistry } from "@/lib/host";
import { useEnvironmentPick } from "@/stores/settings/settings-environment-pick-store";

/** Resolves Personal from the authorized list; a team pick never falls back. */
export function useDetailsEnvironmentId(
  client: HostClient<HostRpcRegistry>,
): string | null {
  const pick = useEnvironmentPick();
  const personal = usePersonalEnvironment(client, pick.kind !== "team");
  return pick.kind === "team" ? pick.environmentId : personal.environmentId;
}
