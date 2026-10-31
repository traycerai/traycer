import type { AuthenticatedUser } from "@traycer/protocol/auth";
import type { EnvironmentProviderCounts } from "@traycer-clients/shared/host-client/sandbox-secrets";
import { creditBreakdown } from "@/lib/auth/traycer-subscription-content";

const MC_PER_CREDIT = 1000;

/**
 * Whom a new sandbox belongs to: the person (Personal) or one of their teams.
 * The form's **Belongs to** and an entry's preselection both carry it.
 */
export type SandboxCreateBelongsTo =
  | { readonly kind: "personal" }
  | { readonly kind: "team"; readonly teamId: string };

/** A team the person may create into, named by its slug. */
export interface SandboxCreateTeam {
  readonly teamId: string;
  readonly name: string;
}

/**
 * The teams the form offers: the person's `teamSubscriptions` (accepted
 * memberships whose subscription is not pending), by name then id.
 */
export function sandboxCreateTeams(
  user: AuthenticatedUser | null,
): readonly SandboxCreateTeam[] {
  if (user === null) return [];
  return user.teamSubscriptions
    .map((subscription) => ({
      teamId: subscription.team.id,
      name: subscription.team.slug,
    }))
    .sort(
      (a, b) =>
        a.name.localeCompare(b.name) || a.teamId.localeCompare(b.teamId),
    );
}

/**
 * What Belongs to starts at: the entry's preselection, then the team that
 * owns the host the person is working from, then Personal. A team the person
 * is not in (no longer, or never) is skipped, since the form cannot offer it.
 */
export function defaultBelongsTo(
  preselect: SandboxCreateBelongsTo | null,
  workingHostTeamId: string | null,
  teams: readonly SandboxCreateTeam[],
): SandboxCreateBelongsTo {
  const isMember = (teamId: string): boolean =>
    teams.some((team) => team.teamId === teamId);
  if (preselect !== null) {
    if (preselect.kind === "personal") return preselect;
    if (isMember(preselect.teamId)) return preselect;
  }
  if (workingHostTeamId !== null && isMember(workingHostTeamId)) {
    return { kind: "team", teamId: workingHostTeamId };
  }
  return { kind: "personal" };
}

/** The four lines a team pick always shows, in order. */
export function sandboxTeamCreateLines(teamName: string): readonly string[] {
  return [
    `Belongs to: ${teamName}`,
    `Charged to your bundle under ${teamName}.`,
    `Chats on it are visible to the people of the task you use it in, which can include people outside ${teamName}.`,
    `Agents on it work with ${teamName}'s hosts only; they cannot work with agents on your own computer. The task still shares its files and chats.`,
  ];
}

/**
 * The person's balance under a team, in millicredits: what the control
 * plane's gate reads for a team sandbox (the member's own assignment under
 * the team), computed as `sandboxBalanceMc` computes the personal one.
 * `null` when the user, or their entry for that team, has not loaded.
 */
export function teamSandboxBalanceMc(
  user: AuthenticatedUser | null,
  teamId: string,
): number | null {
  const subscription =
    user?.teamSubscriptions.find((entry) => entry.team.id === teamId) ?? null;
  if (subscription === null) return null;
  const breakdown = creditBreakdown(subscription);
  const remaining = Math.max(
    0,
    breakdown.totalAvailable - breakdown.totalConsumed,
  );
  return Math.floor(remaining * MC_PER_CREDIT);
}

/**
 * Whether the balance cannot cover one hour of the region's smallest shape:
 * a lower bound, since the catalogue prices only that shape. The server's
 * `insufficient_credit` refusal is the exact answer. Unknown either side is
 * not a shortfall.
 */
export function teamCannotCoverAnHour(
  balanceMc: number | null,
  fromAwakeMcPerHour: number | null,
): boolean {
  if (balanceMc === null || fromAwakeMcPerHour === null) return false;
  return balanceMc < fromAwakeMcPerHour;
}

/** "No plan and no API keys", from an answered count; unknown is not none. */
export function teamHasNoProviders(
  counts: EnvironmentProviderCounts | null,
): boolean {
  if (counts === null) return false;
  return counts.providerSecretCount === 0 && counts.connectedPlanCount === 0;
}

export function sandboxNoProvidersLine(teamName: string): string {
  return `No providers configured for ${teamName}; agents cannot run until an admin adds one`;
}

/** The server names no team on this refusal; the form names the one picked. */
export function sandboxNotAMemberLine(teamName: string): string {
  return `You are not a member of ${teamName}.`;
}

export const SANDBOX_CREATE_ENVIRONMENT_UNAVAILABLE_LINE =
  "Traycer couldn't check where this sandbox belongs. Try again in a moment.";

export const SANDBOX_CREATE_ASK_ADMIN_LABEL =
  "Ask a team admin for more capacity";
