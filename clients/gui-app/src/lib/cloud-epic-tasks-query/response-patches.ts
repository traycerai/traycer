import type {
  ListTaskLight,
  ListTasksFacets,
  ListTasksResponse,
  TaskLight,
  TaskRepoIdentifier,
  TaskWorkspaceIdentifier,
} from "@traycer/protocol/host/epic/unary-schemas";
import { formatRepoIdentifier } from "@traycer/protocol/host/epic/unary-schemas";

/** Identity-preserving per-row home patch, shared by first pages and tails. */
export function setEpicLocalHomeInCloudTasksResponse(
  response: ListTasksResponse,
  epicId: string,
  localHome: boolean,
): ListTasksResponse {
  const tasks = response.tasks.map((task) => {
    if (task.epic?.light?.id !== epicId) return task;
    const current = "home" in task ? task.home : undefined;
    if (localHome) {
      return current === "local" ? task : { ...task, home: "local" as const };
    }
    // Promoted: drop the key rather than introducing a `home: "cloud"` shape
    // that normal cloud-backed rows do not carry.
    if (current === undefined) return task;
    const { home: _home, ...withoutHome } = task;
    return withoutHome;
  });
  const changed = tasks.some((task, index) => task !== response.tasks[index]);
  return changed ? { ...response, tasks } : response;
}

/** Identity-preserving per-row pin patch, shared by first pages and tails. */
export function setEpicPinnedInCloudTasksResponse(
  response: ListTasksResponse,
  epicId: string,
  pinned: boolean,
): ListTasksResponse {
  const tasks = response.tasks.map((task) => {
    if (task.epic?.light?.id !== epicId) return task;
    if ((task.pinned ?? false) === pinned) return task;
    return { ...task, pinned };
  });
  const changed = tasks.some((task, index) => task !== response.tasks[index]);
  return changed ? { ...response, tasks } : response;
}

/**
 * Removes locally-deleted epics from an incoming page. This is shared by the
 * Query cache and the retained-page store so first pages and cursor pages
 * apply the same deletion result before either surface becomes renderable.
 *
 * A row preserved for never-uploaded local edits is the authoritative
 * exception: the host has withdrawn its deletion tombstone for that row by
 * listing it with `preservation: "orphaned-local-edits"`. Keep that recovery
 * row even when this renderer session still remembers the earlier delete.
 */
export function removeDeletedEpicsFromCloudTasksResponse(
  response: ListTasksResponse,
  deletedEpicIds: ReadonlySet<string>,
  userId: string,
): ListTasksResponse {
  const removedTasks = response.tasks.filter((task) =>
    isDeletedEpicTask(task, deletedEpicIds),
  );
  if (removedTasks.length === 0) return response;
  const tasks = response.tasks.filter(
    (task) => !isDeletedEpicTask(task, deletedEpicIds),
  );
  // Facet counts describe the SERVER result set and never included a
  // host-injected `home: "local"` row - the protocol marks facets `partial`
  // when local rows are added for exactly that reason. Decrementing them for
  // a local-home deletion undercounted unrelated cloud rows and could remove
  // a repo, workspace, ownership or chat-host option that still had cloud
  // matches, persistently in inactive cached scopes that never refetch.
  const removedCloudTasks = removedTasks.filter(
    (task) => task.home !== "local",
  );
  return {
    ...response,
    tasks,
    facets:
      response.facets === undefined || removedCloudTasks.length === 0
        ? response.facets
        : removeTasksFromFacets(response.facets, removedCloudTasks, userId),
  };
}

function isDeletedEpicTask(
  task: ListTaskLight,
  deletedEpicIds: ReadonlySet<string>,
): boolean {
  // This is a standing admission override, not a ledger retraction. It is
  // safe only because a preserved orphan cannot enter `deletedEpicIds`:
  // `epic-batch-delete-resolver.ts` refuses its branch rows and removes the
  // id from `reclaimedIds`, so the renderer receives `success: false` and
  // never records the delete. If a future force-delete path changes that
  // contract, replace this exemption with ledger retirement on authoritative
  // preserved-row arrival; otherwise the next page would resurrect a delete.
  return (
    task.preservation !== "orphaned-local-edits" &&
    deletedEpicIds.has(task.epic?.light?.id ?? "")
  );
}

function removeTasksFromFacets(
  facets: ListTasksFacets,
  tasks: ReadonlyArray<ListTaskLight>,
  userId: string,
): ListTasksFacets {
  return {
    repos: decrementRepoFacets(facets.repos, reposFromTasks(tasks)),
    workspaces: decrementWorkspaceFacets(
      facets.workspaces,
      workspacesFromTasks(tasks),
    ),
    ownershipScopes: decrementOwnershipFacets(
      facets.ownershipScopes,
      ownershipScopesFromTasks(tasks, userId),
    ),
    // Rebuilding this object DROPS `chatHosts` unless it is carried, and its
    // absence is not cosmetic: the history gate reads a missing group as proof
    // that the server never applied the host filter and withholds every row
    // (`use-history-query`). A local delete would then present as "this host
    // is too old to filter by host" - permanently, since these entries are
    // cached with `staleTime`/`gcTime` at Infinity and never refetch on their
    // own. Any future facet group must be carried here for the same reason.
    chatHosts: decrementChatHostFacets(facets.chatHosts, tasks),
  };
}

function decrementChatHostFacets(
  current: ListTasksFacets["chatHosts"],
  removed: ReadonlyArray<ListTaskLight>,
): ListTasksFacets["chatHosts"] {
  if (current === undefined) return undefined;
  const removedCounts = new Map<string, number>();
  for (const task of removed) {
    for (const hostId of new Set(task.chatHostIds ?? [])) {
      removedCounts.set(hostId, (removedCounts.get(hostId) ?? 0) + 1);
    }
  }
  if (removedCounts.size === 0) return current;
  return current.flatMap((facet) => {
    const count = facet.count - (removedCounts.get(facet.hostId) ?? 0);
    return count > 0 ? [{ hostId: facet.hostId, count }] : [];
  });
}

function reposFromTasks(
  tasks: ReadonlyArray<TaskLight>,
): ReadonlyArray<TaskRepoIdentifier> {
  return tasks.flatMap((task) =>
    uniqueBy(
      task.epic?.repos.flatMap((repo) =>
        repo.repoIdentifier === null ? [] : [repo.repoIdentifier],
      ) ?? [],
      formatRepoIdentifier,
    ),
  );
}

function workspacesFromTasks(
  tasks: ReadonlyArray<TaskLight>,
): ReadonlyArray<TaskWorkspaceIdentifier> {
  return tasks.flatMap((task) =>
    uniqueBy(
      task.epic?.workspaces.map((workspace) => ({
        hostId: workspace.hostId,
        workspacePath: workspace.workspacePath,
      })) ?? [],
      workspaceIdentifierKey,
    ),
  );
}

function ownershipScopesFromTasks(
  tasks: ReadonlyArray<TaskLight>,
  userId: string,
): ReadonlyArray<"mine" | "shared"> {
  return tasks.flatMap((task) => {
    const createdBy = task.epic?.light?.createdBy ?? null;
    if (createdBy === null) return [];
    return [createdBy === userId ? "mine" : "shared"];
  });
}

function decrementRepoFacets(
  current: ListTasksFacets["repos"],
  removed: ReadonlyArray<TaskRepoIdentifier>,
): ListTasksFacets["repos"] {
  return decrementFacets(current, removed.map(formatRepoIdentifier), (facet) =>
    formatRepoIdentifier(facet.repoIdentifier),
  );
}

function decrementWorkspaceFacets(
  current: ListTasksFacets["workspaces"],
  removed: ReadonlyArray<TaskWorkspaceIdentifier>,
): ListTasksFacets["workspaces"] {
  return decrementFacets(
    current,
    removed.map(workspaceIdentifierKey),
    (facet) => workspaceIdentifierKey(facet.workspaceIdentifier),
  );
}

function decrementOwnershipFacets(
  current: ListTasksFacets["ownershipScopes"],
  removed: ReadonlyArray<"mine" | "shared">,
): ListTasksFacets["ownershipScopes"] {
  return decrementFacets(current, removed, (facet) => facet.value);
}

function decrementFacets<TFacet extends { readonly count: number }>(
  current: ReadonlyArray<TFacet>,
  removedKeys: ReadonlyArray<string>,
  keyForFacet: (facet: TFacet) => string,
): TFacet[] {
  if (removedKeys.length === 0) return [...current];
  const decrementByKey = removedKeys.reduce((acc, key) => {
    acc.set(key, (acc.get(key) ?? 0) + 1);
    return acc;
  }, new Map<string, number>());
  return current.flatMap((facet) => {
    const nextCount =
      facet.count - (decrementByKey.get(keyForFacet(facet)) ?? 0);
    return nextCount > 0 ? [{ ...facet, count: nextCount }] : [];
  });
}

function uniqueBy<T>(
  values: ReadonlyArray<T>,
  keyForValue: (value: T) => string,
): ReadonlyArray<T> {
  return Array.from(
    new Map(values.map((value) => [keyForValue(value), value])).values(),
  );
}

function workspaceIdentifierKey(identifier: TaskWorkspaceIdentifier): string {
  return `${identifier.hostId}\x1f${identifier.workspacePath}`;
}
