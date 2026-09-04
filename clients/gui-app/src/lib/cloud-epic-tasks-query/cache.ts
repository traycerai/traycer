import type { Query, QueryClient } from "@tanstack/react-query";
import type {
  GetTaskContextsResponse,
  ListTaskLight,
  ListTasksResponse,
  TaskContextResult,
} from "@traycer/protocol/host/epic/unary-schemas";
import { isFoundTaskContext } from "@traycer/protocol/host/epic/unary-schemas";
import {
  deletedCloudEpicTasksPageEpicIdsForScope,
  invalidateCloudEpicTasksPagesForDeletedEpics,
} from "@/stores/epics/cloud-epic-tasks-pages-store";
import {
  isCloudEpicTasksQueryKey,
  isEpicTaskContextsQueryKey,
  queryKeys,
} from "@/lib/query-keys";
import {
  removeDeletedEpicsFromCloudTasksResponse,
  setEpicLocalHomeInCloudTasksResponse,
  setEpicPinnedInCloudTasksResponse,
} from "@/lib/cloud-epic-tasks-query/response-patches";

export {
  removeDeletedEpicsFromCloudTasksResponse,
  setEpicLocalHomeInCloudTasksResponse,
  setEpicPinnedInCloudTasksResponse,
} from "@/lib/cloud-epic-tasks-query/response-patches";

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
  // The retained-page store owns both cursor generations and the durable
  // session tombstones that it applies inside `appendPage`. This one call
  // removes already-retained rows, rejects requests that started before this
  // delete, and filters cursor requests that start after it.
  invalidateCloudEpicTasksPagesForDeletedEpics(
    scope.hostId,
    scope.userId,
    epicIds,
  );
  for (const [
    queryKey,
    response,
  ] of queryClient.getQueriesData<ListTasksResponse>({
    predicate: (query) =>
      cloudEpicTasksQueryKeyMatchesScope(query.queryKey, scope) ||
      cloudEpicTasksLastKnownQueryKeyMatchesScope(query.queryKey, scope),
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

/**
 * Admission for list-specific History first-page deliveries and the settled
 * fallback writer. The primary Query repeats this ledger at TanStack's cache
 * write boundary so a delete landing after early delivery cannot resurrect a
 * row. Generic host RPC APIs are intentionally outside this module's scope;
 * production callers of this History delivery path use the admitted helpers.
 */
export function admitCloudEpicTasksFirstPage(
  response: ListTasksResponse,
  scope: CloudEpicTasksCacheScope,
): ListTasksResponse {
  return removeDeletedEpicsFromCloudTasksResponse(
    response,
    deletedCloudEpicTasksPageEpicIdsForScope(scope.hostId, scope.userId),
    scope.userId,
  );
}

/** Writes a settled fallback through the same first-page admission boundary. */
export function writeCloudEpicTasksLastKnown(
  queryClient: QueryClient,
  scope: { readonly hostId: string; readonly userId: string },
  response: ListTasksResponse,
): void {
  queryClient.setQueryData<ListTasksResponse>(
    queryKeys.cloudEpicTasksLastKnown(scope.hostId, scope.userId),
    admitCloudEpicTasksFirstPage(response, scope),
  );
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
  // Batch-title entries (`epic.getTaskContexts`) are a second copy of the same
  // ListTaskLight rows. Patch them in the same write so rename never leaves a
  // stale owner chip in Settings ▸ Worktrees.
  updateEpicTitleInTaskContextsCaches(
    queryClient,
    scope,
    epicId,
    normalizedTitle,
  );
}

/**
 * Patches every matching `epic.getTaskContexts` cache entry for `epicId`.
 * Invoked from `updateEpicTitleInCloudTaskCaches` so all rename call sites
 * keep both cache families coherent without a second call.
 */
export function updateEpicTitleInTaskContextsCaches(
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
  ] of queryClient.getQueriesData<GetTaskContextsResponse>({
    predicate: (query) =>
      epicTaskContextsQueryKeyMatchesScope(query.queryKey, scope),
  })) {
    if (response === undefined) continue;
    const next = updateEpicTitleInTaskContextsResponse(
      response,
      epicId,
      normalizedTitle,
    );
    if (next === response) continue;
    queryClient.setQueryData<GetTaskContextsResponse>(queryKey, next);
  }
}

export function setEpicPinnedInCloudTaskCaches(
  queryClient: QueryClient,
  scope: CloudEpicTasksCacheScope,
  epicId: string,
  pinned: boolean,
): void {
  patchMatchingQueries(
    queryClient,
    (query) => cloudEpicTasksQueryKeyMatchesScope(query.queryKey, scope),
    (response: ListTasksResponse) =>
      setEpicPinnedInCloudTasksResponse(response, epicId, pinned),
  );
  setEpicPinnedInTaskContextsCaches(queryClient, scope, epicId, pinned);
}

export function setEpicPinnedInTaskContextsCaches(
  queryClient: QueryClient,
  scope: CloudEpicTasksCacheScope,
  epicId: string,
  pinned: boolean,
): void {
  patchMatchingQueries(
    queryClient,
    (query) => epicTaskContextsQueryKeyMatchesScope(query.queryKey, scope),
    (response: GetTaskContextsResponse) =>
      setEpicPinnedInTaskContextsResponse(response, epicId, pinned),
  );
}

/**
 * Keeps the cached `home` marker in step with what the epic's own stream says
 * - `s4-promotion-task-list-invalidation`.
 *
 * `epic.listTasks` is `staleTime: Infinity` and manual-refresh-only, so a row's
 * `home` is frozen at whatever the page said when it loaded. Two writes made
 * that stale on purpose:
 *
 *  - `epic.create` patches its returned `TaskLight` straight into the cache,
 *    and that type has nowhere to carry `home` - so a local-first epic entered
 *    the list looking cloud-backed from the instant it was created.
 *  - promotion completing flips the epic to cloud-durable, and nothing told
 *    the list; the row kept `home: "local"`.
 *
 * Both surface the same way: History offers (or withholds) the cloud-only pin
 * action for a row whose real home is the opposite, and pin is one of the
 * mutations that patches this cache - so using it cannot self-heal the marker.
 * The open epic's `cloudSyncStatus` frames are the authority the list lacks.
 */
export function setEpicLocalHomeInCloudTaskCaches(
  queryClient: QueryClient,
  scope: CloudEpicTasksCacheScope,
  epicId: string,
  localHome: boolean,
): void {
  patchMatchingQueries(
    queryClient,
    (query) =>
      cloudEpicTasksQueryKeyMatchesScope(query.queryKey, scope) ||
      cloudEpicTasksLastKnownQueryKeyMatchesScope(query.queryKey, scope),
    (response: ListTasksResponse) =>
      setEpicLocalHomeInCloudTasksResponse(response, epicId, localHome),
  );
}

function patchMatchingQueries<TResponse>(
  queryClient: QueryClient,
  predicate: (query: Query) => boolean,
  patch: (response: TResponse) => TResponse,
): void {
  for (const [queryKey, response] of queryClient.getQueriesData<TResponse>({
    predicate,
  })) {
    if (response === undefined) continue;
    const next = patch(response);
    if (next === response) continue;
    queryClient.setQueryData<TResponse>(queryKey, next);
  }
}

function setEpicPinnedInTaskContextsResponse(
  response: GetTaskContextsResponse,
  epicId: string,
  pinned: boolean,
): GetTaskContextsResponse {
  const entry = Object.entries(response.tasks).find(
    ([, resolution]) =>
      isFoundTaskContext(resolution) &&
      resolution.task.epic?.light?.id === epicId,
  );
  if (entry === undefined) return response;
  const [taskId, resolution] = entry;
  if (
    !isFoundTaskContext(resolution) ||
    (resolution.task.pinned ?? false) === pinned
  ) {
    return response;
  }
  return {
    ...response,
    tasks: {
      ...response.tasks,
      [taskId]: {
        ...resolution,
        task: { ...resolution.task, pinned },
      },
    },
  };
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

function cloudEpicTasksLastKnownQueryKeyMatchesScope(
  queryKey: readonly unknown[],
  scope: CloudEpicTasksCacheScope,
): boolean {
  return (
    queryKey[0] === "host" &&
    (scope.hostId === null || queryKey[1] === scope.hostId) &&
    queryKey[2] === "cloud.listTasks.lastKnown" &&
    queryKey[3] === scope.userId
  );
}

export function cloudEpicTasksLastViewedQueryKeyMatchesScope(
  queryKey: readonly unknown[],
  scope: CloudEpicTasksCacheScope,
): boolean {
  if (!cloudEpicTasksQueryKeyMatchesScope(queryKey, scope)) return false;
  const request = queryKey[3];
  return (
    request !== null &&
    typeof request === "object" &&
    "sort" in request &&
    request.sort === "last-viewed"
  );
}

/**
 * Scope match for `epic.getTaskContexts` keys:
 * `["host", hostId, "epic.getTaskContexts", { taskIds }, userId]`.
 */
export function epicTaskContextsQueryKeyMatchesScope(
  queryKey: readonly unknown[],
  scope: CloudEpicTasksCacheScope,
): boolean {
  return (
    isEpicTaskContextsQueryKey(queryKey) &&
    (scope.hostId === null || queryKey[1] === scope.hostId) &&
    queryKey[4] === scope.userId
  );
}

function updateEpicTitleInCloudTasksResponse(
  response: ListTasksResponse,
  epicId: string,
  title: string,
): ListTasksResponse {
  const tasks = response.tasks.map((task) => {
    const next = updateEpicTitleInListTaskLight(task, epicId, title);
    return next ?? task;
  });
  const changed = tasks.some((task, index) => task !== response.tasks[index]);
  return changed ? { ...response, tasks } : response;
}

function updateEpicTitleInTaskContextsResponse(
  response: GetTaskContextsResponse,
  epicId: string,
  title: string,
): GetTaskContextsResponse {
  let changed = false;
  const tasks: Record<string, TaskContextResult> = {};
  for (const [taskId, resolution] of Object.entries(response.tasks)) {
    if (!isFoundTaskContext(resolution)) {
      tasks[taskId] = resolution;
      continue;
    }
    const next = updateEpicTitleInListTaskLight(resolution.task, epicId, title);
    if (next === null) {
      tasks[taskId] = resolution;
      continue;
    }
    changed = true;
    tasks[taskId] = { ...resolution, task: next };
  }
  return changed ? { ...response, tasks } : response;
}

/**
 * Returns a new row with the epic title updated, or `null` when the row does
 * not carry `epicId` / already has `title` (identity-preserving skip).
 */
function updateEpicTitleInListTaskLight(
  task: ListTaskLight,
  epicId: string,
  title: string,
): ListTaskLight | null {
  const epic = task.epic;
  const light = epic?.light;
  if (epic === null || epic === undefined) return null;
  if (light === null || light === undefined) return null;
  if (light.id !== epicId || light.title === title) return null;
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
}

function normalizeEpicTitle(title: string): string | null {
  const trimmed = title.trim();
  return trimmed.length > 0 ? trimmed : null;
}
