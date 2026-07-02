import { queryOptions, useQuery } from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { GitListChangedFilesResponseV11 } from "@traycer/protocol/host";
import { useHostClientFor } from "@/hooks/host/use-host-client-for";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import { gitQueryKeys } from "@/lib/query-keys/git-query-keys";
import {
  SUBMODULE_BOUNDED_REFRESH_MS,
  hasDirtySubmodules,
} from "./use-git-list-changed-files-with-submodules";

export interface CurrentAheadSnapshotResult {
  readonly data: GitListChangedFilesResponseV11 | null;
  readonly isPending: boolean;
  readonly error: HostRpcError | null;
}

/**
 * Confirmed-current `git.listChangedFiles@1.1` snapshot for an ahead-of-pin diff
 * tile. There is no GUI capability probe, so an ahead-of-pin
 * `getFileDiff({ compareFromSha })` may only be issued from metadata that
 * reflects the CURRENT parent epoch - otherwise a persisted tile could re-issue a
 * diff against a pin that has since moved, and the transport would silently strip
 * `compareFromSha` for an old host and return a wrong stage-based diff (plan
 * §2.3).
 *
 * Unlike the panel's shared slot (`useGitListChangedFilesWithSubmodules`, which
 * is intentionally `staleTime: Infinity` and eventually-fresh), this query folds
 * the parent `changeToken` (the parent subscription fingerprint) INTO its cache
 * key. A previous-epoch snapshot therefore lives under a different key, so this
 * observer stays `data === null` (pending) until the current epoch's fetch lands
 * - "data present" means "fetched at the current parent epoch" by construction,
 * with no object-identity or fingerprint bookkeeping. It is disabled until the
 * parent fingerprint is known, so it can never fetch at an unknown epoch, and a
 * bounded timer keeps it fresh while the submodule is dirty (inner commits move
 * HEAD without moving the parent token).
 *
 * Worktree-scoped like the panel: the client is resolved via `useHostClientFor`
 * for `args.hostId`, not the app-wide active host.
 */
export function useCurrentAheadSnapshot(args: {
  readonly hostId: string | null;
  readonly parentRunningDir: string | null;
  readonly ignoreWhitespace: boolean;
  /** The current parent epoch: the parent subscription fingerprint. */
  readonly changeToken: string | null;
  readonly enabled: boolean;
}): CurrentAheadSnapshotResult {
  const entry = useHostDirectoryEntry(args.hostId ?? "");
  const client = useHostClientFor(entry);
  const readiness = useReactiveHostReadiness(client);

  const hostId = args.hostId;
  const runningDir = args.parentRunningDir;
  const ignoreWhitespace = args.ignoreWhitespace;
  const changeToken = args.changeToken;

  const enabled =
    args.enabled &&
    client !== null &&
    readiness.isReady &&
    hostId !== null &&
    runningDir !== null &&
    changeToken !== null;

  const request = async (): Promise<GitListChangedFilesResponseV11> => {
    if (client === null || hostId === null || runningDir === null) {
      return Promise.reject(new Error("Host client unavailable"));
    }
    return client.request("git.listChangedFiles", {
      hostId,
      runningDir,
      ignoreWhitespace,
      refreshRelations: false,
    });
  };

  const query = useQuery(
    queryOptions<GitListChangedFilesResponseV11, HostRpcError>({
      queryKey: gitQueryKeys.submoduleSnapshotAtEpoch(
        hostId,
        runningDir ?? "",
        ignoreWhitespace,
        changeToken ?? "",
      ),
      queryFn: request,
      enabled,
      staleTime: Infinity,
      refetchOnWindowFocus: false,
      refetchInterval: (q) =>
        hasDirtySubmodules(q.state.data) ? SUBMODULE_BOUNDED_REFRESH_MS : false,
    }),
  );

  return {
    data: query.data ?? null,
    isPending: enabled && query.data === undefined && query.error === null,
    error: query.error ?? null,
  };
}
