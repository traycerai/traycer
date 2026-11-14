import { useEffect, useMemo, useRef } from "react";
import { queryOptions, useQueries } from "@tanstack/react-query";
import { toast } from "sonner";
import { create } from "zustand";
import type { ClaimedComputer } from "@traycer-clients/shared/auth/claimed-computers";
import type { HostLeaseSnapshot } from "@traycer-clients/shared/host-selection/selection-authority-contract";
import type { HostDoorState } from "@traycer-clients/shared/host-transport/host-door-state";
import type { AuthService } from "@/lib/auth/auth-service";
import { useHostBinding } from "@/lib/host";
import { authQueryKeys } from "@/lib/query-keys/auth-query-keys";
import { useRegisteredHosts } from "@/hooks/auth/use-registered-hosts-query";
import { useEnvironmentListQuery } from "@/hooks/bots/use-environment-list-query";
import { useHostLeases } from "@/hooks/host/use-host-lease";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useHostDoorStateStore } from "@/stores/host/host-door-state-store";
import {
  settleOwnClaims,
  takeClaimNotice,
  useClaimNoticesToldStore,
  useOwnClaimsStore,
  type OwnClaim,
} from "@/stores/hosts/claimed-computer-notice-store";
import {
  claimNoticeKey,
  claimedComputerSentence,
  departedTeams,
  noticeTeamsOf,
  splitOwnClaims,
  teamComputersOf,
  type NoticeTeam,
} from "./claimed-computer-notice-model";

/** One signed-in person on one session: a read answered in another is dropped. */
interface ClaimReadEra {
  readonly auth: AuthService;
  readonly viewerUserId: string;
}

interface ClaimReadsState {
  readonly era: ClaimReadEra | null;
  /** The sign-in read has been asked for, in this era. */
  readonly signInAsked: boolean;
  /** The teams whose claims still need a read that answers: team id to read. */
  readonly pending: Readonly<Record<string, number>>;
}

const useClaimReadsStore = create<ClaimReadsState>()(() => ({
  era: null,
  signInAsked: false,
  pending: {},
}));

let lastRead = 0;

function sameEra(a: ClaimReadEra | null, b: ClaimReadEra | null): boolean {
  return a?.auth === b?.auth && a?.viewerUserId === b?.viewerUserId;
}

function beginEra(era: ClaimReadEra | null): void {
  if (sameEra(useClaimReadsStore.getState().era, era)) return;
  useClaimReadsStore.setState({ era, signInAsked: false, pending: {} });
}

/** Ask for a fresh read of each team; a team already waiting is read again. */
function askReads(
  era: ClaimReadEra,
  teamIds: Iterable<string>,
  signIn: boolean,
): void {
  const asked = [...teamIds];
  useClaimReadsStore.setState((state) => {
    if (!sameEra(state.era, era)) return state;
    if (asked.length === 0 && (state.signInAsked || !signIn)) return state;
    const pending = { ...state.pending };
    for (const teamId of asked) {
      lastRead += 1;
      pending[teamId] = lastRead;
    }
    return { pending, signInAsked: state.signInAsked || signIn };
  });
}

/** A team's read answered, or the person left the team: nothing waits on it. */
function settleRead(era: ClaimReadEra, teamId: string, read: number): void {
  useClaimReadsStore.setState((state) => {
    if (!sameEra(state.era, era) || state.pending[teamId] !== read)
      return state;
    const { [teamId]: _settled, ...pending } = state.pending;
    return { pending };
  });
}

function isCurrentEra(era: ClaimReadEra): boolean {
  const auth = useAuthStore.getState();
  return (
    sameEra(useClaimReadsStore.getState().era, era) &&
    auth.status === "signed-in" &&
    auth.contextMetadata?.userId === era.viewerUserId
  );
}

/** A refused or failed read is an error, so it waits and is read again. */
async function readClaims(
  auth: AuthService,
  environmentId: string,
  signal: AbortSignal,
): Promise<readonly ClaimedComputer[]> {
  const result = await auth.listClaimedComputers(environmentId, signal);
  if (result.kind === "ok") return result.claims;
  // Not a member that may read it: there is nothing to tell.
  if (result.kind === "not-found") return [];
  throw new Error(`The claimed computers read ${result.kind}.`);
}

function servingHostIds(
  leases: readonly HostLeaseSnapshot[],
): ReadonlySet<string> {
  return new Set(
    leases
      .filter((lease) => lease.status === "ready" || lease.status === "degraded")
      .map((lease) => lease.hostId),
  );
}

function claimedDoorHostIds(
  byHost: ReadonlyMap<string, HostDoorState>,
): ReadonlySet<string> {
  return new Set(
    [...byHost.values()]
      .filter((state) => state.kind === "host-claimed")
      .map((state) => state.hostId),
  );
}

/** What the last look saw: the listed team computers and their connections. */
interface Look {
  readonly listed: ReadonlyMap<string, string>;
  readonly serving: ReadonlySet<string>;
  readonly claimedDoors: ReadonlySet<string>;
}

/** The teams a team computer of closed since `previous`. */
function closedTeams(previous: Look, next: Look): ReadonlySet<string> {
  const closed = new Set<string>();
  for (const [hostId, teamId] of [...previous.listed, ...next.listed]) {
    const connectionClosed =
      previous.serving.has(hostId) && !next.serving.has(hostId);
    const claimedClose =
      !previous.claimedDoors.has(hostId) && next.claimedDoors.has(hostId);
    if (connectionClosed || claimedClose) closed.add(teamId);
  }
  return closed;
}

const NO_OWN_CLAIMS: readonly OwnClaim[] = [];

interface ReadTarget extends NoticeTeam {
  readonly teamId: string;
  readonly read: number;
}

/**
 * A teammate's claim of a team computer, told once per device (ruling 2,
 * 14 Nov). The app reads authn's claimed computers for each of the person's
 * teams on sign-in, and again for a team when one of its computers leaves
 * the list or its connection closes. Every claim this device has not told
 * yet shows the owner's sentence. A team's read waits until one answers: a
 * failed read is read again on focus and on the next list refresh.
 */
export function useClaimedComputerNotice(): void {
  const auth = useHostBinding()?.auth ?? null;
  const viewerUserId = useAuthStore((state) =>
    state.status === "signed-in"
      ? (state.contextMetadata?.userId ?? null)
      : null,
  );
  const era = useMemo<ClaimReadEra | null>(
    () =>
      auth === null || viewerUserId === null ? null : { auth, viewerUserId },
    [auth, viewerUserId],
  );
  const registered = useRegisteredHosts();
  const registry = registered.data ?? null;
  const environments = useEnvironmentListQuery(era !== null).data ?? null;
  const teams = useMemo(
    () => (environments === null ? null : noticeTeamsOf(environments)),
    [environments],
  );
  const leases = useHostLeases();
  const doorStates = useHostDoorStateStore((state) => state.byHost);
  const ownClaims = useOwnClaimsStore((state) =>
    viewerUserId === null
      ? NO_OWN_CLAIMS
      : (state.byViewer[viewerUserId] ?? NO_OWN_CLAIMS),
  );
  const pending = useClaimReadsStore((state) =>
    sameEra(state.era, era) ? state.pending : null,
  );
  const look = useRef<{ era: ClaimReadEra; look: Look } | null>(null);

  const targets = useMemo<readonly ReadTarget[]>(() => {
    if (pending === null || teams === null) return [];
    return Object.entries(pending).flatMap(([teamId, read]) => {
      const team = teams.get(teamId);
      return team === undefined ? [] : [{ teamId, read, ...team }];
    });
  }, [pending, teams]);
  const results = useQueries({
    queries: targets.map((target) =>
      queryOptions({
        queryKey: authQueryKeys.claimedComputers(
          auth,
          viewerUserId,
          target.environmentId,
          target.read,
        ),
        queryFn: ({ signal }) => {
          if (auth === null) throw new Error("Signed out.");
          return readClaims(auth, target.environmentId, signal);
        },
        enabled: era !== null,
        gcTime: 0,
      }),
    ),
  });
  const failedTeams = targets
    .filter((_target, index) =>  results[index]?.isError)
    .map((target) => target.teamId)
    .join("\u0000");

  useEffect(() => {
    beginEra(era);
  }, [era]);

  // The sign-in read: every team the person is in, once per era.
  useEffect(() => {
    if (era === null || teams === null) return;
    if (useClaimReadsStore.getState().signInAsked) return;
    askReads(era, teams.keys(), true);
  }, [era, teams]);

  // A team the person left has nothing to tell; the removal says its own.
  useEffect(() => {
    if (era === null || teams === null || pending === null) return;
    for (const [teamId, read] of Object.entries(pending)) {
      if (!teams.has(teamId)) settleRead(era, teamId, read);
    }
  }, [era, pending, teams]);

  // A computer of a team left the list, or its connection closed.
  useEffect(() => {
    if (era === null || registry === null || teams === null) return;
    const next: Look = {
      listed: teamComputersOf(registry),
      serving: servingHostIds(leases),
      claimedDoors: claimedDoorHostIds(doorStates),
    };
    const previous = look.current?.era === era ? look.current.look : null;
    look.current = { era, look: next };
    if (previous === null) return;
    askReads(
      era,
      new Set([
        ...departedTeams(previous.listed, next.listed, teams),
        ...closedTeams(previous, next),
      ]),
      false,
    );
  }, [doorStates, era, leases, registry, teams]);

  // A read that failed is read again when the list refreshes, even when the
  // refresh answers the same list.
  const refreshedAt = registered.dataUpdatedAt;
  const lastRefresh = useRef(refreshedAt);
  useEffect(() => {
    if (lastRefresh.current === refreshedAt) return;
    lastRefresh.current = refreshedAt;
    if (era === null || failedTeams === "") return;
    askReads(era, failedTeams.split("\u0000"), false);
  }, [era, failedTeams, refreshedAt]);

  // This person's own claim: read its team so the record is settled.
  useEffect(() => {
    if (era === null || teams === null || ownClaims.length === 0) return;
    const teamIds = new Set<string>();
    for (const [teamId, team] of teams) {
      if (ownClaims.some((claim) => claim.environmentId === team.environmentId))
        teamIds.add(teamId);
    }
    askReads(era, teamIds, false);
  }, [era, ownClaims, teams]);

  const answered = targets.flatMap((target, index) => {
    const data = results[index]?.data;
    return data === undefined ? [] : [{ target, claims: data }];
  });
  useEffect(() => {
    if (era === null) return;
    for (const { target, claims } of answered) {
      // A read that answers after a sign-out or a switch tells no one.
      if (!isCurrentEra(era)) return;
      tellClaims(era.viewerUserId, target, claims);
      settleRead(era, target.teamId, target.read);
    }
  }, [answered, era]);
}

function tellClaims(
  viewerUserId: string,
  target: ReadTarget,
  claims: readonly ClaimedComputer[],
): void {
  const ownHostIds = new Set(
    (useOwnClaimsStore.getState().byViewer[viewerUserId] ?? [])
      .filter((claim) => claim.environmentId === target.environmentId)
      .map((claim) => claim.hostId),
  );
  const { own, teammates } = splitOwnClaims(claims, ownHostIds);
  for (const claim of own) {
    useClaimNoticesToldStore
      .getState()
      .markSeen(viewerUserId, claimNoticeKey(claim));
  }
  settleOwnClaims(viewerUserId, target.environmentId);
  for (const claim of teammates) {
    if (!takeClaimNotice(viewerUserId, claimNoticeKey(claim))) continue;
    toast.info(claimedComputerSentence(claim.claimantName, target.teamName), {
      id: `claimed-computer:${claimNoticeKey(claim)}`,
    });
  }
}
