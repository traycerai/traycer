import type {
  ListTaskLight,
  PermissionDto,
} from "@traycer/protocol/host/epic/unary-schemas";
import type { EpicShareableTeam } from "@/stores/auth/auth-store";

/** Verbatim: a team the person cannot name. */
export const UNKNOWN_TEAM_LABEL = "A team";

/**
 * The team that owns a task, from the viewer's permission row:
 * `accessType: "organization"` with `role: "owner"` and its `organizationId`.
 * An organization row with any other role is a task shared with the team, not
 * one it owns. `null` for any other row, or none.
 */
export function taskOwningTeamId(
  permission: PermissionDto | null | undefined,
): string | null {
  if (permission?.accessType !== "organization") return null;
  if (permission.role !== "owner") return null;
  const teamId = permission.organizationId ?? "";
  return teamId.length === 0 ? null : teamId;
}

/** The team's slug among the person's teams, else "A team". */
export function teamTaskLabel(
  teamId: string,
  teams: ReadonlyArray<EpicShareableTeam>,
): string {
  return (
    teams.find((team) => team.teamId === teamId)?.slug ?? UNKNOWN_TEAM_LABEL
  );
}

/** Whether any listed task is owned by `teamId`. */
export function tasksIncludeTeamTask(
  tasks: ReadonlyArray<ListTaskLight>,
  teamId: string,
): boolean {
  return tasks.some(
    (task) => taskOwningTeamId(task.epic?.permission) === teamId,
  );
}
