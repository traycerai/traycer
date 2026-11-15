import { useMemo } from "react";
import type { SandboxSummary } from "@traycer/protocol/host/sandbox-control";
import { sandboxCreateTeams } from "@/components/hosts/sandbox-create-model";
import { useAuthUser } from "@/hooks/auth/use-auth-user-query";
import { useEnvironmentListQuery } from "@/hooks/bots/use-environment-list-query";
import { useOptionalHostClient } from "@/lib/host";
import { useSandboxCatalogue } from "@/hooks/sandboxes/use-sandbox-catalogue-query";
import { useTeamEnvironmentIds } from "@/hooks/sandboxes/use-team-environment-query";
import type { SandboxPageConfiguration } from "@/lib/sandboxes/sandbox-row-lines";
import { wakeString } from "@/lib/sandboxes/sandbox-strings";

export interface SandboxConfigurations {
  /** Personal first, then each team the person belongs to, by name. */
  readonly configurations: readonly SandboxPageConfiguration[];
  /** Every team's environment id read so far. */
  readonly teamEnvironmentIds: ReadonlySet<string>;
  /**
   * The person's teams are known and every team has answered, so Personal's
   * rows can be told apart.
   */
  readonly complete: boolean;
  /**
   * The person's own environment's id where their environment list is
   * already in hand, else `null`. It names Personal's rows before the teams
   * answer; nothing is read for it.
   */
  readonly personalEnvironmentId: string | null;
}

/**
 * The configurations a Sandboxes page can show: Personal and each of the
 * person's teams, each team with the environment id its sandbox rows carry.
 */
export function useSandboxConfigurations(): SandboxConfigurations {
  const userRead = useAuthUser();
  const user = userRead.data ?? null;
  // The person's teams are known only once the user read has answered: a
  // pending or failed read, or data kept from before a failed refetch, says
  // nothing about which teams there are.
  const teamsKnown = !userRead.isPending && !userRead.isError && user !== null;
  const teams = useMemo(() => sandboxCreateTeams(user), [user]);
  const teamIds = useMemo(() => teams.map((team) => team.teamId), [teams]);
  const environments = useTeamEnvironmentIds(teamIds);
  const { byTeamId } = environments;
  const complete = teamsKnown && environments.complete;
  // The environment list another surface has read (the team Admin read):
  // only what is already cached, never a read of its own.
  const list = useEnvironmentListQuery(useOptionalHostClient(), false);
  const personalEnvironmentId = list.isError
    ? null
    : (list.data?.environments.find(
        (environment) => environment.ownerKind === "user",
      )?.environmentId ?? null);
  return useMemo(() => {
    const configurations: SandboxPageConfiguration[] = [
      { kind: "personal" },
      ...teams.map((team): SandboxPageConfiguration => ({
        kind: "team",
        teamId: team.teamId,
        teamName: team.name,
        environmentId: byTeamId.get(team.teamId) ?? null,
      })),
    ];
    return {
      configurations,
      teamEnvironmentIds: new Set(byTeamId.values()),
      complete,
      personalEnvironmentId,
    };
  }, [teams, byTeamId, complete, personalEnvironmentId]);
}

/**
 * The configuration a sandbox row belongs to: the team whose environment it
 * carries; Personal for a row nobody else started, once that is told apart
 * from a team's (a team's pods and a server before `createdBy` carry no
 * creator either): its environment is the person's own, or every team has
 * answered and none is its. `null` where the app does not know whose sandbox
 * it is: a team row whose team is not (yet) among the person's, a row with
 * no creator while the person's teams are unread or a team is unanswered or
 * failed, or a row with no environment id (a server before environments),
 * whose owner the wire leaves unknown.
 */
export function sandboxConfigurationOf(
  summary: SandboxSummary,
  configurations: SandboxConfigurations,
): SandboxPageConfiguration | null {
  const team = configurations.configurations.find(
    (configuration) =>
      configuration.kind === "team" &&
      configuration.environmentId !== null &&
      configuration.environmentId === summary.environmentId,
  );
  if (team !== undefined) return team;
  if (summary.createdBy !== null) return null;
  const ownEnvironment =
    summary.environmentId !== null &&
    summary.environmentId === configurations.personalEnvironmentId;
  const teamsTold =
    summary.environmentId !== null &&
    configurations.complete &&
    !configurations.teamEnvironmentIds.has(summary.environmentId);
  return ownEnvironment || teamsTold ? { kind: "personal" } : null;
}

/** The wake string of the sandbox's shape class, from the catalogue. */
export function useSandboxWakeString(summary: SandboxSummary): string | null {
  const provider =
    useSandboxCatalogue(true).data?.providers.find(
      (p) => p.provider === summary.provider && p.os.includes(summary.os),
    ) ?? null;
  return provider === null ? null : wakeString(provider.suspendFidelity);
}
