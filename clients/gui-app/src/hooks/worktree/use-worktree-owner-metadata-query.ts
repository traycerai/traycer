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
 * The one place `worktree.listAllForHost`'s request shape is written. Shared
 * between the background query (render-scoped `worktreePaths`) and a forced
 * refresh's cache-write key (the `worktreePaths` CAPTURED at mutate time), so
 * the two cannot drift into hand-copied literals that quietly fork.
 */
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

/**
 * Whether an answer that could still change is in flight. A caller-supplied
 * binding skips the binding RPC entirely, so its pending flag must not count;
 * likewise an owner with no managed worktrees never issues the worktree
 * listing, and one with no plain folders never issues the workspace summary -
 * each leg's pending flag only counts when that leg's path set is non-empty.
 *
 * ## Why the binding leg reads FETCHING and not just PENDING
 *
 * TanStack's `isPending` means "no data cached yet", so it answers false the
 * moment ANY answer has been stored - including a `{ binding: null }` cached
 * before the host had written the owner's binding row. Every later open then
 * served that null as a settled fact while the refetch that would replace it
 * was still running, and the card printed "No workspace linked" for a chat that
 * had a workspace. `isFetching` is the question this actually needs to ask: is
 * a read in flight right now, whatever is in the cache behind it.
 *
 * Consumers that already have items to show are unaffected - they render them
 * through a refetch (see `OwnerWorkspaceMetadataContent`), so widening this
 * only changes what the EMPTY state says while the host is being asked.
 */
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
  /**
   * Per-workspace summaries for the entries that are NOT managed worktrees.
   * `worktrees` above comes from a walk of managed worktrees only, so a folder
   * the owner runs in directly never appears there and has no branch without
   * this.
   */
  readonly workspaces: readonly WorktreeWorkspaceSummaryV14[];
  readonly isPending: boolean;
  /**
   * There is no host client to ask, so these facts are UNKNOWN rather than
   * absent.
   *
   * The owner's host resolved to no requester - unreachable, absent from the
   * host directory, or signed out - which is a normal state for a chat that
   * lives on another machine (it is the same condition the sidebar draws its
   * unreachable padlock from). Callers must not render it as either "loading"
   * (nothing is in flight and nothing ever will be) or as an empty binding
   * ("no workspace linked" is a claim about the OWNER, and this says only that
   * we could not ask).
   */
  readonly hostUnavailable: boolean;
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
    // Both fields captured at the moment the mutation actually fires, not read
    // from this render's closures: a client rebind, or a binding edit that
    // changes which paths are in scope, while a forced read is in flight would
    // otherwise land the response under the WRONG host or the wrong path set,
    // since `onSuccess` runs whenever it runs - not necessarily against the
    // render that started the request.
    { readonly hostId: string | null; readonly worktreePaths: string[] },
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
      onMutate: (variables) => ({
        hostId: args.client?.getActiveHostId() ?? null,
        worktreePaths: variables.worktreePaths,
      }),
      // The card can be gone by the time this lands (the pointer left), so the
      // toast is the only place a failure can surface.
      onError: (error) =>
        toastFromHostError(error, "Couldn't refresh workspace details."),
      // Lands in the SAME cache entry the card renders from. Reissuing the
      // query with `forceRefresh: true` in its params instead would fork a
      // second key that no observer reads, so the fresh facts would never
      // reach the screen. Built from the captured context, not the render's
      // `listParams`, so it lands in the entry THIS request actually read.
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
    // The binding decides WHICH folders the card lists, the listing decides
    // what it says about them - so refetch the binding FIRST and force the
    // reads against ITS paths, not this render's. Forcing on the render's
    // stale path set would refresh the WRONG folders whenever the binding
    // changed (a worktree added/removed) since this callback was created,
    // leaving the newly (dis)appeared folder stale until a second Refresh.
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
      // Requires a CLIENT, then `isPending || isFetching`.
      //
      // The two flags cover different gaps and neither is sufficient alone:
      // `isPending` misses a refetch over cached data (the stale-null case this
      // whole signal exists for), and `isFetching` misses a query whose host is
      // merely still connecting - it has no data and no request yet, but one is
      // coming.
      //
      // The client check is what stops the pair from spinning FOREVER. With no
      // client there is no request now and none pending: `useHostQuery` gates
      // the query off, so `isPending` stays true for the lifetime of the card
      // with `isFetching` false. Reporting that as "loading" is a dead end -
      // nothing will ever arrive to end it. It is reported as
      // `hostUnavailable` below instead, which the card can state plainly.
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
