import { useCallback, useMemo } from "react";
import type { EnvironmentListResponseV11 } from "@traycer/protocol/host/environment/contracts";
import { configurationRoleOf } from "@/components/settings/environment/configuration-source";
import { useEnvironmentListQuery } from "@/hooks/bots/use-environment-list-query";
import { useTeamEnvironmentIds } from "@/hooks/sandboxes/use-team-environment-query";

const NO_TEAM: readonly string[] = [];

/**
 * Read from the person's own environment list, never a sandbox's computer. Nobody
 * is an Admin while a read is out or failed. `teamIds` must keep its identity.
 */
export function useTeamBillingAdminOf(
  teamIds: readonly string[],
): (teamId: string) => boolean {
  const { byTeamId } = useTeamEnvironmentIds(teamIds);
  const environments = useEnvironmentListQuery(byTeamId.size > 0);
  const descriptors = environments.isError
    ? undefined
    : environments.data?.environments;
  const admins = useMemo(() => {
    const found = new Set<string>();
    for (const [teamId, environmentId] of byTeamId) {
      if (adminOf(descriptors, environmentId)) found.add(teamId);
    }
    return found;
  }, [byTeamId, descriptors]);
  return useCallback((teamId: string) => admins.has(teamId), [admins]);
}

export function useEnvironmentBillingAdmin(environmentId: string): boolean {
  const environments = useEnvironmentListQuery(true);
  return adminOf(
    environments.isError ? undefined : environments.data?.environments,
    environmentId,
  );
}

function adminOf(
  descriptors: EnvironmentListResponseV11["environments"] | undefined,
  environmentId: string,
): boolean {
  const descriptor = descriptors?.find(
    (environment) => environment.environmentId === environmentId,
  );
  return (
    descriptor !== undefined && configurationRoleOf(descriptor) === "admin"
  );
}

export function useTeamBillingAdmin(teamId: string | null): boolean {
  const teamIds = useMemo(
    () => (teamId === null ? NO_TEAM : [teamId]),
    [teamId],
  );
  const isAdmin = useTeamBillingAdminOf(teamIds);
  return teamId !== null && isAdmin(teamId);
}

/** `null` (owner unknown) offers it to nobody. */
export function useOffersAddCredits(
  configuration:
    | { readonly kind: "personal" }
    | { readonly kind: "team"; readonly teamId: string }
    | null,
): boolean {
  const admin = useTeamBillingAdmin(
    configuration?.kind === "team" ? configuration.teamId : null,
  );
  return configuration?.kind === "personal" || admin;
}
