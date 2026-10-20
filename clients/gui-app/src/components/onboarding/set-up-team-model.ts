import type { SeenRecord } from "@/lib/persist/keyed-seen-store";
import { teamHostDisclosureSeen } from "@/stores/hosts/team-host-disclosure-seen-store";

/** The newcomer's line, naming the next step. */
export function teamNewcomerLine(teamName: string): string {
  return `To work in ${teamName}, open a tab on one of its sandboxes, in your host list under ${teamName}, or create one from there.`;
}

/**
 * The teams this person has never opened a tab in: none of the team's hosts
 * has a first-tab disclosure this viewer has seen. A team with no known host
 * is one too. In the input's order.
 */
export function newcomerTeams(input: {
  readonly teams: readonly { readonly teamId: string; readonly name: string }[];
  readonly hostIdsByTeam: ReadonlyMap<string, readonly string[]>;
  readonly seen: SeenRecord;
  readonly viewerUserId: string;
}): readonly { readonly teamId: string; readonly name: string }[] {
  return input.teams.filter(
    (team) =>
      !(input.hostIdsByTeam.get(team.teamId) ?? []).some((hostId) =>
        teamHostDisclosureSeen(input.seen, input.viewerUserId, hostId),
      ),
  );
}
