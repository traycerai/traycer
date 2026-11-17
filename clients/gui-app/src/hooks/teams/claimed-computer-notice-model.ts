import type { HostListResponse } from "@traycer/protocol/host/host-status";
import type { EnvironmentListResponseV11 } from "@traycer/protocol/host/environment/contracts";
import type { ClaimedComputer } from "@traycer-clients/shared/auth/claimed-computers";

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

export interface NoticeTeam {
  readonly environmentId: string;
  readonly teamName: string;
}

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

/** A computer whose team the person left is a removal, which says its own sentence. */
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
 * The newest claim of each computer this person claimed here is theirs and only
 * settled; every other is a teammate's to tell. Claims arrive newest first.
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

/** Told once per device. */
export function claimNoticeKey(claim: ClaimedComputer): string {
  return `${claim.hostId}@${claim.claimedAt}`;
}

export function claimedComputerTitle(claimantName: string): string {
  return `${claimantName} claimed this computer`;
}

export function claimedComputerDetail(teamName: string): string {
  return `It no longer belongs to ${teamName}.`;
}

export function claimedComputerSentence(
  claimantName: string,
  teamName: string,
): string {
  return `${claimedComputerTitle(claimantName)}. ${claimedComputerDetail(teamName)}`;
}
