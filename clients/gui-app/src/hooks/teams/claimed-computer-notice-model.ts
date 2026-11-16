import type { HostListResponse } from "@traycer/protocol/host/host-status";
import type { EnvironmentListResponseV11 } from "@traycer/protocol/host/environment/contracts";
import type { ClaimedComputer } from "@traycer-clients/shared/auth/claimed-computers";

/** The team computers a registry lists now: host id to its team's id. */
export function teamComputersOf(
  registry: HostListResponse,
): ReadonlyMap<string, string> {
  const computers = new Map<string, string>();
  for (const host of registry.hosts) {
    if (host.owner?.kind !== "team") continue;
    computers.set(host.hostId, host.owner.id);
  }
  return computers;
}

/** A team the person is in, by its team id: its environment and name. */
export interface NoticeTeam {
  readonly environmentId: string;
  readonly teamName: string;
}

/** The person's teams as the environment list answers them, by team id. */
export function noticeTeamsOf(
  environments: EnvironmentListResponseV11,
): ReadonlyMap<string, NoticeTeam> {
  const teams = new Map<string, NoticeTeam>();
  for (const descriptor of environments.environments) {
    if (descriptor.ownerKind === "user") continue;
    teams.set(descriptor.ownerId, {
      environmentId: descriptor.environmentId,
      teamName: descriptor.label,
    });
  }
  return teams;
}

/**
 * The teams whose computer left the list since the last look. A computer
 * whose team the person left is a removal, which says its own sentence.
 */
export function departedTeams(
  previous: ReadonlyMap<string, string>,
  listed: ReadonlyMap<string, string>,
  teams: ReadonlyMap<string, NoticeTeam>,
): ReadonlySet<string> {
  const departed = new Set<string>();
  for (const [hostId, teamId] of previous) {
    if (!listed.has(hostId) && teams.has(teamId)) departed.add(teamId);
  }
  return departed;
}

/**
 * A read's claims split in two: the newest claim of each computer this
 * person just claimed here is theirs and only settled; every other claim is
 * a teammate's to tell. Claims arrive newest first.
 */
export function splitOwnClaims(
  claims: readonly ClaimedComputer[],
  ownHostIds: ReadonlySet<string>,
): {
  readonly own: readonly ClaimedComputer[];
  readonly teammates: readonly ClaimedComputer[];
} {
  const settled = new Set<string>();
  const own: ClaimedComputer[] = [];
  const teammates: ClaimedComputer[] = [];
  for (const claim of claims) {
    if (ownHostIds.has(claim.hostId) && !settled.has(claim.hostId)) {
      settled.add(claim.hostId);
      own.push(claim);
    } else {
      teammates.push(claim);
    }
  }
  return { own, teammates };
}

/** One claim, told once per device: the computer and when it was claimed. */
export function claimNoticeKey(claim: ClaimedComputer): string {
  return `${claim.hostId}@${claim.claimedAt}`;
}

/** The first line of a claimed computer's notice: who claimed it. */
export function claimedComputerTitle(claimantName: string): string {
  return `${claimantName} claimed this computer`;
}

/** The second line of a claimed computer's notice: the team it left. */
export function claimedComputerDetail(teamName: string): string {
  return `It no longer belongs to ${teamName}.`;
}

/**
 * The owner's sentence for a claimed computer (14 Nov): the one notice
 * teammates get, and what a teammate connected to it sees.
 */
export function claimedComputerSentence(
  claimantName: string,
  teamName: string,
): string {
  return `${claimedComputerTitle(claimantName)}. ${claimedComputerDetail(teamName)}`;
}
