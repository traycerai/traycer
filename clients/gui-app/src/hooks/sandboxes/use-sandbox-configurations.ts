import { useMemo } from "react";
import type { SandboxSummary } from "@traycer/protocol/host/sandbox-control";
import { sandboxCreateTeams } from "@/components/hosts/sandbox-create-model";
import { useAuthUser } from "@/hooks/auth/use-auth-user-query";
import { useSandboxCatalogue } from "@/hooks/sandboxes/use-sandbox-catalogue-query";
import { useTeamEnvironmentIds } from "@/hooks/sandboxes/use-team-environment-query";
import type { SandboxPageConfiguration } from "@/lib/sandboxes/sandbox-row-lines";
import { wakeString } from "@/lib/sandboxes/sandbox-strings";

export interface SandboxConfigurations {
  /** Personal first, then each team the person belongs to, by name. */
  readonly configurations: readonly SandboxPageConfiguration[];
  /** Every team's environment id read so far. */
  readonly teamEnvironmentIds: ReadonlySet<string>;
  /** Every team has answered, so Personal's rows can be told apart. */
  readonly complete: boolean;
}

/**
 * The configurations a Sandboxes page can show: Personal and each of the
 * person's teams, each team with the environment id its sandbox rows carry.
 */
export function useSandboxConfigurations(): SandboxConfigurations {
  const user = useAuthUser().data ?? null;
  const teams = useMemo(() => sandboxCreateTeams(user), [user]);
  const teamIds = useMemo(() => teams.map((team) => team.teamId), [teams]);
  const environments = useTeamEnvironmentIds(teamIds);
  const { byTeamId, complete } = environments;
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
    };
  }, [teams, byTeamId, complete]);
}

/**
 * The configuration a sandbox row belongs to: the team whose environment it
 * carries, else Personal for a row nobody else started. A team row whose team
 * is not (yet) among the person's reads as `null`.
 */
export function sandboxConfigurationOf(
  summary: SandboxSummary,
  configurations: readonly SandboxPageConfiguration[],
): SandboxPageConfiguration | null {
  const team = configurations.find(
    (configuration) =>
      configuration.kind === "team" &&
      configuration.environmentId !== null &&
      configuration.environmentId === summary.environmentId,
  );
  if (team !== undefined) return team;
  return summary.createdBy === null ? { kind: "personal" } : null;
}

/** The wake string of the sandbox's shape class, from the catalogue. */
export function useSandboxWakeString(summary: SandboxSummary): string | null {
  const provider =
    useSandboxCatalogue(true).data?.providers.find(
      (p) => p.provider === summary.provider && p.os.includes(summary.os),
    ) ?? null;
  return provider === null ? null : wakeString(provider.suspendFidelity);
}
