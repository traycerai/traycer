import { useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  HostRpcError,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import {
  LEGACY_HOST_RESOLVED_AT,
  type WorktreeBinding,
  type WorktreeBindingOwnerKind,
  type WorktreeHostEntryV14,
  type WorktreeWorkspaceSummaryV13,
} from "@traycer/protocol/host/worktree-schemas";
import { useHostMutation, useHostQuery } from "@/hooks/host/use-host-query";
import { useWorktreeGetBinding } from "@/hooks/worktree/use-worktree-get-binding-query";
import {
  useWorktreeListByWorkspacePathsForClient,
  worktreeListByWorkspacePathsParams,
} from "@/hooks/worktree/use-worktree-list-by-workspace-paths-query";
import type { HostRpcRegistry } from "@/lib/host";
import { toastFromHostError } from "@/lib/host-error-toast";
import { queryKeys, worktreeMutationKeys } from "@/lib/query-keys";

const EMPTY_WORKTREES: readonly WorktreeHostEntryV14[] = [];
const EMPTY_WORKSPACES: readonly WorktreeWorkspaceSummaryV13[] = [];

type WorktreeListAllForHostResponse = ResponseOfMethod<
  HostRpcRegistry,
  "worktree.listAllForHost"
>;

type WorktreeListByWorkspacePathsResponse = ResponseOfMethod<
  HostRpcRegistry,
  "worktree.listByWorkspacePaths"
>;

/**
 * The host's derive time for whatever is on screen, or `null` when nothing has
 * been derived yet.
 *
 * The OLDEST stamp across every row wins: the card is only as fresh as its
 * stalest folder. `LEGACY_HOST_RESOLVED_AT` (the literal `1`, stamped for rows
 * bridged from a host that predates `resolvedAt`) is dropped rather than
 * rendered - it is a resolved-marker, not a time, and an age computed from it
 * reads as 1970.
 */
function oldestResolvedAt(stamps: ReadonlyArray<number | null>): number | null {
  const real = stamps.flatMap((stamp) =>
    stamp === null || stamp === LEGACY_HOST_RESOLVED_AT ? [] : [stamp],
  );
  return real.length === 0 ? null : Math.min(...real);
}

/**
 * Splits an owner's binding into the two path sets that need two DIFFERENT
 * host reads.
 *
 * `worktreePaths` are managed worktrees, covered by the host-wide worktree walk
 * (`worktree.listAllForHost`). Everything else is a folder the owner runs in
 * directly - the walk never sees it, and its binding entry carries no branch
 * (that field records the branch a worktree binding was CREATED on), so its
 * facts have to come from the per-workspace summary
 * (`worktree.listByWorkspacePaths`) instead. Missing that second read is what
 * left a plain folder reading "No branch" no matter how often it was refreshed.
 *
 * Mutable arrays on purpose: both request schemas take mutable path lists.
 */
function bindingRunPaths(binding: WorktreeBinding | null): {
  readonly worktreePaths: string[];
  readonly workspacePaths: string[];
} {
  const entries = binding?.entries ?? [];
  const isManagedWorktree = (entry: (typeof entries)[number]): boolean =>
    entry.mode === "worktree" && entry.worktreePath !== null;
  return {
    worktreePaths: Array.from(
      new Set(
        entries.flatMap((entry) =>
          isManagedWorktree(entry) && entry.worktreePath !== null
            ? [entry.worktreePath]
            : [],
        ),
      ),
    ),
    workspacePaths: Array.from(
      new Set(
        entries.flatMap((entry) =>
          isManagedWorktree(entry) ? [] : [entry.workspacePath],
        ),
      ),
    ),
  };
}

/**
 * Whether the card still has nothing to show. A caller-supplied binding skips
 * the binding RPC entirely, so its pending flag must not count; likewise an
 * owner with no managed worktrees never issues the worktree listing, and one
 * with no plain folders never issues the workspace summary - each leg's
 * pending flag only counts when that leg's path set is non-empty.
 */
function ownerMetadataPending(input: {
  readonly enabled: boolean;
  readonly bindingSupplied: boolean;
  readonly bindingPending: boolean;
  readonly worktreePathCount: number;
  readonly worktreesPending: boolean;
  readonly workspacePathCount: number;
  readonly workspacesPending: boolean;
}): boolean {
  if (!input.enabled) return false;
  if (!input.bindingSupplied && input.bindingPending) return true;
  if (input.worktreePathCount > 0 && input.worktreesPending) return true;
  return input.workspacePathCount > 0 && input.workspacesPending;
}

/** The binding failure outranks the listings': without it there is no list. */
function ownerMetadataError(input: {
  readonly enabled: boolean;
  readonly bindingSupplied: boolean;
  readonly bindingError: HostRpcError | null;
  readonly worktreesError: HostRpcError | null;
  readonly workspacesError: HostRpcError | null;
}): HostRpcError | null {
  if (!input.enabled) return null;
  if (!input.bindingSupplied && input.bindingError !== null) {
    return input.bindingError;
  }
  return input.worktreesError ?? input.workspacesError;
}

export interface WorktreeOwnerMetadata {
  readonly binding: WorktreeBinding | null;
  readonly worktrees: readonly WorktreeHostEntryV14[];
  /**
   * Per-workspace summaries for the entries that are NOT managed worktrees.
   * `worktrees` above comes from a walk of managed worktrees only, so a folder
   * the owner runs in directly never appears there and has no branch without
   * this.
   */
  readonly workspaces: readonly WorktreeWorkspaceSummaryV13[];
  readonly isPending: boolean;
  readonly error: HostRpcError | null;
  /**
   * When the HOST last derived these facts, or `null` before anything has been
   * derived.
   *
   * Deliberately the rows' own `resolvedAt` and not the query's client-side
   * `dataUpdatedAt`: the card unmounts on close, so every re-open refetches and
   * `dataUpdatedAt` is always ~now - it reported "Checked now" forever while
   * the host was serving facts from its TTL cache that could be an hour old.
   * Staleness is the entire point of the label, so it has to come from the
   * side that actually does the deriving.
   */
  readonly checkedAt: number | null;
  readonly isRefreshing: boolean;
  /**
   * Re-derives this owner's worktree facts from disk. Resolves once the host
   * has answered (or rejects, having already toasted).
   */
  readonly refresh: () => Promise<void>;
}

/**
 * Resolves one chat/terminal-agent's binding, then enriches only the worktree
 * paths that owner actually runs in. Supplying `binding` skips the binding RPC
 * (chat status lines already receive it from `chat.subscribe`); `undefined`
 * lets navigator hover resolve it lazily from the owner-scoped host.
 */
export function useWorktreeOwnerMetadata(args: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly epicId: string;
  readonly ownerId: string;
  readonly ownerKind: WorktreeBindingOwnerKind;
  readonly binding: WorktreeBinding | null | undefined;
  readonly enabled: boolean;
}): WorktreeOwnerMetadata {
  const queryClient = useQueryClient();
  const bindingQuery = useWorktreeGetBinding({
    client: args.client,
    epicId: args.epicId,
    ownerId: args.ownerId,
    ownerKind: args.ownerKind,
    enabled: args.enabled && args.binding === undefined,
    poll: false,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  const binding =
    args.binding === undefined
      ? (bindingQuery.data?.binding ?? null)
      : args.binding;
  const { worktreePaths, workspacePaths } = useMemo(
    () => bindingRunPaths(binding),
    [binding],
  );
  const workspacesQuery = useWorktreeListByWorkspacePathsForClient(
    args.client,
    { workspacePaths, enabled: args.enabled },
  );
  // The background read's params, held in ONE place because the forced refresh
  // below has to write its response into this query's cache entry - and a key
  // rebuilt from a second, hand-copied literal silently forks the moment either
  // side changes.
  const listParams = useMemo(
    () => ({
      includeActivity: true,
      activityPaths: worktreePaths,
      cursor: null,
      limit: null,
      // A background read: serve the host's TTL-cached view. Only an explicit
      // Refresh (below, and the Settings toolbar's) forces a disk recompute.
      forceRefresh: false,
    }),
    [worktreePaths],
  );
  const worktreesQuery = useHostQuery<
    HostRpcRegistry,
    "worktree.listAllForHost"
  >({
    cacheKeyIdentity: undefined,
    client: args.client,
    method: "worktree.listAllForHost",
    params: listParams,
    options: { enabled: args.enabled && worktreePaths.length > 0 },
  });
  const refreshMutation = useHostMutation<
    HostRpcRegistry,
    "worktree.listAllForHost",
    // Captured at the moment the mutation actually fires, not read from this
    // render's closed-over `readiness.hostId`: a client rebind while a forced
    // read is in flight would otherwise land the OLD host's response in the
    // NEW host's cache entry, since `onSuccess` runs on whatever render last
    // recomputed the key rather than the one that started the request.
    { readonly hostId: string | null },
    // Mutable `string[]`, matching the request schema's own `activityPaths`
    // rather than copying a readonly view into it on every call.
    { readonly worktreePaths: string[] }
  >({
    client: args.client,
    method: "worktree.listAllForHost",
    // Scoped to this owner's paths, never the whole fleet: the host re-derives
    // exactly what the card is showing (branch, uncommitted count, and the `gh`
    // PR facts, which a plain read only ever warms while they are still null -
    // a PR that has since merged or closed never re-probes without this).
    mapVariables: (variables) => ({
      includeActivity: true,
      activityPaths: variables.worktreePaths,
      cursor: null,
      limit: null,
      forceRefresh: true,
    }),
    options: {
      mutationKey: worktreeMutationKeys.refreshOwnerMetadata(args.ownerId),
      onMutate: () => ({ hostId: args.client?.getActiveHostId() ?? null }),
      // The card can be gone by the time this lands (the pointer left), so the
      // toast is the only place a failure can surface.
      onError: (error) =>
        toastFromHostError(error, "Couldn't refresh workspace details."),
      // Lands in the SAME cache entry the card renders from. Reissuing the
      // query with `forceRefresh: true` in its params instead would fork a
      // second key that no observer reads, so the fresh facts would never
      // reach the screen.
      onSuccess: (response, _variables, context) => {
        queryClient.setQueryData<WorktreeListAllForHostResponse>(
          queryKeys.hostMethod<HostRpcRegistry, "worktree.listAllForHost">(
            context.hostId,
            "worktree.listAllForHost",
            listParams,
          ),
          response,
        );
      },
    },
  });
  // The same treatment for the plain-folder summaries. Without it Refresh would
  // re-derive the worktree rows and quietly leave every non-worktree folder on
  // whatever branch the host had cached.
  const refreshWorkspacesMutation = useHostMutation<
    HostRpcRegistry,
    "worktree.listByWorkspacePaths",
    { readonly hostId: string | null },
    { readonly workspacePaths: string[] }
  >({
    client: args.client,
    method: "worktree.listByWorkspacePaths",
    mapVariables: (variables) => ({
      workspacePaths: variables.workspacePaths,
      scriptRefs: [],
      forceRefresh: true,
    }),
    options: {
      mutationKey: worktreeMutationKeys.refreshOwnerWorkspaces(args.ownerId),
      onMutate: () => ({ hostId: args.client?.getActiveHostId() ?? null }),
      onError: (error) =>
        toastFromHostError(error, "Couldn't refresh workspace details."),
      onSuccess: (response, _variables, context) => {
        queryClient.setQueryData<WorktreeListByWorkspacePathsResponse>(
          queryKeys.hostMethod<
            HostRpcRegistry,
            "worktree.listByWorkspacePaths"
          >(
            context.hostId,
            "worktree.listByWorkspacePaths",
            worktreeListByWorkspacePathsParams(workspacePaths),
          ),
          response,
        );
      },
    },
  });
  const refreshWorktrees = refreshMutation.mutateAsync;
  const refreshWorkspaces = refreshWorkspacesMutation.mutateAsync;
  const refetchBinding = bindingQuery.refetch;
  const suppliedBinding = args.binding;
  const refresh = useCallback(async () => {
    // The binding decides WHICH folders the card lists, the listing decides
    // what it says about them; a refresh that skipped the binding would keep
    // showing a folder the owner no longer runs in.
    await Promise.all([
      suppliedBinding === undefined ? refetchBinding() : null,
      worktreePaths.length === 0
        ? null
        : refreshWorktrees({ worktreePaths }).then(() => undefined),
      workspacePaths.length === 0
        ? null
        : refreshWorkspaces({ workspacePaths }).then(() => undefined),
    ]);
  }, [
    refetchBinding,
    refreshWorkspaces,
    refreshWorktrees,
    suppliedBinding,
    workspacePaths,
    worktreePaths,
  ]);

  const worktrees = worktreesQuery.data?.worktrees ?? EMPTY_WORKTREES;
  const workspaces = workspacesQuery.data?.workspaces ?? EMPTY_WORKSPACES;
  return {
    binding,
    worktrees,
    workspaces,
    isPending: ownerMetadataPending({
      enabled: args.enabled,
      bindingSupplied: suppliedBinding !== undefined,
      bindingPending: bindingQuery.isPending,
      worktreePathCount: worktreePaths.length,
      worktreesPending: worktreesQuery.isPending,
      workspacePathCount: workspacePaths.length,
      workspacesPending: workspacesQuery.isPending,
    }),
    error: ownerMetadataError({
      enabled: args.enabled,
      bindingSupplied: suppliedBinding !== undefined,
      bindingError: bindingQuery.error,
      worktreesError: worktreesQuery.error,
      workspacesError: workspacesQuery.error,
    }),
    checkedAt: oldestResolvedAt([
      ...worktrees.map((entry) => entry.resolvedAt),
      ...workspaces.map((summary) => summary.resolvedAt),
    ]),
    isRefreshing:
      refreshMutation.isPending || refreshWorkspacesMutation.isPending,
    refresh,
  };
}
