import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import {
  CancelledError,
  queryOptions,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { withHostQueryErrorBoundary } from "@/lib/query/host-query-error-boundary";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { GitListChangedFilesResponseV11 } from "@traycer/protocol/host";
import { hostClientUnavailableError } from "@/hooks/host/use-host-query";
import { useHostClientFor } from "@/hooks/host/use-host-client-for";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import { stampHostRpcMethod } from "@/lib/host-rpc-policy/host-method-policy-table";
import { gitQueryKeys } from "@/lib/query-keys/git-query-keys";
import { getConditionPollEpisodeCoordinator } from "@/lib/query/condition-poll-episode-coordinator";
import {
  bumpRichSlotOwnershipEpoch,
  createRichSlotRequest,
  richSlotLastWriter,
  richSlotOrderingKey,
} from "@/lib/git/git-rich-slot-ordering";
import { useWsStreamClient } from "@/lib/host/stream-runtime-context";

export interface GitListChangedFilesWithSubmodulesResult {
  readonly data: GitListChangedFilesResponseV11 | null;
  readonly isPending: boolean;
  readonly error: HostRpcError | null;
}

export function hasDirtySubmodulesForRefresh(
  data: GitListChangedFilesResponseV11 | undefined,
): boolean {
  return (
    data !== undefined &&
    data.submodules.some((submodule) => {
      if (submodule.availability.state === "unavailable") return true;
      if (submodule.files.length > 0) return true;
      if (submodule.pointer.kind === "conflicted") return true;
      return (
        submodule.pointer.commitChanged ||
        submodule.pointer.modifiedContent ||
        submodule.pointer.untrackedContent
      );
    })
  );
}

interface ChangeTokenIdentity {
  readonly hostId: string | null;
  readonly runningDir: string | null;
  readonly ignoreWhitespace: boolean;
  readonly token: string | null;
}

/**
 * Ownership/client transition handling for the rich slot. The epoch bump
 * invalidates every in-flight unary fetch's ordering capture (cheap defense
 * against a superseded transport's late response); the direction-specific
 * work is:
 *   -> stream:   cancel in-flight unary fetches (the stream delivers its
 *                own snapshot immediately on subscribe);
 *   -> fallback: force a refetch - the stream-fed value is `Infinity`-stale
 *                and, when clean, the dirty timer is off, so nothing else
 *                would ever refresh it.
 */
function useRichSlotOwnershipTransitions(opts: {
  readonly observing: boolean;
  readonly streamOwnsRichSlot: boolean;
  readonly wsStreamClient: unknown;
  readonly hostId: string | null;
  readonly runningDir: string | null;
  readonly ignoreWhitespace: boolean;
  readonly queryClient: QueryClient;
  readonly refetch: () => Promise<unknown>;
  /**
   * The changeToken memory shared with the token effect (a stable ref).
   * Every recovery refetch issued here CLEARS it: the fresh fetch already
   * covers any token delta accumulated during a blind window, and the token
   * effect runs later in the same commit - without the clear, overlapping
   * recovery reasons (ownership flip AND token advance while unobserved)
   * would issue a second full submodule fan-out.
   */
  readonly lastTokenRef: { current: ChangeTokenIdentity | null };
}): void {
  const {
    observing,
    streamOwnsRichSlot,
    wsStreamClient,
    hostId,
    runningDir,
    ignoreWhitespace,
    queryClient,
    refetch,
    lastTokenRef,
  } = opts;
  const transitionRef = useRef<{
    streamOwnsRichSlot: boolean;
    wsStreamClient: unknown;
    slotKey: string;
  } | null>(null);
  useEffect(() => {
    // The observing check runs FIRST - before the id-null narrowing guard -
    // because null ids ARE a not-observing state: an A→null→A identity
    // round-trip must also reset the transition memory, or stale memory
    // would bypass the first-observation repair below.
    if (!observing) {
      // Not actively observing (caller disabled, host client absent/not
      // ready, ids null): perform NO fetch work - an explicit `refetch()`
      // bypasses the query's `enabled` gate and would fire a premature RPC.
      // Reset the transition memory too: ownership can flip while
      // unobserved, so re-observation must replay the first-observation
      // provenance check below instead of comparing against a stale
      // snapshot.
      transitionRef.current = null;
      return;
    }
    // Unreachable when observing (which requires both ids non-null); this
    // narrows the types for the calls below.
    if (hostId === null || runningDir === null) return;
    const slotKey = richSlotOrderingKey({
      hostId,
      runningDir,
      ignoreWhitespace,
    });
    const previous = transitionRef.current;
    transitionRef.current = { streamOwnsRichSlot, wsStreamClient, slotKey };
    if (previous === null || previous.slotKey !== slotKey) {
      // First observation of THIS slot - a fresh mount, or a same-mount
      // selection switch to a different root. Either way, an ownership flip
      // that happened while this slot wasn't under observation is invisible
      // to the previous/current comparison. If the slot holds an
      // `Infinity`-fresh cache value in fallback ownership whose last writer
      // was NOT an accepted unary response (stream-fed - or unknown, after
      // the ordering entry was LRU-evicted), nothing else would ever refresh
      // it (no fetch over fresh data; a clean repo keeps the dirty timer
      // off) - treat it as a →fallback transition. An EMPTY slot needs
      // nothing: the enabled query performs its own initial fetch.
      if (
        !streamOwnsRichSlot &&
        queryClient.getQueryData(
          gitQueryKeys.listChangedFilesWithSubmodules(
            hostId,
            runningDir,
            ignoreWhitespace,
          ),
        ) !== undefined &&
        richSlotLastWriter(slotKey) !== "unary"
      ) {
        bumpRichSlotOwnershipEpoch(slotKey);
        // This fetch already covers any token delta from the blind window -
        // clear the token memory so the token effect (later this commit)
        // doesn't cancel-and-restart it into a second fan-out.
        lastTokenRef.current = null;
        void refetch();
      }
      return;
    }
    const ownershipChanged = previous.streamOwnsRichSlot !== streamOwnsRichSlot;
    const clientChanged = previous.wsStreamClient !== wsStreamClient;
    if (!ownershipChanged && !clientChanged) return;
    bumpRichSlotOwnershipEpoch(slotKey);
    if (!ownershipChanged) return;
    if (streamOwnsRichSlot) {
      const queryKey = gitQueryKeys.listChangedFilesWithSubmodules(
        hostId,
        runningDir,
        ignoreWhitespace,
      );
      // `revert: false`: this key is shared with the stream writer, and
      // `cancelQueries`'s default revert:true restores the cache to its
      // pre-fetch snapshot - which would wipe a newer stream frame that
      // landed (via a direct `setQueryData`) WHILE the now-superseded unary
      // fetch was still in flight. But TanStack's non-revert cancel path
      // dispatches an 'error' state that ALSO marks the query invalidated -
      // which would make React Query auto-refetch this (now stream-owned,
      // disabled) query the next time it re-enables, duplicating this hook's
      // own explicit refetch in the fallback branch below. Re-stamp the
      // CURRENT (untouched) cache value through `setQueryData` once the
      // cancel settles - a 'success' dispatch, so it clears the invalidated
      // flag without altering the data.
      void queryClient
        .cancelQueries({ queryKey }, { revert: false })
        .then(() => {
          const current = queryClient.getQueryData(queryKey);
          if (current !== undefined) {
            queryClient.setQueryData(queryKey, current);
          }
        });
    } else {
      // Same coalescing rule as the first-observation branch above.
      lastTokenRef.current = null;
      void refetch();
    }
  }, [
    observing,
    streamOwnsRichSlot,
    wsStreamClient,
    hostId,
    runningDir,
    ignoreWhitespace,
    queryClient,
    refetch,
    lastTokenRef,
  ]);
}

/**
 * Reactive read of whether the `git.subscribeStatus` stream owns the rich
 * slot: negotiated minor >= 1 on major 1. `null`/unknown/minor-0 all mean the
 * unary+timer pair owns it (today's behavior verbatim). Tracked through
 * `subscribeMethodSupport` so a handshake settling (or a host swap changing
 * the negotiated version) re-renders consumers.
 */
function useStreamOwnsRichSlot(): boolean {
  const wsStreamClient = useWsStreamClient();
  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      wsStreamClient === null
        ? () => undefined
        : wsStreamClient.subscribeMethodSupport(onStoreChange),
    [wsStreamClient],
  );
  const getSnapshot = useCallback(() => {
    const version =
      wsStreamClient?.getMethodSchemaVersion("git.subscribeStatus") ?? null;
    return version !== null && version.major === 1 && version.minor >= 1;
  }, [wsStreamClient]);
  return useSyncExternalStore(subscribe, getSnapshot);
}

/**
 * Source of truth for the selected root repo's nested changes: the
 * host-composed nested snapshot (parent changeset + `submodules[]`) in a
 * single epoch. OWNERSHIP of this slot is exclusive per the negotiated
 * `git.subscribeStatus` version:
 *
 * - minor >= 1 (STREAM ownership): rich stream frames feed the slot (see
 *   `use-git-list-changed-files-subscription.ts`); this unary query is
 *   DISABLED - no automatic or initial fetch, no dirty timer, no changeToken
 *   refetch. Manual refresh stays a unary fetch but goes through the
 *   generation-aware request so a stale response can never clobber a newer
 *   stream write.
 * - minor 0 / null / unknown (FALLBACK): today's behavior verbatim - unary
 *   fetch, `changeToken` refetch, bounded dirty timer. Stream frames never
 *   write the rich slot in this state.
 *
 * Transitions: -> stream cancels any in-flight pre-transition unary fetch and
 * bumps the slot's ownership epoch; -> fallback forces an immediate unary
 * refetch (a stream-fed `staleTime: Infinity` value would otherwise never
 * refresh - especially a clean one, with the dirty timer off).
 *
 * CAPABILITY BOUND (graceful degradation): against a host that negotiates
 * unary `listChangedFiles@1.0` (pre-host-v1.1.4 line), the fallback fetch
 * necessarily yields `submodules: []` - the dispatcher's v1.0->v1.1 upgrade
 * fabricates the empty nested view. The timer cannot recreate data the host
 * can't produce; the panel simply shows the parent-only view.
 *
 * Git panels are **worktree-scoped**, so the RPC must hit the selected
 * worktree's host, not the app-wide active host - `hostId` in the request
 * body does not route the call (`HostClient.request()` sends through the
 * bound messenger). The client is resolved via `useHostClientFor` for
 * `args.hostId`, and readiness is derived from *that* client.
 *
 * Rolls a bespoke `useQuery` against `client.request` (rather than
 * `useHostQuery`) so `client` stays out of the cache key - it is transport
 * identity, not data identity - mirroring the subscription/refresh pair that
 * co-own the v1.0 slot.
 */
export function useGitListChangedFilesWithSubmodules(args: {
  readonly hostId: string | null;
  readonly runningDir: string | null;
  readonly ignoreWhitespace: boolean;
  readonly enabled: boolean;
  readonly changeToken: string | null;
}): GitListChangedFilesWithSubmodulesResult {
  const entry = useHostDirectoryEntry(args.hostId ?? "");
  const client = useHostClientFor(entry);
  const readiness = useReactiveHostReadiness(client);
  const queryClient = useQueryClient();
  const conditionPollCoordinator =
    getConditionPollEpisodeCoordinator(queryClient);
  const wsStreamClient = useWsStreamClient();
  const streamOwnsRichSlot = useStreamOwnsRichSlot();

  const hostId = args.hostId;
  const runningDir = args.runningDir;
  const ignoreWhitespace = args.ignoreWhitespace;

  // "Observing" = the caller wants data AND the transport can serve it. This
  // gates every explicit fetch this hook may fire (ownership-transition
  // refetches bypass TanStack's `enabled`), independent of who owns the slot.
  const observing =
    args.enabled &&
    client !== null &&
    readiness.isReady &&
    hostId !== null &&
    runningDir !== null;
  // Under stream ownership the unary query is fully disabled: no automatic
  // or initial fetch, and the bounded dirty timer never runs.
  const enabled = observing && !streamOwnsRichSlot;

  // Named request closure (mirrors `useHostQuery`) so `client` stays out of
  // the cache key: it is transport identity, not data identity. Wrapped in
  // the generation-aware rich-slot request: a response that raced a newer
  // stream write (ownership flipping mid-flight) is dropped, not written.
  const richSlotRequest = createRichSlotRequest({
    queryClient,
    hostId,
    runningDir: runningDir ?? "",
    ignoreWhitespace,
    request: async (): Promise<GitListChangedFilesResponseV11> => {
      if (client === null || hostId === null || runningDir === null) {
        // A `HostRpcError` (not a bare Error): consuming hooks publicly
        // declare that error type and UI surfaces read `.code`.
        return Promise.reject(
          hostClientUnavailableError("git.listChangedFiles"),
        );
      }
      return client.request("git.listChangedFiles", {
        hostId,
        runningDir,
        ignoreWhitespace,
        includeSubmodules: true,
      });
    },
  });
  // Boundary-wrapped: the rich-slot wrapper's own throws are already
  // `HostRpcError`s, but the declared error generic must also survive bugs in
  // the request/arbitration path itself. Stays a NAMED queryFn so `client`
  // (transport identity, not data identity) remains out of the cache key.
  const request = (context: {
    readonly signal: AbortSignal;
  }): Promise<GitListChangedFilesResponseV11> =>
    withHostQueryErrorBoundary("git.listChangedFiles", () =>
      richSlotRequest(context),
    );

  const query = useQuery(
    queryOptions<
      GitListChangedFilesResponseV11,
      HostRpcError,
      GitListChangedFilesResponseV11
    >({
      queryKey: gitQueryKeys.listChangedFilesWithSubmodules(
        hostId,
        runningDir ?? "",
        ignoreWhitespace,
      ),
      queryFn: request,
      meta: stampHostRpcMethod(undefined, "git.listChangedFiles"),
      retry: false,
      enabled,
      staleTime: Infinity,
      refetchOnWindowFocus: false,
      // Fallback-only: inactive whenever the query is disabled (stream
      // ownership), so the table-derived dirty-submodule timer runs only in
      // the fallback state.
      refetchInterval: conditionPollCoordinator.refetchIntervalFor(
        "git.listChangedFiles",
      ),
    }),
  );

  const { refetch } = query;
  // Shared with the ownership-transition effect: its recovery refetches clear
  // this so the token effect below (which runs later in the same commit)
  // cannot double-fetch on a token delta the recovery already covers.
  const lastTokenRef = useRef<ChangeTokenIdentity | null>(null);
  useRichSlotOwnershipTransitions({
    observing,
    streamOwnsRichSlot,
    wsStreamClient,
    hostId,
    runningDir,
    ignoreWhitespace,
    queryClient,
    refetch,
    lastTokenRef,
  });

  // TanStack's non-reverting cancellation publishes its internal
  // `CancelledError` into the query state. That cancellation is expected
  // control flow during the fallback -> stream ownership handoff, not a host
  // failure: the first rich stream frame will fill this same slot. Keep the
  // public result inside its `HostRpcError | null` contract and let consumers
  // render their loading state while that frame is still in flight.
  const error = query.error instanceof CancelledError ? null : query.error;

  // Refetch when the parent subscription reports a change (FALLBACK state
  // only - `enabled` is false under stream ownership). The ref stores the
  // full source identity alongside the token so a host/worktree/whitespace
  // change resets it (the new key mounts its own fetch), and only a genuine
  // token change on the *same* source forces a refetch - never the first
  // settled value.
  useEffect(() => {
    // Record the token only while OBSERVING. Under stream ownership (still
    // observing, query disabled) recording prevents a →fallback handoff from
    // comparing against a pre-stream token, seeing a "change", and launching
    // a second full fan-out right after the ownership effect's forced
    // refetch. While NOT observing (caller disabled, host not ready, ids
    // null), recording must PAUSE: swallowing a token advance during a blind
    // window would make re-observation compare new===new and skip the
    // refetch that window requires (the Infinity-fresh unary-provenance
    // cache passes every other check).
    if (!observing) return;
    const previous = lastTokenRef.current;
    lastTokenRef.current = {
      hostId,
      runningDir,
      ignoreWhitespace,
      token: args.changeToken,
    };
    if (!enabled) return;
    const sameSource =
      previous !== null &&
      previous.hostId === hostId &&
      previous.runningDir === runningDir &&
      previous.ignoreWhitespace === ignoreWhitespace;
    if (!sameSource) return;
    if (args.changeToken === null) return;
    if (previous.token === args.changeToken) return;
    void refetch();
  }, [
    args.changeToken,
    observing,
    enabled,
    hostId,
    runningDir,
    ignoreWhitespace,
    refetch,
  ]);

  return {
    data: query.data ?? null,
    isPending: computeNestedSnapshotPending({
      unaryEnabled: enabled,
      streamOwnsRichSlot,
      requested: args.enabled,
      hostId,
      runningDir,
      hasData: query.data !== undefined,
      hasError: error !== null,
    }),
    error,
  };
}

/**
 * Pending: no settled data and no error, while a fill is actually expected -
 * from the enabled unary query (fallback) or from the first rich stream
 * frame (stream ownership; the disabled query still reflects cache writes).
 */
function computeNestedSnapshotPending(opts: {
  readonly unaryEnabled: boolean;
  readonly streamOwnsRichSlot: boolean;
  readonly requested: boolean;
  readonly hostId: string | null;
  readonly runningDir: string | null;
  readonly hasData: boolean;
  readonly hasError: boolean;
}): boolean {
  const awaitingFirstValue = !opts.hasData && !opts.hasError;
  const awaitingStreamFill =
    opts.streamOwnsRichSlot &&
    opts.requested &&
    opts.hostId !== null &&
    opts.runningDir !== null;
  return (opts.unaryEnabled || awaitingStreamFill) && awaitingFirstValue;
}
