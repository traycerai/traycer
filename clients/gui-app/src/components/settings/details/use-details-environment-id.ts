import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { usePersonalEnvironment } from "@/hooks/environment/use-addressed-environment";
import type { HostRpcRegistry } from "@/lib/host";
import { useEnvironmentPick } from "@/stores/settings/settings-environment-pick-store";
import { UNRELEASED_FEATURES_ENABLED } from "@/unreleased-features";

/**
 * Resolves Personal from the authorized list; a team pick never falls back.
 * A build without environments (`unreleased-features.ts`) has no Personal
 * to resolve and names the host's own.
 */
export function useDetailsEnvironmentId(
  client: HostClient<HostRpcRegistry>,
): string | null {
  const pick = useEnvironmentPick();
  const personal = usePersonalEnvironment(
    client,
    UNRELEASED_FEATURES_ENABLED && pick.kind !== "team",
  );
  return pick.kind === "team" ? pick.environmentId : personal.environmentId;
}
