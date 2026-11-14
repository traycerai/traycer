import { useCallback, useMemo } from "react";
import { configurationRoleOf } from "@/components/settings/environment/configuration-source";
import { useEnvironmentListQuery } from "@/hooks/bots/use-environment-list-query";
import { useTeamEnvironmentIds } from "@/hooks/sandboxes/use-team-environment-query";
import { useHostClient } from "@/lib/host";

const NO_TEAM: readonly string[] = [];

/**
 * For each of `teamIds`, whether the person is that team's Admin, the one
 * seat that may buy the team's credits. Read from the person's own
 * environment list (the team's environment, found by the team's id, and the
 * role the list gives the person there), never from a sandbox's computer.
 * While either read is out or failed, nobody is an Admin: until it is known,
 * the person is not one. `teamIds` must keep its identity between renders.
 */
export function useTeamBillingAdminOf(
  teamIds: readonly string[],
): (teamId: string) => boolean {
  const { byTeamId } = useTeamEnvironmentIds(teamIds);
  const environments = useEnvironmentListQuery(
    useHostClient(),
    byTeamId.size > 0,
  );
  const descriptors = environments.isError
    ? undefined
    : environments.data?.environments;
  const admins = useMemo(() => {
    const found = new Set<string>();
    if (descriptors === undefined) return found;
    for (const [teamId, environmentId] of byTeamId) {
      const descriptor = descriptors.find(
        (environment) => environment.environmentId === environmentId,
      );
      if (
        descriptor !== undefined &&
        configurationRoleOf(descriptor) === "admin"
      ) {
        found.add(teamId);
      }
    }
    return found;
  }, [byTeamId, descriptors]);
  return useCallback((teamId: string) => admins.has(teamId), [admins]);
}

/** Whether the person is `teamId`'s Admin; false for no team. */
export function useTeamBillingAdmin(teamId: string | null): boolean {
  const teamIds = useMemo(
    () => (teamId === null ? NO_TEAM : [teamId]),
    [teamId],
  );
  const isAdmin = useTeamBillingAdminOf(teamIds);
  return teamId !== null && isAdmin(teamId);
}

/**
 * Whether "Add credits ↗" is offered for a configuration: always for the
 * person's own credits, and for a team's only to its Admin, the one seat the
 * team's billing page lets buy.
 */
export function useOffersAddCredits(
  configuration:
    | { readonly kind: "personal" }
    | { readonly kind: "team"; readonly teamId: string },
): boolean {
  const admin = useTeamBillingAdmin(
    configuration.kind === "team" ? configuration.teamId : null,
  );
  return configuration.kind === "personal" || admin;
}
