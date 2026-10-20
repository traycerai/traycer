import { useEffect, useRef } from "react";
import { toast } from "sonner";
import type { HostListResponse } from "@traycer/protocol/host/host-status";
import { useRegisteredHosts } from "@/hooks/auth/use-registered-hosts-query";
import { useAuthStore, type EpicShareableTeam } from "@/stores/auth/auth-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { removedTeamIds } from "./team-removal-model";
import { subscribeTeamMemberRemovedClose } from "@traycer-clients/shared/host-transport/team-member-removed-close";

interface RememberedTeam {
  readonly name: string;
  readonly hostIds: ReadonlySet<string>;
}

/**
 * A removed team member's tiles on the team's hosts close, with "You are no
 * longer a member of <team>." Two triggers report the same removal: a team host
 * ending one of this person's sessions with `TEAM_MEMBER_REMOVED`, and the
 * person's own team list (the auth projection) losing the team while the same
 * person stays signed in (the admins' `team.member.removed` never reaches the
 * member removed). Whichever comes first closes and says so; the other finds
 * the team already closed, so there is one toast and one close, never two. The
 * team's hosts and name are remembered while the person is in it, because by
 * the time either trigger fires the registry may already have stopped listing
 * them.
 */
export function useCloseTilesOnTeamRemoval(): void {
  const teams = useAuthStore((s) => s.shareableTeams);
  const status = useAuthStore((s) => s.status);
  const viewerUserId = useAuthStore((s) => s.contextMetadata?.userId ?? null);
  const registry = useRegisteredHosts().data ?? null;
  const memory = useRef(emptyRemovalMemory());
  const previous = useRef<{
    readonly viewerUserId: string | null;
    readonly signedIn: boolean;
    readonly teamIds: readonly string[];
  } | null>(null);

  useEffect(() => {
    const signedIn = status === "signed-in";
    const teamIds = teams.map((team) => team.teamId);
    const before = previous.current;
    if (
      before !== null &&
      before.signedIn &&
      signedIn &&
      before.viewerUserId === viewerUserId
    ) {
      closeRemovedTeams(before.teamIds, teamIds, memory.current);
    }
    if (before !== null && before.viewerUserId !== viewerUserId) {
      memory.current = emptyRemovalMemory();
    }
    rememberTeams(teams, registry, memory.current);
    previous.current = { viewerUserId, signedIn, teamIds };
  }, [registry, status, teams, viewerUserId]);

  useEffect(
    () =>
      subscribeTeamMemberRemovedClose((hostId) => {
        closeTeamOnHost(hostId, memory.current);
      }),
    [],
  );
}

interface RemovalMemory {
  /** The person's current teams, by id. */
  readonly remembered: Map<string, RememberedTeam>;
  /**
   * Teams a host's `TEAM_MEMBER_REMOVED` already closed while the team list
   * still listed them: the list's own removal of them is the same removal.
   */
  readonly closedByHost: Set<string>;
}

function emptyRemovalMemory(): RemovalMemory {
  return { remembered: new Map(), closedByHost: new Set() };
}

/** Closes each removed team's tiles and says so, once per removal. */
function closeRemovedTeams(
  previousTeamIds: readonly string[],
  teamIds: readonly string[],
  memory: RemovalMemory,
): void {
  for (const teamId of removedTeamIds(previousTeamIds, teamIds)) {
    if (memory.closedByHost.delete(teamId)) continue;
    closeTeam(teamId, memory);
  }
}

/** A host ended this person's session for leaving its team: close that team. */
function closeTeamOnHost(hostId: string, memory: RemovalMemory): void {
  for (const [teamId, team] of memory.remembered) {
    if (!team.hostIds.has(hostId)) continue;
    closeTeam(teamId, memory);
    memory.closedByHost.add(teamId);
    return;
  }
}

function closeTeam(teamId: string, memory: RemovalMemory): void {
  const team = memory.remembered.get(teamId);
  if (team === undefined) return;
  useEpicCanvasStore.getState().closeTilesOnHosts(team.hostIds);
  toast.info(`You are no longer a member of ${team.name}.`);
  memory.remembered.delete(teamId);
}

/**
 * Remembers each current team's name and hosts, keeping what was seen before.
 * A team a host already closed stays forgotten until the list drops it.
 */
function rememberTeams(
  teams: ReadonlyArray<EpicShareableTeam>,
  registry: HostListResponse | null,
  memory: RemovalMemory,
): void {
  const remembered = memory.remembered;
  for (const team of teams) {
    if (memory.closedByHost.has(team.teamId)) continue;
    const known = remembered.get(team.teamId);
    const hostIds = new Set(known?.hostIds ?? []);
    let name: string | null = null;
    for (const host of registry?.hosts ?? []) {
      if (host.owner?.kind !== "team" || host.owner.id !== team.teamId) {
        continue;
      }
      hostIds.add(host.hostId);
      name = host.owner.name;
    }
    remembered.set(team.teamId, {
      name: name ?? known?.name ?? team.slug,
      hostIds,
    });
  }
}
