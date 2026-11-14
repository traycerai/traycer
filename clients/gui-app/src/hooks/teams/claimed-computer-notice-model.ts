import type { HostListResponse } from "@traycer/protocol/host/host-status";
import type { ClaimedComputer } from "@traycer-clients/shared/auth/claimed-computers";
import type { SeenTeamComputer } from "@/stores/hosts/claimed-computer-notice-store";

/** The team computers a registry lists now, by host id. */
export function teamComputersOf(
  registry: HostListResponse,
): ReadonlyMap<string, SeenTeamComputer> {
  const computers = new Map<string, SeenTeamComputer>();
  for (const host of registry.hosts) {
    if (host.owner?.kind !== "team") continue;
    computers.set(host.hostId, {
      teamId: host.owner.id,
      teamName: host.owner.name,
    });
  }
  return computers;
}

/**
 * The team computers seen before that the list no longer carries, while the
 * person is still in their team. A computer whose whole team left the list
 * is a removal from the team, which says its own sentence.
 */
export function departedTeamComputers(
  seen: Readonly<Record<string, SeenTeamComputer>>,
  listed: ReadonlyMap<string, SeenTeamComputer>,
  teamIds: ReadonlySet<string>,
): ReadonlyArray<readonly [string, SeenTeamComputer]> {
  return Object.entries(seen).filter(
    ([hostId, computer]) => !listed.has(hostId) && teamIds.has(computer.teamId),
  );
}

/** One claim, told once per device: the computer and when it was claimed. */
export function claimNoticeKey(claim: ClaimedComputer): string {
  return `${claim.hostId}@${claim.claimedAt}`;
}

/**
 * The owner's sentence for a claimed computer (14 Nov): the one notice
 * teammates get, and what a teammate connected to it sees.
 */
export function claimedComputerSentence(
  claimantName: string,
  teamName: string,
): string {
  return `${claimantName} claimed this computer. It no longer belongs to ${teamName}.`;
}
