import { useEffect, useRef } from "react";
import { queryOptions, useQuery } from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { GitListChangedFilesResponseV11 } from "@traycer/protocol/host";
import { useHostClientFor } from "@/hooks/host/use-host-client-for";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import { gitQueryKeys } from "@/lib/query-keys/git-query-keys";

/**
 * Bounded poll interval used while any submodule is dirty. The parent
 * `subscribeStatus@1.0` stream is blind to inner-only submodule edits (they
 * don't move the gitlink's dirty flags once already dirty), and the parent
 * fingerprint deliberately doesn't fold `submodules[]`, so a dirty submodule
 * needs a timer to pick up further inner edits. 5s matches the host's own poll
 * class (UX-confirmed freshness for this review surface).
 */
const SUBMODULE_BOUNDED_REFRESH_MS = 5000;

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
 * Source of truth for the selected root repo's nested changes: the host-composed
 * `git.listChangedFiles@1.1` snapshot (parent changeset + `submodules[]`) in a
 * single epoch. Fetched only for the selected root (bounded lazy fan-out - the
 * switcher never eagerly fans out every root).
 *
 * Git panels are **worktree-scoped**, so the RPC must hit the selected worktree's
 * host, not the app-wide active host - `hostId` in the request body does not
 * route the call (`HostClient.request()` sends through the bound messenger). The
 * client is resolved via `useHostClientFor` for `args.hostId`, and readiness is
 * derived from *that* client.
 *
 * Freshness is driven two ways, neither a per-submodule stream:
 * - `changeToken` (the parent subscription's fingerprint) - refetch when the
 *   parent working tree changes (which includes a submodule flipping
 *   clean<->dirty, since that moves the parent gitlink row).
 * - a bounded timer while any submodule is dirty - covers inner-only edits the
 *   parent stream can't see.
 *
 * Manual refresh is a plain `invalidateQueries` on this slot (see
 * `GitDiffPanelActions`); there is no `refreshRelations` flag (the host no longer
 * carries a relation cache to bypass).
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

  const hostId = args.hostId;
  const runningDir = args.runningDir;
  const ignoreWhitespace = args.ignoreWhitespace;

  const enabled =
    args.enabled &&
    client !== null &&
    readiness.isReady &&
    hostId !== null &&
    runningDir !== null;

  // Named request closure (mirrors `useHostQuery`) so `client` stays out of the
  // cache key: it is transport identity, not data identity.
  const request = async (): Promise<GitListChangedFilesResponseV11> => {
    if (client === null || hostId === null || runningDir === null) {
      return Promise.reject(new Error("Host client unavailable"));
    }
    return client.request("git.listChangedFiles", {
      hostId,
      runningDir,
      ignoreWhitespace,
      includeSubmodules: true,
    });
  };

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
      enabled,
      staleTime: Infinity,
      refetchOnWindowFocus: false,
      refetchInterval: (query) =>
        hasDirtySubmodulesForRefresh(query.state.data)
          ? SUBMODULE_BOUNDED_REFRESH_MS
          : false,
    }),
  );

  // Refetch when the parent subscription reports a change. The ref stores the
  // full source identity alongside the token so a host/worktree/whitespace
  // change resets it (the new key mounts its own fetch), and only a genuine
  // token change on the *same* source forces a refetch - never the first
  // settled value.
  const { refetch } = query;
  const lastTokenRef = useRef<ChangeTokenIdentity | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const previous = lastTokenRef.current;
    const sameSource =
      previous !== null &&
      previous.hostId === hostId &&
      previous.runningDir === runningDir &&
      previous.ignoreWhitespace === ignoreWhitespace;
    lastTokenRef.current = {
      hostId,
      runningDir,
      ignoreWhitespace,
      token: args.changeToken,
    };
    if (!sameSource) return;
    if (args.changeToken === null) return;
    if (previous.token === args.changeToken) return;
    void refetch();
  }, [
    args.changeToken,
    enabled,
    hostId,
    runningDir,
    ignoreWhitespace,
    refetch,
  ]);

  return {
    data: query.data ?? null,
    isPending: enabled && query.data === undefined && query.error === null,
    error: query.error ?? null,
  };
}
