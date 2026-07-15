import type { QueryClient } from "@tanstack/react-query";
import type {
  ListTasksFacets,
  ListTasksResponse,
  TaskLight,
  TaskRepoIdentifier,
  TaskWorkspaceIdentifier,
} from "@traycer/protocol/host/epic/unary-schemas";
import { formatRepoIdentifier } from "@traycer/protocol/host/epic/unary-schemas";
import { isCloudEpicTasksQueryKey } from "@/lib/query-keys";

export interface CloudEpicTasksCacheScope {
  readonly hostId: string | null;
  readonly userId: string;
}

export function removeDeletedEpicsFromCloudTaskCaches(
  queryClient: QueryClient,
  scope: CloudEpicTasksCacheScope,
  epicIds: ReadonlyArray<string>,
): void {
  const deletedEpicIds = new Set(epicIds);
  if (deletedEpicIds.size === 0) return;
  for (const [
    queryKey,
    response,
  ] of queryClient.getQueriesData<ListTasksResponse>({
    predicate: (query) =>
      cloudEpicTasksQueryKeyMatchesScope(query.queryKey, scope),
  })) {
    if (response === undefined) continue;
    const next = removeDeletedEpicsFromCloudTasksResponse(
      response,
      deletedEpicIds,
      scope.userId,
    );
    if (next === response) continue;
    queryClient.setQueryData<ListTasksResponse>(queryKey, next);
  }
}

export function readEpicTitlesFromCloudTaskCaches(
  queryClient: QueryClient,
  scope: CloudEpicTasksCacheScope,
  epicIds: ReadonlyArray<string>,
): Record<string, string> {
  const targetEpicIds = new Set(epicIds);
  if (targetEpicIds.size === 0) return {};
  const titles: Record<string, string> = {};
  for (const [, response] of queryClient.getQueriesData<ListTasksResponse>({
    predicate: (query) =>
      cloudEpicTasksQueryKeyMatchesScope(query.queryKey, scope),
  })) {
    if (response === undefined) continue;
    for (const task of response.tasks) {
      const light = task.epic?.light;
      if (light === null || light === undefined) continue;
      if (!targetEpicIds.has(light.id)) continue;
      if (Object.hasOwn(titles, light.id)) continue;
      const title = normalizeEpicTitle(light.title);
      if (title === null) continue;
      titles[light.id] = title;
    }
  }
  return titles;
}

export function updateEpicTitleInCloudTaskCaches(
  queryClient: QueryClient,
  scope: CloudEpicTasksCacheScope,
  epicId: string,
  title: string,
): void {
  const normalizedTitle = normalizeEpicTitle(title);
  if (normalizedTitle === null) return;
  for (const [
    queryKey,
    response,
  ] of queryClient.getQueriesData<ListTasksResponse>({
    predicate: (query) =>
      cloudEpicTasksQueryKeyMatchesScope(query.queryKey, scope),
  })) {
    if (response === undefined) continue;
    const next = updateEpicTitleInCloudTasksResponse(
      response,
      epicId,
      normalizedTitle,
    );
    if (next === response) continue;
    queryClient.setQueryData<ListTasksResponse>(queryKey, next);
  }
}

export function setEpicPinnedInCloudTaskCaches(
  queryClient: QueryClient,
  scope: CloudEpicTasksCacheScope,
  epicId: string,
  pinned: boolean,
): void {
  for (const [
    queryKey,
    response,
  ] of queryClient.getQueriesData<ListTasksResponse>({
    predicate: (query) =>
      cloudEpicTasksQueryKeyMatchesScope(query.queryKey, scope),
  })) {
    if (response === undefined) continue;
    const next = setEpicPinnedInCloudTasksResponse(response, epicId, pinned);
    if (next === response) continue;
    queryClient.setQueryData<ListTasksResponse>(queryKey, next);
  }
}

/**
 * Identity-preserving per-row pin patch: returns the same response reference
 * when the epic is absent or already carries the requested pin state. Shared
 * with the pages store so the cached first page and the accumulated "Show
 * more" tails patch identically.
 */
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

export function cloudEpicTasksQueryKeyMatchesScope(
  queryKey: readonly unknown[],
  scope: CloudEpicTasksCacheScope,
): boolean {
  return (
    isCloudEpicTasksQueryKey(queryKey) &&
    queryKey[0] === "host" &&
    (scope.hostId === null || queryKey[1] === scope.hostId) &&
    queryKey[5] === scope.userId
  );
}

function removeDeletedEpicsFromCloudTasksResponse(
  response: ListTasksResponse,
  deletedEpicIds: ReadonlySet<string>,
  userId: string,
): ListTasksResponse {
  const removedTasks = response.tasks.filter((task) =>
    deletedEpicIds.has(task.epic?.light?.id ?? ""),
  );
  if (removedTasks.length === 0) return response;
  const tasks = response.tasks.filter(
    (task) => !deletedEpicIds.has(task.epic?.light?.id ?? ""),
  );
  return {
    ...response,
    tasks,
    facets:
      response.facets === undefined
        ? undefined
        : removeTasksFromFacets(response.facets, removedTasks, userId),
  };
}

function updateEpicTitleInCloudTasksResponse(
  response: ListTasksResponse,
  epicId: string,
  title: string,
): ListTasksResponse {
  const tasks = response.tasks.map((task) => {
    const epic = task.epic;
    const light = epic?.light;
    if (epic === null || epic === undefined) return task;
    if (light === null || light === undefined) return task;
    if (light.id !== epicId || light.title === title) return task;
    return {
      ...task,
      epic: {
        ...epic,
        light: {
          ...light,
          title,
        },
      },
    };
  });
  const changed = tasks.some((task, index) => task !== response.tasks[index]);
  return changed ? { ...response, tasks } : response;
}

function removeTasksFromFacets(
  facets: ListTasksFacets,
  tasks: ReadonlyArray<TaskLight>,
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
  };
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

function normalizeEpicTitle(title: string): string | null {
  const trimmed = title.trim();
  return trimmed.length > 0 ? trimmed : null;
}
