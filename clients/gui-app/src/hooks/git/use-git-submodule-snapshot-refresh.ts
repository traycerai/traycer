import { useCallback } from "react";
import { queryOptions, useQueryClient } from "@tanstack/react-query";
import { withHostRpcErrorBoundary } from "@traycer-clients/shared/host-transport/host-messenger";
import type { GitListChangedFilesResponseV11 } from "@traycer/protocol/host";
import { useHostClientFor } from "@/hooks/host/use-host-client-for";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import { gitQueryKeys } from "@/lib/query-keys/git-query-keys";
import { createRichSlotRequest } from "@/lib/git/git-rich-slot-ordering";

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
}): () => Promise<void> {
  const queryClient = useQueryClient();
  const entry = useHostDirectoryEntry(args.hostId ?? "");
  const client = useHostClientFor(entry);

  const hostId = args.hostId;
  const rootRunningDir = args.rootRunningDir;
  const ignoreWhitespace = args.ignoreWhitespace;

  return useCallback(async () => {
    if (client === null || hostId === null || rootRunningDir === null) {
      return;
    }
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
      withHostRpcErrorBoundary("git.listChangedFiles", () =>
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
    // Failures land in the query's error state (surfaced by the passive
    // hook); the refresh affordance itself just stops spinning.
    await queryClient
      .fetchQuery(
        queryOptions({
          queryKey,
          queryFn: request,
          staleTime: 0,
        }),
      )
      .catch(() => undefined);
  }, [client, hostId, ignoreWhitespace, queryClient, rootRunningDir]);
}
