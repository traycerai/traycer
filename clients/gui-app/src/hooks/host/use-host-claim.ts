import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import {
  CancelledError,
  queryOptions,
  useQueries,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import type { ClaimedComputersResult } from "@traycer-clients/shared/auth/claimed-computers";
import type { HostDoorState } from "@traycer-clients/shared/host-transport/host-door-state";
import { useEnvironmentListQuery } from "@/hooks/bots/use-environment-list-query";
import type { AuthService } from "@/lib/auth/auth-service";
import { useHostBinding, useOptionalHostClient } from "@/lib/host";
import type { HostClaimFacts } from "@/lib/host/window-narration";
import { authQueryKeys } from "@/lib/query-keys";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useHostDoorStateStore } from "@/stores/host/host-door-state-store";

/**
 * What one stored `host_claimed` state has read for one account: the teams
 * whose read is pending, answered or failed, and the consumers to tell when
 * one settles. A state raised again is a new object and reads every team
 * again; the same state, remounted, reads nothing more; another account reads
 * its own.
 */
interface StateReads {
  readonly pending: Set<string>;
  readonly finished: Set<string>;
  readonly failed: Set<string>;
  readonly listeners: Set<() => void>;
  version: number;
}

const readsByState = new WeakMap<
  HostDoorState,
  WeakMap<AuthService, Map<string, StateReads>>
>();

function readsOf(
  state: HostDoorState,
  auth: AuthService,
  userId: string,
): StateReads {
  let byAuth = readsByState.get(state);
  if (byAuth === undefined) {
    byAuth = new WeakMap();
    readsByState.set(state, byAuth);
  }
  let byUser = byAuth.get(auth);
  if (byUser === undefined) {
    byUser = new Map();
    byAuth.set(auth, byUser);
  }
  const known = byUser.get(userId);
  if (known !== undefined) return known;
  const reads: StateReads = {
    pending: new Set(),
    finished: new Set(),
    failed: new Set(),
    listeners: new Set(),
    version: 0,
  };
  byUser.set(userId, reads);
  return reads;
}

/**
 * The live states on each team entry's read in flight, by the entry's query.
 * A state's end cancels the read only when no other state is on it.
 */
const statesOnRead = new WeakMap<object, Set<StateReads>>();

function joinRead(query: object, reads: StateReads): void {
  let states = statesOnRead.get(query);
  if (states === undefined) {
    states = new Set();
    statesOnRead.set(query, states);
  }
  states.add(reads);
}

function leaveRead(query: object, reads: StateReads): void {
  statesOnRead.get(query)?.delete(reads);
}

/** Whether `reads` is the only state on `query`'s read in flight. */
function aloneOnRead(query: object, reads: StateReads): boolean {
  const states = statesOnRead.get(query);
  return states !== undefined && states.size === 1 && states.has(reads);
}

/**
 * One team's claims entry, kept for the account. A read cancelled with the
 * state that started it is reverted, so nothing it saw is kept.
 */
function claimedComputersOptions(
  auth: AuthService | null,
  userId: string | null,
  environmentId: string,
) {
  return queryOptions({
    queryKey: authQueryKeys.claimedComputers(auth, userId, environmentId),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
    retry: false,
    queryFn: ({ signal }): Promise<ClaimedComputersResult> =>
      auth === null
        ? Promise.resolve({ kind: "unauthorized" })
        : auth.listClaimedComputers(environmentId, signal),
  });
}

/** Resolves once no read of `queryKey` is in flight. */
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
 * Reads one team's entry for a state: `true` once a read the state may count
 * has answered, `false` if the state ended first; a throw otherwise. A read
 * already in flight when the state asks may predate its claim, so the state
 * waits for it and reads after it, never cancelling it. A read begun once the
 * state has asked counts for every state on it, and only its answer does:
 * a cancelled read that hands back the entry's earlier data is not one. A read
 * another reader replaced (a refetch of the entry) is followed to its
 * replacement.
 */
/** Whose read of a team's entry this is: a state, for one account. */
interface TeamReadTarget {
  readonly queryClient: QueryClient;
  readonly auth: AuthService;
  readonly userId: string;
  readonly reads: StateReads;
  readonly state: HostDoorState;
}

async function readTeamForState(
  target: TeamReadTarget,
  environmentId: string,
): Promise<boolean> {
  const { queryClient, reads } = target;
  const isLive = (): boolean => isCurrentDoorState(target.state);
  const options = claimedComputersOptions(
    target.auth,
    target.userId,
    environmentId,
  );
  const exact = { queryKey: options.queryKey, exact: true };
  const query = queryClient.getQueryCache().build(queryClient, options);
  if (queryClient.isFetching(exact) > 0)
    await untilNoReadInFlight(queryClient, options.queryKey);
  for (;;) {
    if (!isLive()) return false;
    joinRead(query, reads);
    try {
      const answersBefore = query.state.dataUpdateCount;
      await queryClient.fetchQuery({ ...options, staleTime: 0 });
      // A cancel that reverts hands back the data held before, and the count
      // with it: only an answer that landed during this read counts.
      if (query.state.dataUpdateCount > answersBefore) return isLive();
      if (queryClient.isFetching(exact) === 0) throw new CancelledError();
    } catch (error) {
      // Cancelled with a replacement in flight: that read began after this
      // state asked, so it is followed.
      if (
        !(error instanceof CancelledError) ||
        queryClient.isFetching(exact) === 0
      )
        throw error;
    } finally {
      leaveRead(query, reads);
    }
  }
}

/**
 * Starts the state's read of one team, unless one is pending or settled. A
 * read cancelled with no replacement (every consumer unmounted, or the state
 * ended) is started again while the state is current and still has a
 * consumer: a remount that cancelled it may have run its effect first.
 */
function startTeamRead(target: TeamReadTarget, environmentId: string): void {
  const { reads } = target;
  if (
    reads.pending.has(environmentId) ||
    reads.finished.has(environmentId) ||
    reads.failed.has(environmentId)
  )
    return;
  reads.pending.add(environmentId);
  const isLive = (): boolean => isCurrentDoorState(target.state);
  void readTeamForState(target, environmentId).then(
    (answered) => {
      if (answered) settle(reads, "finished", environmentId);
      else reads.pending.delete(environmentId);
    },
    (error: unknown) => {
      if (!(error instanceof CancelledError)) {
        settle(reads, "failed", environmentId);
        return;
      }
      reads.pending.delete(environmentId);
      if (isLive() && reads.listeners.size > 0)
        startTeamRead(target, environmentId);
    },
  );
}

/** Records a team's read as settled for the state and re-renders every consumer of it. */
function settle(
  reads: StateReads,
  outcome: "finished" | "failed",
  environmentId: string,
): void {
  reads.pending.delete(environmentId);
  reads[outcome].add(environmentId);
  reads.version += 1;
  for (const listener of reads.listeners) listener();
}

/** Whether the store still holds `state` for its host. */
function isCurrentDoorState(state: HostDoorState): boolean {
  return useHostDoorStateStore.getState().byHost.get(state.hostId) === state;
}

/** The newest claim naming `hostId` across the teams' answers, by `claimedAt`. */
function newestClaim(
  hostId: string,
  answers: ReadonlyArray<{
    readonly teamName: string;
    readonly result: ClaimedComputersResult | undefined;
  }>,
): HostClaimFacts | null {
  let newest: (HostClaimFacts & { readonly at: number }) | null = null;
  for (const { teamName, result } of answers) {
    if (result?.kind !== "ok") continue;
    for (const claim of result.claims) {
      if (claim.hostId !== hostId) continue;
      const at = Date.parse(claim.claimedAt);
      if (newest === null || at > newest.at)
        newest = { claimantName: claim.claimantName, teamName, at };
    }
  }
  return newest === null
    ? null
    : { claimantName: newest.claimantName, teamName: newest.teamName };
}

/**
 * Who claimed `hostId` and from which team, while its door answers
 * `host_claimed`, or `null` until every team's claims are read. Each team the
 * person belongs to has its claims read once per state, through
 * `AuthService.listClaimedComputers`, into that team's own entry
 * (`authQueryKeys.claimedComputers`), kept for the account and shared with
 * the team's screens. Once every team's read under this state has answered or
 * failed, the newest claim naming this computer across the answers gives the
 * claimant, from the entry as it now stands; the team's name is that team's.
 * A state's end cancels a read no other state is on.
 */
export function useHostClaim(
  hostId: string | null,
  doorState: HostDoorState | null,
): HostClaimFacts | null {
  const claimedState =
    hostId !== null &&
    doorState !== null &&
    doorState.kind === "host-claimed" &&
    doorState.hostId === hostId
      ? doorState
      : null;
  const claimed = claimedState !== null;
  const binding = useHostBinding();
  const auth = binding?.auth ?? null;
  const userId = useAuthStore((state) => state.contextMetadata?.userId ?? null);
  const queryClient = useQueryClient();
  const reads =
    claimedState === null || auth === null || userId === null
      ? null
      : readsOf(claimedState, auth, userId);
  // Re-renders when any read of this state settles, whichever consumer of
  // the state started it.
  const subscribe = useCallback(
    (listener: () => void) => {
      if (reads === null) return () => undefined;
      reads.listeners.add(listener);
      return () => {
        reads.listeners.delete(listener);
      };
    },
    [reads],
  );
  useSyncExternalStore(subscribe, () => reads?.version ?? 0);
  // The null-tolerant read: the window's narration mounts at the app root,
  // where a tree with no host runtime is a legitimate answer.
  const environments = useEnvironmentListQuery(
    useOptionalHostClient(),
    claimed,
  );
  const teams = useMemo(
    () =>
      (environments.data?.environments ?? []).filter(
        (environment) => environment.ownerKind === "organization",
      ),
    [environments.data],
  );
  const answers = useQueries({
    queries: teams.map((team) => ({
      ...claimedComputersOptions(auth, userId, team.environmentId),
      // Read only by the state's own read below, never on mount.
      enabled: false,
    })),
  });

  useEffect(() => {
    if (
      claimedState === null ||
      reads === null ||
      auth === null ||
      userId === null
    )
      return;
    const target: TeamReadTarget = {
      queryClient,
      auth,
      userId,
      reads,
      state: claimedState,
    };
    for (const team of teams) startTeamRead(target, team.environmentId);
    return () => {
      // An unmount or remount keeps the state's reads; a state the store no
      // longer holds ends them, but not a read another state or a team
      // screen still needs.
      if (isCurrentDoorState(claimedState)) return;
      for (const environmentId of reads.pending) {
        const queryKey = authQueryKeys.claimedComputers(
          auth,
          userId,
          environmentId,
        );
        const query = queryClient
          .getQueryCache()
          .find({ queryKey, exact: true });
        if (
          query !== undefined &&
          aloneOnRead(query, reads) &&
          !query.isActive()
        )
          void queryClient.cancelQueries({ queryKey, exact: true });
      }
    };
  }, [auth, claimedState, queryClient, reads, teams, userId]);

  if (claimedState === null || reads === null) return null;
  // Today's cover until every team's read under this state has settled.
  const settled = teams.every(
    (team) =>
      reads.finished.has(team.environmentId) ||
      reads.failed.has(team.environmentId),
  );
  if (!settled) return null;
  return newestClaim(
    claimedState.hostId,
    teams.map((team, index) => ({
      teamName: team.label,
      result: reads.finished.has(team.environmentId)
        ? answers[index]?.data
        : undefined,
    })),
  );
}
