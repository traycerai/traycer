import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import {
  CancelledError,
  queryOptions,
  useQueries,
  useQueryClient,
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
 * What one stored `host_claimed` state has read: the teams whose claims it
 * started, answered and failed, and the consumers to tell when one answers. A
 * state raised again is a new object and reads every team again; the same
 * state, remounted, reads nothing more.
 */
interface StateReads {
  readonly started: Set<string>;
  readonly finished: Set<string>;
  readonly failed: Set<string>;
  readonly listeners: Set<() => void>;
  version: number;
}

const readsByState = new WeakMap<HostDoorState, StateReads>();

function readsOf(state: HostDoorState): StateReads {
  const known = readsByState.get(state);
  if (known !== undefined) return known;
  const reads: StateReads = {
    started: new Set(),
    finished: new Set(),
    failed: new Set(),
    listeners: new Set(),
    version: 0,
  };
  readsByState.set(state, reads);
  return reads;
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

/** Records a team's answer for the state and re-renders every consumer of it. */
function markFinished(reads: StateReads, environmentId: string): void {
  reads.finished.add(environmentId);
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
 * `host_claimed`, or `null` until a claim for it is read. Each team the person
 * belongs to has its claims read once per state, through
 * `AuthService.listClaimedComputers`, into that team's own entry
 * (`authQueryKeys.claimedComputers`), kept for the account. Only answers read
 * under this state count, and the newest claim naming this computer across
 * them gives the claimant; the team's name is that team's. The reads end with
 * the state.
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
  // Re-renders when any read of this state answers, whichever consumer of
  // the state started it.
  const subscribe = useCallback(
    (listener: () => void) => {
      if (claimedState === null) return () => undefined;
      const listeners = readsOf(claimedState).listeners;
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    [claimedState],
  );
  useSyncExternalStore(subscribe, () =>
    claimedState === null ? 0 : readsOf(claimedState).version,
  );
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
    if (claimedState === null || auth === null || userId === null) return;
    const reads = readsOf(claimedState);
    for (const team of teams) {
      const environmentId = team.environmentId;
      if (reads.finished.has(environmentId) || reads.failed.has(environmentId))
        continue;
      const options = claimedComputersOptions(auth, userId, environmentId);
      const inFlight =
        queryClient.isFetching({ queryKey: options.queryKey, exact: true }) > 0;
      // Started under this state and still answering: nothing to do. A read
      // a remount cancelled is started again; one that failed is not.
      if (reads.started.has(environmentId) && inFlight) continue;
      // A read in flight from before this state answers for that state, not
      // this one: it is cancelled and read again.
      const first = !reads.started.has(environmentId);
      reads.started.add(environmentId);
      void (
        first && inFlight
          ? queryClient.cancelQueries({
              queryKey: options.queryKey,
              exact: true,
            })
          : Promise.resolve()
      )
        .then(() => queryClient.fetchQuery({ ...options, staleTime: 0 }))
        .then(
          () => {
            if (isCurrentDoorState(claimedState))
              markFinished(reads, environmentId);
          },
          (error: unknown) => {
            if (!(error instanceof CancelledError))
              reads.failed.add(environmentId);
          },
        );
    }
    return () => {
      // An unmount or remount keeps the state's reads; a state the store no
      // longer holds ends them.
      if (isCurrentDoorState(claimedState)) return;
      for (const environmentId of reads.started) {
        if (
          reads.finished.has(environmentId) ||
          reads.failed.has(environmentId)
        )
          continue;
        void queryClient.cancelQueries({
          queryKey: authQueryKeys.claimedComputers(auth, userId, environmentId),
          exact: true,
        });
      }
    };
  }, [auth, claimedState, queryClient, teams, userId]);

  if (claimedState === null) return null;
  const finished = readsOf(claimedState).finished;
  return newestClaim(
    claimedState.hostId,
    teams.map((team, index) => ({
      teamName: team.label,
      result: finished.has(team.environmentId)
        ? answers[index]?.data
        : undefined,
    })),
  );
}
