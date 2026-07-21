import { useCallback, useMemo } from "react";
import { queryOptions, useQueryClient } from "@tanstack/react-query";
import { withHostQueryErrorBoundary } from "@/lib/query/host-query-error-boundary";
import type { GitListChangedFilesResponseV11 } from "@traycer/protocol/host";
import { useHostClientFor } from "@/hooks/host/use-host-client-for";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import { stampHostRpcMethod } from "@/lib/host-rpc-policy/host-method-policy-table";
import { gitQueryKeys } from "@/lib/query-keys/git-query-keys";
import { getConditionPollEpisodeCoordinator } from "@/lib/query/condition-poll-episode-coordinator";
import { createRichSlotRequest } from "@/lib/git/git-rich-slot-ordering";
import { useWsStreamClient } from "@/lib/host/stream-runtime-context";
import {
  refreshGitSubscriptionWithFreshNonce,
  useGitSubscriptionRefreshState,
} from "./use-git-list-changed-files-subscription";

export interface GitSubmoduleSnapshotRefreshResult {
  readonly refresh: () => Promise<void>;
  readonly isRefreshing: boolean;
}

/**
 * Manual refresh of the active root's nested snapshot slot (the panel's
 * source of truth for parent files + submodules). Shared by the panel toolbar
 * refresh and the reference-row refresh so both surfaces refresh the same
 * cache slot.
 *
 * This is an EXPLICIT generation-aware unary fetch, not `invalidateQueries`:
 * under stream ownership the passive unary query is DISABLED, and
 * invalidating a disabled query does not refetch it. The fetch works in both
 * ownership states (it also serves "I suspect the host is wedged"), and its
 * write is arbitrated by the rich-slot ordering - a response that raced a
 * newer stream write is dropped, never clobbering the stream-fed value.
 *
 * `staleTime: 0` is explicit and load-bearing: `fetchQuery` inherits the
 * QueryClient's global default (60s in this app), which would silently no-op
 * a manual refresh against `Infinity`-fresh stream-fed data.
 */
export function useGitSubmoduleSnapshotRefresh(args: {
  readonly hostId: string | null;
  readonly rootRunningDir: string | null;
  readonly ignoreWhitespace: boolean;
}): GitSubmoduleSnapshotRefreshResult {
  const queryClient = useQueryClient();
  const entry = useHostDirectoryEntry(args.hostId ?? "");
  const client = useHostClientFor(entry);
  const wsStreamClient = useWsStreamClient();

  const hostId = args.hostId;
  const rootRunningDir = args.rootRunningDir;
  const ignoreWhitespace = args.ignoreWhitespace;
  const isRefreshing = useGitSubscriptionRefreshState({
    wsStreamClient,
    hostId,
    runningDir: rootRunningDir,
    ignoreWhitespace,
  });

  const refresh = useCallback(async () => {
    if (client === null || hostId === null || rootRunningDir === null) {
      return;
    }
    // v1.2 guarantees a post-registration snapshot. Replacing the shared
    // stream session preserves its current cache data while the nonce frame is
    // pending; a second toolbar/body gesture joins this exact promise.
    const freshReplacement = refreshGitSubscriptionWithFreshNonce({
      wsStreamClient,
      queryClient,
      hostId,
      runningDir: rootRunningDir,
      ignoreWhitespace,
    });
    if (freshReplacement !== null) {
      await freshReplacement;
      return;
    }
    // Minor <=1 (or no active stream) retains the established unary fallback
    // and its rich-slot arbitration. It makes no freshness claim.
    const queryKey = gitQueryKeys.listChangedFilesWithSubmodules(
      hostId,
      rootRunningDir,
      ignoreWhitespace,
    );
    const richSlotRequest = createRichSlotRequest({
      queryClient,
      hostId,
      runningDir: rootRunningDir,
      ignoreWhitespace,
      request: (): Promise<GitListChangedFilesResponseV11> =>
        client.request("git.listChangedFiles", {
          hostId,
          runningDir: rootRunningDir,
          ignoreWhitespace,
          includeSubmodules: true,
        }),
    });
    // Boundary-wrapped: a rejection here lands in the SAME query slot the
    // passive hook publicly types as `HostRpcError`, so it must never carry a
    // foreign error shape to the panel's `.code`-reading error states.
    const request = (context: {
      readonly signal: AbortSignal;
    }): Promise<GitListChangedFilesResponseV11> =>
      withHostQueryErrorBoundary("git.listChangedFiles", () =>
        richSlotRequest(context),
      );
    // Cancel any fetch already in flight for this key first: `fetchQuery`
    // otherwise JOINS an existing in-flight promise instead of starting a
    // fresh request, so a click while an earlier fetch is hung would silently
    // await that same hung promise - defeating this refresh's documented
    // "I suspect the host is wedged" use case. `revert: false` for the same
    // stream-write-preservation reason as the ownership-transition cancel in
    // `useGitListChangedFilesWithSubmodules`.
    await queryClient.cancelQueries({ queryKey }, { revert: false });
    getConditionPollEpisodeCoordinator(queryClient).resetQueryByKey(queryKey);
    // Failures land in the query's error state (surfaced by the passive
    // hook); the refresh affordance itself just stops spinning.
    await queryClient
      .fetchQuery(
        queryOptions({
          queryKey,
          queryFn: request,
          meta: stampHostRpcMethod(undefined, "git.listChangedFiles"),
          retry: false,
          staleTime: 0,
        }),
      )
      .catch(() => undefined);
  }, [
    client,
    hostId,
    ignoreWhitespace,
    queryClient,
    rootRunningDir,
    wsStreamClient,
  ]);

  return useMemo(() => ({ refresh, isRefreshing }), [isRefreshing, refresh]);
}
