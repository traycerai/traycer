import type { EnvironmentStatusResponseV11 } from "@traycer/protocol/host/environment-schemas";
import { hostSettingsCardState } from "@/components/settings/panels/host-overview-settings-card-model";
import type { EpicShareableTeam } from "@/stores/auth/auth-store";

/** Verbatim: a chat whose host runs Personal, in a team's task. */
export const TEAM_EPIC_PERSONAL_LINE = "Running on your Personal settings.";

/** The tab host's settings place, using the Overview's classification. */
export function teamEpicSettingsLine(
  status: EnvironmentStatusResponseV11 | null,
): string | null {
  if (status === null) return null;
  const state = hostSettingsCardState(status);
  switch (state.kind) {
    case "local":
      return "Running on this computer's own settings.";
    case "moved":
    case "other":
      return TEAM_EPIC_PERSONAL_LINE;
    case "moving":
    case "move_stopped":
      return null;
  }
}

/**
 * The team a chat could continue on: the team that owns the task, when the
 * person is in it and the chat's host is not a team's. `null` hides the line.
 */
export function teamEpicPersonalNotice(input: {
  readonly epicTeamId: string | null;
  readonly tabHostTeamId: string | null;
  readonly teams: ReadonlyArray<EpicShareableTeam>;
}): { readonly teamId: string; readonly slug: string } | null {
  if (input.epicTeamId === null || input.tabHostTeamId !== null) return null;
  const team = input.teams.find(
    (candidate) => candidate.teamId === input.epicTeamId,
  );
  return team === undefined ? null : { teamId: team.teamId, slug: team.slug };
}

/** The action under the line, verbatim. */
export function teamEpicContinueLabel(slug: string): string {
  return `Continue on a ${slug} host`;
}

/** What first use per person per team asks, verbatim. */
export function teamEpicContinueCaution(slug: string): string {
  return `Everything in this chat, including what people outside ${slug} wrote, becomes the working context of an agent that holds ${slug}'s secrets.`;
}
