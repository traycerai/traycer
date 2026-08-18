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
