import type { AccountContext } from "@traycer/protocol/common/schemas";
import type { RequestOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import type { ResolveArtifactByPathRequest } from "@traycer/protocol/host/epic/unary-schemas";
import type { WorkspaceReadFileRequest } from "@traycer/protocol/host/workspace/unary-schemas";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import type { VersionedRpcRegistry } from "@traycer/protocol/framework";
import type { PlainTerminalScope } from "@traycer/protocol/host/terminal/plain-schemas";

const EPIC_TASK_CONTEXTS_METHOD = "epic.getTaskContexts" as const;

export const hostQueryKeys = {
  base: () => ["host"] as const,
  scope: (hostId: string | null) =>
    hostId === null
      ? hostQueryKeys.base()
      : ([...hostQueryKeys.base(), hostId] as const),
  methodScope: <Method extends string>(hostId: string | null, method: Method) =>
    [...hostQueryKeys.scope(hostId), method] as const,
  /**
   * Whether `queryKey` is a `method` key under ANY host scope - the
   * `predicate` form of `methodScope` for a fact that is not one host's. A
   * key built with a null host has the method at index 1, a host-bound key at
   * index 2; a host id is never a method name, so both slots are tested.
   */
  matchesMethodOnAnyHost: (queryKey: readonly unknown[], method: string) =>
    queryKey[0] === "host" &&
    (queryKey[1] === method || queryKey[2] === method),
  method: <
    Registry extends VersionedRpcRegistry,
    Method extends keyof Registry & string,
  >(
    hostId: string | null,
    method: Method,
    params: RequestOfMethod<Registry, Method>,
  ) => [...hostQueryKeys.scope(hostId), method, params] as const,
  plainTerminals: (hostId: string, scope: PlainTerminalScope) =>
    hostQueryKeys.method<HostRpcRegistry, "terminal.plain.list">(
      hostId,
      "terminal.plain.list",
      { scope },
    ),
  /**
   * Named alias for the imperative `epic.resolveArtifactByPath` read so the key
   * stays discoverable at the call site. A click resolving an artifact-shaped
   * markdown link fires this via `queryClient.fetchQuery`; keying on
   * `{ epicId, filePath }` dedupes repeated clicks on the same link and reuses
   * the cached id within the stale window. Delegates to the generic `method`
   * builder so the key shape is defined in exactly one place (CL-10).
   */
  resolveArtifactByPath: (
    hostId: string | null,
    params: ResolveArtifactByPathRequest,
  ) =>
    hostQueryKeys.method<HostRpcRegistry, "epic.resolveArtifactByPath">(
      hostId,
      "epic.resolveArtifactByPath",
      params,
    ),
  /**
   * Named alias for the imperative `workspace.readFile` existence probe a
   * relative chat markdown link fires per candidate root - keyed on
   * `{ workspacePath, filePath, maxBytes }` so the probe (small `maxBytes`)
   * and the preview tile's full read (large `maxBytes`) never collide on the
   * same cache slot. Delegates to the generic `method` builder (CL-10).
   */
  readWorkspaceFile: (
    hostId: string | null,
    params: WorkspaceReadFileRequest,
  ) =>
    hostQueryKeys.method<HostRpcRegistry, "workspace.readFile">(
      hostId,
      "workspace.readFile",
      params,
    ),
  /**
   * Named alias for the Traycer-sourced `host.getRateLimitUsage` aperture
   * call (`{ accountContext }`, no `providerId`) - distinct from the
   * per-provider pull's `{ accountContext, providerId }` key. Centralized so
   * the header popover and its tests can't drift on this key's shape.
   */
  traycerRateLimitUsage: (
    hostId: string | null,
    accountContext: AccountContext,
  ) =>
    hostQueryKeys.method<HostRpcRegistry, "host.getRateLimitUsage">(
      hostId,
      "host.getRateLimitUsage",
      { accountContext, profileId: null },
    ),
  /**
   * The Sweep dialog's act-time candidate probe: a composed fetch (un-probed
   * base walk to find the selected Tasks' paths, then a selection-mode
   * `forceRefresh` enrichment of exactly those paths). `epicKey` is the
   * sorted, comma-joined selection, so the same set reuses one slot whatever
   * the click order. Selection-scoped and deliberately OUTSIDE
   * the `worktree.listAllForHost` method scope: the forced probe itself makes
   * the host publish a `worktree.changed` burst, and the client's blanket
   * listing invalidation (refetchType "active") would refetch this very query
   * while the dialog is open - re-probing its own just-settled proof and
   * flashing the candidate list back to "Checking…". External invalidation
   * buys it nothing anyway: `staleTime: 0` already re-proves on every open.
   */
  sweepWorktreeCandidates: (hostId: string | null, epicKey: string) =>
    [
      ...hostQueryKeys.scope(hostId),
      "worktree.sweepCandidates",
      epicKey,
    ] as const,
  sweepWorktreeHolders: (hostId: string | null, worktreePath: string) =>
    [
      ...hostQueryKeys.scope(hostId),
      "worktree.listHolders",
      worktreePath,
    ] as const,
  /**
   * Named alias for `host.usage.summary` (Usage page + epic cost badge).
   * Keyed on the full request (`timezone`/`windowDays`/`epicId`), so the
   * window picker, metric toggle's underlying data, and the epic-scoped
   * badge each land on their own cache slot without hand-building the key.
   */
  usageSummary: (
    hostId: string | null,
    params: RequestOfMethod<HostRpcRegistry, "host.usage.summary">,
  ) =>
    hostQueryKeys.method<HostRpcRegistry, "host.usage.summary">(
      hostId,
      "host.usage.summary",
      params,
    ),
  /**
   * The account auto-mode policy read, for ONE viewer.
   *
   * `useAutoPolicyQuery` passes `cacheKeyIdentity: [viewerUserId]` because the
   * record is ACCOUNT-owned while the key is host-shaped, and without the
   * viewer segment a signed-out user's policy is served synchronously to
   * whoever signs in next. This builder is the write side of that partition:
   * `autoPolicy.set` folds its response into the read cache, and a
   * `setQueriesData` on the bare method scope is a PREFIX match, so it would
   * write the new body into every viewer's entry under this host - re-opening
   * the same leak through the other door, with the saver's prose landing in the
   * previous account's cached policy.
   *
   * Shape mirrors what `useHostQuery` produces (`epicTaskContexts` above is the
   * same arrangement): `["host", hostId, method, params, userId]`, with the
   * `{}` params `AUTO_POLICY_GET_PARAMS` sends. Keep the two in step - nothing
   * type-checks a key against the hook that builds it.
   */
  autoPolicyForViewer: (hostId: string | null, userId: string) =>
    [
      ...hostQueryKeys.method<HostRpcRegistry, "autoPolicy.get">(
        hostId,
        "autoPolicy.get",
        {},
      ),
      userId,
    ] as const,
  /**
   * Batch task-context title lookup (`epic.getTaskContexts`). Key shape matches
   * what `useHostQuery` / `useHostQueries` produce for that method with
   * `cacheKeyIdentity: userId`: `["host", hostId, method, { taskIds }, userId]`.
   * Callers must pass a sorted `taskIds` array for stable cache identity.
   */
  epicTaskContexts: (
    hostId: string | null,
    userId: string,
    taskIds: readonly string[],
  ) =>
    [
      ...hostQueryKeys.method<
        HostRpcRegistry,
        typeof EPIC_TASK_CONTEXTS_METHOD
      >(hostId, EPIC_TASK_CONTEXTS_METHOD, { taskIds: [...taskIds] }),
      userId,
    ] as const,
};

/**
 * True for any `epic.getTaskContexts` host query key (any host / user / id set).
 * Used by rename write-through to find batch-title cache entries to patch.
 */
export function isEpicTaskContextsQueryKey(
  queryKey: readonly unknown[],
): boolean {
  return queryKey[0] === "host" && queryKey[2] === EPIC_TASK_CONTEXTS_METHOD;
}
