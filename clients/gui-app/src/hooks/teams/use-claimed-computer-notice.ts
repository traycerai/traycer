import { useEffect, useMemo, useRef } from "react";
import {
  CancelledError,
  focusManager,
  queryOptions,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { create } from "zustand";
import type {
  ClaimedComputer,
  ClaimedComputersResult,
} from "@traycer-clients/shared/auth/claimed-computers";
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
  readonly signInAsked: boolean;
  readonly lastAsk: number;
  /** A later trigger's ask replaces it. */
  readonly pending: Readonly<Record<string, number>>;
  readonly failed: ReadonlySet<string>;
}

const useClaimReadsStore = create<ClaimReadsState>()(() => ({
  era: null,
  signInAsked: false,
  lastAsk: 0,
  pending: {},
  failed: new Set(),
}));

function sameEra(a: ClaimReadEra | null, b: ClaimReadEra | null): boolean {
  return a?.auth === b?.auth && a?.viewerUserId === b?.viewerUserId;
}

function beginEra(era: ClaimReadEra | null): void {
  if (sameEra(useClaimReadsStore.getState().era, era)) return;
  useClaimReadsStore.setState({
    era,
    signInAsked: false,
    lastAsk: 0,
    pending: {},
    failed: new Set(),
  });
}

/** A failed or refused read is an answer here, told apart after the read (`claimsOf`). */
function claimedComputersOptions(
  auth: AuthService | null,
  userId: string | null,
  environmentId: string,
) {
  return queryOptions({
    queryKey: authQueryKeys.claimedComputers(auth, userId, environmentId),
    gcTime: Number.POSITIVE_INFINITY,
    retry: false,
    queryFn: ({ signal }): Promise<ClaimedComputersResult> =>
      auth === null
        ? Promise.resolve({ kind: "unauthorized" })
        : auth.listClaimedComputers(environmentId, signal),
  });
}

function answersOf(
  queryClient: QueryClient,
  era: ClaimReadEra,
  environmentId: string,
): number {
  const state = queryClient.getQueryState(
    authQueryKeys.claimedComputers(era.auth, era.viewerUserId, environmentId),
  );
  return state === undefined
    ? 0
    : state.dataUpdateCount + state.errorUpdateCount;
}

function claimsOf(
  result: ClaimedComputersResult,
): readonly ClaimedComputer[] | null {
  if (result.kind === "ok") return result.claims;
  if (result.kind === "not-found") return [];
  return null;
}

interface AskedTeam extends NoticeTeam {
  readonly teamId: string;
}

function teamsNamed(
  teams: ReadonlyMap<string, NoticeTeam>,
  teamIds: Iterable<string>,
): readonly AskedTeam[] {
  return [...teamIds].flatMap((teamId) => {
    const team = teams.get(teamId);
    return team === undefined ? [] : [{ teamId, ...team }];
  });
}

function untilNoReadInFlight(
  queryClient: QueryClient,
  queryKey: readonly unknown[],
): Promise<void> {
  return new Promise((resolve) => {
    const unsubscribe = queryClient.getQueryCache().subscribe(() => {
      if (queryClient.isFetching({ queryKey, exact: true }) > 0) return;
      unsubscribe();
      resolve();
    });
  });
}

/**
 * A read already out may predate the trigger and may be the cover's, so it finishes
 * untaken; a read of ours another reader cancels is no answer and is asked again.
 */
async function readForTrigger(
  queryClient: QueryClient,
  era: ClaimReadEra,
  team: AskedTeam,
): Promise<ClaimedComputersResult | null> {
  const options = claimedComputersOptions(
    era.auth,
    era.viewerUserId,
    team.environmentId,
  );
  while (isCurrentEra(era)) {
    if (queryClient.isFetching({ queryKey: options.queryKey, exact: true }) > 0)
      await untilNoReadInFlight(queryClient, options.queryKey);
    if (!isCurrentEra(era)) break;
    const before = answersOf(queryClient, era, team.environmentId);
    try {
      const result = await queryClient.fetchQuery({ ...options, staleTime: 0 });
      // A cancel on an entry with an answer reverts and resolves with it; while this read
      // is out only it or its replacement answers.
      if (answersOf(queryClient, era, team.environmentId) > before)
        return result;
    } catch (error) {
      if (!(error instanceof CancelledError)) throw error;
    }
  }
  return null;
}

/** Only this ask's read settles a team. */
function askReads(
  queryClient: QueryClient,
  era: ClaimReadEra,
  asked: readonly AskedTeam[],
  signIn: boolean,
): void {
  const asks = new Map<string, number>();
  useClaimReadsStore.setState((state) => {
    if (!sameEra(state.era, era)) return state;
    if (asked.length === 0 && (state.signInAsked || !signIn)) return state;
    const pending = { ...state.pending };
    const failed = new Set(state.failed);
    let lastAsk = state.lastAsk;
    for (const team of asked) {
      lastAsk += 1;
      pending[team.teamId] = lastAsk;
      failed.delete(team.teamId);
      asks.set(team.teamId, lastAsk);
    }
    return {
      pending,
      failed,
      lastAsk,
      signInAsked: state.signInAsked || signIn,
    };
  });
  for (const team of asked) {
    const ask = asks.get(team.teamId);
    if (ask === undefined) continue;
    void readForTrigger(queryClient, era, team).then(
      (result) => {
        if (result !== null) answerRead(era, team, ask, claimsOf(result));
      },
      () => {
        answerRead(era, team, ask, null);
      },
    );
  }
}

function answerRead(
  era: ClaimReadEra,
  team: AskedTeam,
  ask: number,
  claims: readonly ClaimedComputer[] | null,
): void {
  // A read that answers after a sign-out or a switch tells no one, and one a
  // later ask replaced answers for nothing.
  if (
    !isCurrentEra(era) ||
    useClaimReadsStore.getState().pending[team.teamId] !== ask
  )
    return;
  if (claims === null) {
    useClaimReadsStore.setState((state) => ({
      failed: new Set(state.failed).add(team.teamId),
    }));
    return;
  }
  tellClaims(era.viewerUserId, team, claims);
  settleRead(era, team.teamId, ask);
}

function settleRead(era: ClaimReadEra, teamId: string, ask: number): void {
  useClaimReadsStore.setState((state) => {
    if (!sameEra(state.era, era) || state.pending[teamId] !== ask) return state;
    const { [teamId]: _settled, ...pending } = state.pending;
    const failed = new Set(state.failed);
    failed.delete(teamId);
    return { pending, failed };
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

function servingHostIds(
  leases: readonly HostLeaseSnapshot[],
): ReadonlySet<string> {
  return new Set(
    leases
      .filter(
        (lease) => lease.status === "ready" || lease.status === "degraded",
      )
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

interface Look {
  readonly listed: ReadonlyMap<string, string>;
  readonly serving: ReadonlySet<string>;
  readonly claimedDoors: ReadonlySet<string>;
}

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

function askFailedReads(
  queryClient: QueryClient,
  era: ClaimReadEra,
  teams: ReadonlyMap<string, NoticeTeam>,
): void {
  const state = useClaimReadsStore.getState();
  if (!sameEra(state.era, era) || state.failed.size === 0) return;
  askReads(queryClient, era, teamsNamed(teams, state.failed), false);
}

/**
 * Each team has one entry, which a claimed computer's cover reads too: a trigger
 * never cancels a read there, and only the read it asked for settles its team.
 */
export function useClaimedComputerNotice(): void {
  const auth = useHostBinding()?.auth ?? null;
  const queryClient = useQueryClient();
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

  useEffect(() => {
    beginEra(era);
  }, [era]);

  useEffect(() => {
    if (era === null || teams === null) return;
    if (useClaimReadsStore.getState().signInAsked) return;
    askReads(queryClient, era, teamsNamed(teams, teams.keys()), true);
  }, [era, queryClient, teams]);

  useEffect(() => {
    if (era === null || teams === null || pending === null) return;
    for (const [teamId, ask] of Object.entries(pending)) {
      if (!teams.has(teamId)) settleRead(era, teamId, ask);
    }
  }, [era, pending, teams]);

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
      queryClient,
      era,
      teamsNamed(
        teams,
        new Set([
          ...departedTeams(previous.listed, next.listed, teams),
          ...closedTeams(previous, next),
        ]),
      ),
      false,
    );
  }, [doorStates, era, leases, queryClient, registry, teams]);

  // A read that failed is read again when the list refreshes, even when the
  // refresh answers the same list, and on focus.
  const refreshedAt = registered.dataUpdatedAt;
  const lastRefresh = useRef(refreshedAt);
  useEffect(() => {
    if (lastRefresh.current === refreshedAt) return;
    lastRefresh.current = refreshedAt;
    if (era === null || teams === null) return;
    askFailedReads(queryClient, era, teams);
  }, [era, queryClient, refreshedAt, teams]);
  useEffect(() => {
    if (era === null || teams === null) return;
    return focusManager.subscribe((focused) => {
      if (focused) askFailedReads(queryClient, era, teams);
    });
  }, [era, queryClient, teams]);

  // This person's own claim: read its team so the record is settled.
  useEffect(() => {
    if (era === null || teams === null || ownClaims.length === 0) return;
    const teamIds = new Set<string>();
    for (const [teamId, team] of teams) {
      if (ownClaims.some((claim) => claim.environmentId === team.environmentId))
        teamIds.add(teamId);
    }
    askReads(queryClient, era, teamsNamed(teams, teamIds), false);
  }, [era, ownClaims, queryClient, teams]);
}

function tellClaims(
  viewerUserId: string,
  target: AskedTeam,
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
