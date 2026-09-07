import { useEffect, useRef } from "react";
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
import { useGitSubscriptionOwnsRichSlot } from "./use-git-list-changed-files-subscription";

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
 * Epoch bump invalidates in-flight unary ordering. To stream: cancel unaries. To fallback: force refetch; the stream-fed value is Infinity-stale.
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
  /** Every recovery refetch issued here CLEARS it: the fresh fetch already covers any token delta accumulated during a blind window, and the token effect runs later in the same commit - without the clear, overlapping recovery reasons (ownership flip AND token advance while unobserved) would issue a second full submodule fan-out. */
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
    // The observing check runs FIRST - before the id-null narrowing guard - because null ids ARE a not-observing state: an A→null→A identity round-trip must also reset the transition memory, or stale memory would bypass the first-observation repair below.
    if (!observing) {
      // Reset the transition memory too: ownership can flip while unobserved, so re-observation must replay the first-observation provenance check below instead of comparing against a stale snapshot.
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
      // First observation of this slot: if fallback holds Infinity-fresh stream-fed (or unknown) data, treat as a to-fallback transition so something refreshes it.
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
      // Cancel with `revert: false` so a newer stream `setQueryData` is not wiped. Re-stamp the current cache after cancel to clear the invalidated flag without changing data.
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
 * Stream ownership of the rich slot is scoped to this hook's (hostId, runningDir, ignoreWhitespace), not the client-wide negotiated version.
 */
function useStreamOwnsRichSlot(args: {
  readonly hostId: string | null;
  readonly runningDir: string | null;
  readonly ignoreWhitespace: boolean;
}): boolean {
  const wsStreamClient = useWsStreamClient();
  return useGitSubscriptionOwnsRichSlot({
    wsStreamClient,
    hostId: args.hostId,
    runningDir: args.runningDir,
    ignoreWhitespace: args.ignoreWhitespace,
  });
}

/** Nested snapshot slot. */
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
  const streamOwnsRichSlot = useStreamOwnsRichSlot({
    hostId: args.hostId,
    runningDir: args.runningDir,
    ignoreWhitespace: args.ignoreWhitespace,
  });

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

  // Named request closure (mirrors `useHostQuery`) so `client` stays out of the cache key: it is transport identity, not data identity.
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
  // Boundary-wrapped: the rich-slot wrapper's own throws are already `HostRpcError`s, but the declared error generic must also survive bugs in the request/arbitration path itself.
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

  // That cancellation is expected control flow during the fallback -> stream ownership handoff, not a host failure: the first rich stream frame will fill this same slot.
  const error = query.error instanceof CancelledError ? null : query.error;

  // The ref stores the full source identity alongside the token so a host/worktree/whitespace change resets it (the new key mounts its own fetch), and only a genuine token change on the *same* source forces a refetch - never the first settled value.
  useEffect(() => {
    // While NOT observing (caller disabled, host not ready, ids null), recording must PAUSE: swallowing a token advance during a blind window would make re-observation compare new===new and skip the refetch that window requires (the Infinity-fresh unary-provenance cache passes every other check).
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

/** Pending: no settled data and no error, while a fill is actually expected - from the enabled unary query (fallback) or from the first rich stream frame (stream ownership; the disabled query still reflects cache writes). */
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
