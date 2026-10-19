import type { EpicCollaboratorsView } from "@/hooks/epics/use-epic-collaborators-query";

/**
 * The first tab a member opens on a team host: what running there means, then
 * the two residual sentences the disclosure must carry.
 */
export function teamHostDisclosureSentences(
  teamName: string,
): readonly [string, string, string] {
  return [
    `Agents here run as the host. Anything another member's agent does on it can read what yours can, browser sign-ins included. Agents here work with ${teamName}'s hosts only. A browser-using agent here runs its browser in the sandbox, never on your computer.`,
    "Another member's agent here can act and be charged as you while you are attached.",
    `A copy of your sign-in to this host, taken by anyone who was root here, keeps working against ${teamName}'s hosts until this host sleeps.`,
  ];
}

export function teamHostOutsideReadersLine(teamName: string): string {
  return `People outside ${teamName} can read chats in this task.`;
}

/**
 * Whether the task has readers outside the owning team. Any other team is
 * outside, the task's Owner team included (the collaborators view carries
 * it apart from the shared teams). A direct reader is outside unless the
 * owning team's members are known and include them; when they are unknown
 * (the team is not a reader of this task), every direct reader but the
 * viewer counts, so the disclosure says too much rather than claiming nobody
 * outside can read.
 */
export function taskHasReadersOutsideTeam(input: {
  readonly viewerUserId: string;
  readonly teamId: string;
  readonly collaborators: EpicCollaboratorsView | null;
}): boolean {
  const { collaborators } = input;
  if (collaborators === null) return false;
  const teams =
    collaborators.ownerTeam === null
      ? collaborators.teams
      : [collaborators.ownerTeam, ...collaborators.teams];
  if (teams.some((team) => team.teamId !== input.teamId)) {
    return true;
  }
  const owning = teams.find((team) => team.teamId === input.teamId);
  const members =
    owning === undefined
      ? null
      : new Set(owning.members.map((member) => member.userId));
  return collaborators.directUsers.some(
    (user) =>
      user.userId !== input.viewerUserId &&
      (members === null || !members.has(user.userId)),
  );
}
