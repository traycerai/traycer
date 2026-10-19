import type { EpicCreateOwner } from "@traycer/protocol/host/epic/unary-schemas";
import {
  EPIC_CREATE_TEAM_OWNER_MINOR,
  TEAM_CREATE_HOST_TOO_OLD,
} from "@/lib/epic-create-admission";
import type { NegotiatedMethodVersion } from "@/lib/host/read-negotiated-method-version";
import type { EpicShareableTeam } from "@/stores/auth/auth-store";

/**
 * Who a new task belongs to, as the person picked it on the landing draft's
 * Belongs to chip. No pick yet is `null` in the store, and the owner then
 * follows the resolved host.
 */
export type LandingOwnerChoice =
  | { readonly kind: "personal" }
  | { readonly kind: "team"; readonly teamId: string };

/** A team a task can belong to, named by its slug. */
export interface LandingOwnerTeam {
  readonly teamId: string;
  readonly slug: string;
}

/**
 * The owner a create sends. An explicit pick wins; with none, the team that
 * owns the resolved host when it is one of the person's teams, else Personal.
 * A team the person is no longer in is Personal.
 */
export function resolveLandingOwner(input: {
  readonly choice: LandingOwnerChoice | null;
  readonly resolvedHostTeamId: string | null;
  readonly teams: ReadonlyArray<EpicShareableTeam>;
}): LandingOwnerTeam | null {
  if (input.choice?.kind === "personal") return null;
  const teamId =
    input.choice === null ? input.resolvedHostTeamId : input.choice.teamId;
  if (teamId === null) return null;
  const team = input.teams.find((candidate) => candidate.teamId === teamId);
  return team === undefined ? null : { teamId, slug: team.slug };
}

/**
 * Why a team create cannot be sent, decided before any frame, or `null`. The
 * host first (a known version below `1.3`, or the method absent), then the
 * cloud authorization. An unknown version is not refused here: the transport's
 * `epic.create@1.3` floor refuses it before the frame.
 */
export function landingOwnerRefusal(input: {
  readonly owner: LandingOwnerTeam;
  readonly hostEpicCreateVersion: NegotiatedMethodVersion;
  readonly cloudAuthorized: boolean;
}): string | null {
  const version = input.hostEpicCreateVersion;
  if (
    version === false ||
    (version !== null &&
      version.major === 1 &&
      version.minor < EPIC_CREATE_TEAM_OWNER_MINOR)
  ) {
    return TEAM_CREATE_HOST_TOO_OLD;
  }
  if (!input.cloudAuthorized) return teamCreateSignInLine(input.owner.slug);
  return null;
}

/** The person is signed out of the cloud, verbatim. */
export function teamCreateSignInLine(slug: string): string {
  return `Sign in to create a task for ${slug}.`;
}

/** The first-chat line under a team pick, verbatim. */
export function teamFirstChatLine(slug: string): string {
  return `Chats here are visible to everyone in ${slug}`;
}

/** The `epic.create@1.3` `owner` for a pick: `null` is the person. */
export function epicCreateOwnerFor(
  owner: LandingOwnerTeam | null,
): EpicCreateOwner | null {
  return owner === null ? null : { kind: "team", teamId: owner.teamId };
}
