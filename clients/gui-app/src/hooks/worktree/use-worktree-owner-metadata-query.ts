import { useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  WorktreeBinding,
  WorktreeBindingOwnerKind,
  WorktreeHostEntryV14,
  WorktreeWorkspaceSummaryV14,
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
import { oldestResolvedAt } from "@/lib/worktree/oldest-resolved-at";

const EMPTY_WORKTREES: readonly WorktreeHostEntryV14[] = [];
const EMPTY_WORKSPACES: readonly WorktreeWorkspaceSummaryV14[] = [];

type WorktreeListAllForHostResponse = ResponseOfMethod<
  HostRpcRegistry,
  "worktree.listAllForHost"
>;

type WorktreeListByWorkspacePathsResponse = ResponseOfMethod<
  HostRpcRegistry,
  "worktree.listByWorkspacePaths"
>;

/**
 * Managed worktrees go through `worktree.listAllForHost`; owner-run folders need `worktree.listByWorkspacePaths` or they read "No branch". Arrays are mutable for the request schemas.
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

/** Shared between the background query (render-scoped `worktreePaths`) and a forced refresh's cache-write key (the `worktreePaths` CAPTURED at mutate time), so the two cannot drift into hand-copied literals that quietly fork. */
function worktreeListAllForHostParams(
  worktreePaths: ReadonlyArray<string>,
): RequestOfMethod<HostRpcRegistry, "worktree.listAllForHost"> {
  return {
    includeActivity: true,
    activityPaths: [...worktreePaths],
    cursor: null,
    limit: null,
    // A background read: serve the host's TTL-cached view. Only an explicit
    // Refresh forces a disk recompute (see the mutation's own `mapVariables`).
    forceRefresh: false,
  };
}

/** Binding leg uses isFetching, not isPending: a cached { binding: null } is not settled. Skip pending flags for legs that never issue. */
function ownerMetadataPending(input: {
  readonly enabled: boolean;
  readonly bindingSupplied: boolean;
  readonly bindingInFlight: boolean;
  readonly worktreePathCount: number;
  readonly worktreesPending: boolean;
  readonly workspacePathCount: number;
  readonly workspacesPending: boolean;
}): boolean {
  if (!input.enabled) return false;
  if (!input.bindingSupplied && input.bindingInFlight) return true;
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
  /** `worktrees` above comes from a walk of managed worktrees only, so a folder the owner runs in directly never appears there and has no branch without this. */
  readonly workspaces: readonly WorktreeWorkspaceSummaryV14[];
  readonly isPending: boolean;
  /**
   * No requester: unknown, not absent. Not loading and not an empty binding.
   */
  readonly hostUnavailable: boolean;
  readonly error: HostRpcError | null;
  /**
   * Staleness is the host's `resolvedAt`, not the query's `dataUpdatedAt`. Re-open always refetches, so `dataUpdatedAt` is always ~now.
   */
  readonly checkedAt: number | null;
  readonly isRefreshing: boolean;
  /** Resolves once the host has answered (or rejects, having already toasted). */
  readonly refresh: () => Promise<void>;
}

/** Resolves one chat/terminal-agent's binding, then enriches only the worktree paths that owner actually runs in. */
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
  const listParams = useMemo(
    () => worktreeListAllForHostParams(worktreePaths),
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
    // Both fields captured at the moment the mutation actually fires, not read from this render's closures: a client rebind, or a binding edit that changes which paths are in scope, while a forced read is in flight would otherwise land the response under the WRONG host or the wrong path set, since `onSuccess` runs whenever it runs - not necessarily against the render that started the request.
    { readonly hostId: string | null; readonly worktreePaths: string[] },
    // Mutable `string[]`, matching the request schema's own `activityPaths`
    // rather than copying a readonly view into it on every call.
    { readonly worktreePaths: string[] }
  >({
    client: args.client,
    method: "worktree.listAllForHost",
    // Scoped to this owner's paths, never the whole fleet: the host re-derives exactly what the card is showing (branch, uncommitted count, and the `gh` PR facts, which a plain read only ever warms while they are still null - a PR that has since merged or closed never re-probes without this).
    mapVariables: (variables) => ({
      includeActivity: true,
      activityPaths: variables.worktreePaths,
      cursor: null,
      limit: null,
      forceRefresh: true,
    }),
    options: {
      mutationKey: worktreeMutationKeys.refreshOwnerMetadata(args.ownerId),
      onMutate: (variables) => ({
        hostId: args.client?.getActiveHostId() ?? null,
        worktreePaths: variables.worktreePaths,
      }),
      // The card can be gone by the time this lands (the pointer left), so the
      // toast is the only place a failure can surface.
      onError: (error) =>
        toastFromHostError(error, "Couldn't refresh workspace details."),
      // Built from the captured context, not the render's `listParams`, so it lands in the entry THIS request actually read.
      // Reissuing the query with `forceRefresh: true` in its params instead would fork a second key that no observer reads, so the fresh facts would never reach the screen.
      onSuccess: (response, _variables, context) => {
        queryClient.setQueryData<WorktreeListAllForHostResponse>(
          queryKeys.hostMethod<HostRpcRegistry, "worktree.listAllForHost">(
            context.hostId,
            "worktree.listAllForHost",
            worktreeListAllForHostParams(context.worktreePaths),
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
    { readonly hostId: string | null; readonly workspacePaths: string[] },
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
      onMutate: (variables) => ({
        hostId: args.client?.getActiveHostId() ?? null,
        workspacePaths: variables.workspacePaths,
      }),
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
            worktreeListByWorkspacePathsParams(context.workspacePaths),
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
    // Forcing on the render's stale path set would refresh the WRONG folders whenever the binding changed (a worktree added/removed) since this callback was created, leaving the newly (dis)appeared folder stale until a second Refresh.
    const currentBinding =
      suppliedBinding === undefined
        ? ((await refetchBinding()).data?.binding ?? null)
        : suppliedBinding;
    const paths = bindingRunPaths(currentBinding);
    await Promise.all([
      paths.worktreePaths.length === 0
        ? null
        : refreshWorktrees({ worktreePaths: paths.worktreePaths }).then(
            () => undefined,
          ),
      paths.workspacePaths.length === 0
        ? null
        : refreshWorkspaces({ workspacePaths: paths.workspacePaths }).then(
            () => undefined,
          ),
    ]);
  }, [refetchBinding, refreshWorkspaces, refreshWorktrees, suppliedBinding]);

  const worktrees = worktreesQuery.data?.worktrees ?? EMPTY_WORKTREES;
  const workspaces = workspacesQuery.data?.workspaces ?? EMPTY_WORKSPACES;
  return {
    binding,
    worktrees,
    workspaces,
    // Only when this hook would have had to ASK. A caller that supplied the
    // binding already has the answer, and a closed card has no question.
    hostUnavailable:
      args.enabled && suppliedBinding === undefined && args.client === null,
    isPending: ownerMetadataPending({
      enabled: args.enabled,
      bindingSupplied: suppliedBinding !== undefined,
      // Loading is client present and (`isPending` || `isFetching`). No client is `hostUnavailable`, not loading: `useHostQuery` stays pending forever with the query gated off.
      bindingInFlight:
        args.client !== null &&
        (bindingQuery.isPending || bindingQuery.isFetching),
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
