import {
  useQueryClient,
  type QueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  ListTasksFacets,
  ListTasksResponse,
  ListTasksSort,
  TaskLight,
  TaskRepoIdentifier,
  TaskWorkspaceIdentifier,
} from "@traycer/protocol/host/epic/unary-schemas";
import {
  formatRepoIdentifier,
  listTasksRequestSchema,
} from "@traycer/protocol/host/epic/unary-schemas";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { hostQueryKeys } from "@/lib/query-keys";
import { cloudEpicTasksQueryKeyMatchesScope } from "@/lib/cloud-epic-tasks-query/cache";
import type { ListCloudTasksRequest } from "@/lib/cloud-epic-tasks-query";
import { toastFromHostError } from "@/lib/host-error-toast";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import { getOpenEpicRegistry } from "@/lib/registries/epic-session-registry";

interface CreateEpicMutationContext {
  readonly hostId: string | null;
  readonly userId: string | null;
}

export function useEpicCreate(): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "epic.create">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "epic.create">,
  CreateEpicMutationContext
> {
  const client = useHostClient();
  const queryClient = useQueryClient();
  return useHostMutation<
    HostRpcRegistry,
    "epic.create",
    CreateEpicMutationContext
  >({
    client,
    method: "epic.create",
    mapVariables: (variables) => variables,
    options: {
      onMutate: () => ({
        hostId: client.getActiveHostId(),
        userId: client.getRequestContextUserId(),
      }),
      onSuccess: (response, variables, ctx) => {
        Analytics.getInstance().track(AnalyticsEvent.TaskCreated, {
          mode: variables.chat?.initialMessage?.settings.agentMode ?? "regular",
        });
        if (ctx.hostId === null) return;
        // The new epic's workspace folders are seeded into the host's
        // warm-slot create context by `epic.create`, but the just-mounted
        // chat tile's `worktree.listBindingsForEpic` may have fetched before that
        // seed landed (and the chat flow has no follow-up worktree RPC to
        // refresh it, unlike the terminal-agent flow). Refetch now that the
        // epic exists so the workspace chip reflects the attached folders.
        void queryClient.invalidateQueries({
          queryKey: hostQueryKeys.methodScope(
            ctx.hostId,
            "worktree.listBindingsForEpic",
          ),
        });
        // Ingest the freshly-created TaskLight (returned by the cloud-side
        // create step) into the cached cloud-tasks history so the new epic
        // shows up in the history list immediately. The cloud query is
        // otherwise manual-refresh-only (`staleTime: Infinity`).
        if (ctx.userId === null) return;
        const task = response.task;
        if (task === null || task === undefined) return;
        patchCreatedTaskIntoCloudTaskCaches(queryClient, ctx, task);
      },
      onError: (error) => toastFromHostError(error, "Couldn't create epic."),
    },
  });
}

function patchCreatedTaskIntoCloudTaskCaches(
  queryClient: QueryClient,
  ctx: CreateEpicMutationContext,
  task: TaskLight,
): void {
  if (ctx.hostId === null || ctx.userId === null) return;
  const { hostId, userId } = ctx;
  for (const [
    queryKey,
    response,
  ] of queryClient.getQueriesData<ListTasksResponse>({
    predicate: (query) =>
      cloudEpicTasksQueryKeyMatchesScope(query.queryKey, { hostId, userId }),
  })) {
    const request = cloudEpicTasksRequestFromQueryKey(queryKey);
    if (response === undefined || request === null) continue;
    const next = mergeTaskIntoCloudTasksResponse(
      response,
      task,
      request,
      userId,
    );
    if (next === response) continue;
    queryClient.setQueryData<ListTasksResponse>(queryKey, next);
  }
}

function cloudEpicTasksRequestFromQueryKey(
  queryKey: readonly unknown[],
): ListCloudTasksRequest | null {
  const parsed = listTasksRequestSchema.safeParse(queryKey[3]);
  if (!parsed.success || parsed.data.cursor !== undefined) return null;
  const { cursor: _cursor, ...request } = parsed.data;
  return request;
}

function mergeTaskIntoCloudTasksResponse(
  response: ListTasksResponse,
  task: TaskLight,
  request: ListCloudTasksRequest,
  userId: string,
): ListTasksResponse {
  const incomingProjection = taskProjection(task);
  if (incomingProjection === null) return response;
  const existingTask = response.tasks.find(
    (existing) => taskProjection(existing)?.id === incomingProjection.id,
  );
  const taskToMerge = taskWithPreferredEpicTitle(task, existingTask);
  const projection = taskProjection(taskToMerge);
  if (projection === null) return response;
  if (!taskProjectionMatchesRequest(projection, request, userId)) {
    return response;
  }
  const tasks = response.tasks
    .filter((existing) => taskProjection(existing)?.id !== projection.id)
    .concat(taskToMerge)
    .sort((left, right) =>
      compareTaskLights(
        left,
        right,
        request.sort ?? "recent",
        normalizedQuery(request),
      ),
    );
  const facets =
    response.facets === undefined || existingTask !== undefined
      ? response.facets
      : mergeProjectionIntoFacets(response.facets, projection, userId);
  return { ...response, tasks, facets };
}

function taskProjectionMatchesRequest(
  projection: TaskProjection,
  request: ListCloudTasksRequest,
  userId: string,
): boolean {
  const filters = request.filters;
  if (filters === null) return true;
  if (
    filters.taskType !== undefined &&
    filters.taskType !== projection.taskType
  ) {
    return false;
  }
  const query = normalizedQuery(request);
  if (
    query !== null &&
    !projection.title.toLowerCase().includes(query) &&
    !projection.repoLabels.some((label) => label.toLowerCase().includes(query))
  ) {
    return false;
  }
  if (!matchesOwnershipFilter(projection.createdBy, userId, filters)) {
    return false;
  }
  if (!matchesRepoFilter(projection.repoLabels, filters)) {
    return false;
  }
  return matchesWorkspaceFilter(projection.workspaces, filters);
}

function mergeProjectionIntoFacets(
  facets: ListTasksFacets,
  projection: TaskProjection,
  userId: string,
): ListTasksFacets {
  const repos = incrementRepoFacets(facets.repos, projection.repoIdentifiers);
  const workspaces = incrementWorkspaceFacets(
    facets.workspaces,
    projection.workspaces,
  );
  const ownershipScopes = incrementOwnershipFacets(
    facets.ownershipScopes,
    projection.createdBy === userId ? "mine" : "shared",
  );
  if (
    repos === facets.repos &&
    workspaces === facets.workspaces &&
    ownershipScopes === facets.ownershipScopes
  ) {
    return facets;
  }
  return { repos, workspaces, ownershipScopes };
}

function incrementRepoFacets(
  current: ListTasksFacets["repos"],
  repoIdentifiers: readonly TaskRepoIdentifier[],
): ListTasksFacets["repos"] {
  if (repoIdentifiers.length === 0) return current;
  const counts = new Map(
    current.map((facet) => [
      formatRepoIdentifier(facet.repoIdentifier),
      facet.count,
    ]),
  );
  const identifiersByKey = new Map(
    current.map((facet) => [
      formatRepoIdentifier(facet.repoIdentifier),
      facet.repoIdentifier,
    ]),
  );
  for (const identifier of uniqueRepoIdentifiers(repoIdentifiers)) {
    const key = formatRepoIdentifier(identifier);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    identifiersByKey.set(key, identifier);
  }
  return Array.from(counts.entries())
    .flatMap(([key, count]) => {
      const repoIdentifier = identifiersByKey.get(key);
      return repoIdentifier === undefined ? [] : [{ repoIdentifier, count }];
    })
    .sort((left, right) =>
      formatRepoIdentifier(left.repoIdentifier).localeCompare(
        formatRepoIdentifier(right.repoIdentifier),
      ),
    );
}

function uniqueRepoIdentifiers(
  repoIdentifiers: readonly TaskRepoIdentifier[],
): readonly TaskRepoIdentifier[] {
  return Array.from(
    new Map(
      repoIdentifiers.map((identifier) => [
        formatRepoIdentifier(identifier),
        identifier,
      ]),
    ).values(),
  );
}

function incrementWorkspaceFacets(
  current: ListTasksFacets["workspaces"],
  workspaces: readonly TaskWorkspaceIdentifier[],
): ListTasksFacets["workspaces"] {
  if (workspaces.length === 0) return current;
  const counts = new Map(
    current.map((facet) => [
      workspaceIdentifierKey(facet.workspaceIdentifier),
      facet.count,
    ]),
  );
  const workspacesByKey = new Map(
    current.map((facet) => [
      workspaceIdentifierKey(facet.workspaceIdentifier),
      facet.workspaceIdentifier,
    ]),
  );
  for (const workspace of uniqueWorkspaces(workspaces)) {
    const key = workspaceIdentifierKey(workspace);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    workspacesByKey.set(key, workspace);
  }
  return Array.from(counts.entries())
    .flatMap(([key, count]) => {
      const workspaceIdentifier = workspacesByKey.get(key);
      return workspaceIdentifier === undefined
        ? []
        : [{ workspaceIdentifier, count }];
    })
    .sort((left, right) =>
      workspaceIdentifierKey(left.workspaceIdentifier).localeCompare(
        workspaceIdentifierKey(right.workspaceIdentifier),
      ),
    );
}

function uniqueWorkspaces(
  workspaces: readonly TaskWorkspaceIdentifier[],
): readonly TaskWorkspaceIdentifier[] {
  return Array.from(
    new Map(
      workspaces.map((workspace) => [
        workspaceIdentifierKey(workspace),
        workspace,
      ]),
    ).values(),
  );
}

type OwnershipFacetValue = ListTasksFacets["ownershipScopes"][number]["value"];

function incrementOwnershipFacets(
  current: ListTasksFacets["ownershipScopes"],
  value: OwnershipFacetValue,
): ListTasksFacets["ownershipScopes"] {
  if (!current.some((facet) => facet.value === value)) {
    return [...current, { value, count: 1 }].sort(
      (left, right) =>
        ownershipFacetRank(left.value) - ownershipFacetRank(right.value),
    );
  }
  return current.map((facet) =>
    facet.value === value ? { ...facet, count: facet.count + 1 } : facet,
  );
}

function ownershipFacetRank(value: OwnershipFacetValue): number {
  return value === "mine" ? 0 : 1;
}

function matchesOwnershipFilter(
  createdBy: string,
  userId: string,
  filters: NonNullable<ListCloudTasksRequest["filters"]>,
): boolean {
  const ownershipScopes = filters.ownershipScopes ?? [];
  if (ownershipScopes.length === 0) return true;
  const scope = createdBy === userId ? "mine" : "shared";
  return ownershipScopes.includes(scope);
}

function matchesRepoFilter(
  repoLabels: readonly string[],
  filters: NonNullable<ListCloudTasksRequest["filters"]>,
): boolean {
  const selectedLabels = repoFilterLabels(filters);
  if (selectedLabels.length === 0) return true;
  if (filters.repoMatchMode === "all") {
    return selectedLabels.every((label) => repoLabels.includes(label));
  }
  return selectedLabels.some((label) => repoLabels.includes(label));
}

function repoFilterLabels(
  filters: NonNullable<ListCloudTasksRequest["filters"]>,
): readonly string[] {
  const labels = new Set<string>();
  if (
    filters.repoIdentifier !== undefined &&
    filters.repoIdentifier.length > 0
  ) {
    labels.add(filters.repoIdentifier);
  }
  for (const identifier of filters.repoIdentifiers ?? []) {
    labels.add(formatRepoIdentifier(identifier));
  }
  return Array.from(labels);
}

function matchesWorkspaceFilter(
  workspaces: readonly TaskWorkspaceIdentifier[],
  filters: NonNullable<ListCloudTasksRequest["filters"]>,
): boolean {
  const selectedWorkspaces = workspaceFilters(filters);
  if (selectedWorkspaces.length === 0) return true;
  if (filters.workspaceMatchMode === "all") {
    return selectedWorkspaces.every((filter) =>
      workspaces.some((workspace) => workspaceMatchesFilter(workspace, filter)),
    );
  }
  return selectedWorkspaces.some((filter) =>
    workspaces.some((workspace) => workspaceMatchesFilter(workspace, filter)),
  );
}

interface WorkspaceFilter {
  readonly hostId: string | null;
  readonly workspacePath: string | null;
}

function workspaceFilters(
  filters: NonNullable<ListCloudTasksRequest["filters"]>,
): readonly WorkspaceFilter[] {
  const workspaces = new Map<string, WorkspaceFilter>();
  if (filters.hostId !== undefined || filters.workspacePath !== undefined) {
    const filter = {
      hostId: filters.hostId ?? null,
      workspacePath: filters.workspacePath ?? null,
    };
    workspaces.set(workspaceFilterKey(filter), filter);
  }
  for (const workspace of filters.workspaceIdentifiers ?? []) {
    const filter = {
      hostId: workspace.hostId,
      workspacePath: workspace.workspacePath,
    };
    workspaces.set(workspaceFilterKey(filter), filter);
  }
  return Array.from(workspaces.values());
}

function workspaceMatchesFilter(
  workspace: TaskWorkspaceIdentifier,
  filter: WorkspaceFilter,
): boolean {
  if (filter.hostId !== null && workspace.hostId !== filter.hostId) {
    return false;
  }
  if (
    filter.workspacePath !== null &&
    workspace.workspacePath !== filter.workspacePath
  ) {
    return false;
  }
  return true;
}

function workspaceFilterKey(filter: WorkspaceFilter): string {
  return `${filter.hostId ?? ""}\0${filter.workspacePath ?? ""}`;
}

function workspaceIdentifierKey(workspace: TaskWorkspaceIdentifier): string {
  return `${workspace.hostId}\0${workspace.workspacePath}`;
}

interface TaskProjection {
  readonly id: string;
  readonly taskType: "epic" | "phase";
  readonly title: string;
  readonly updatedAt: number;
  readonly createdBy: string;
  readonly repoIdentifiers: readonly TaskRepoIdentifier[];
  readonly repoLabels: readonly string[];
  readonly workspaces: readonly TaskWorkspaceIdentifier[];
}

function taskProjection(task: TaskLight): TaskProjection | null {
  const epic = task.epic?.light;
  if (epic !== null && epic !== undefined) {
    return {
      id: epic.id,
      taskType: "epic",
      title: epic.title,
      updatedAt: epic.updatedAt,
      createdBy: epic.createdBy,
      repoIdentifiers: taskRepoIdentifiers(task),
      repoLabels: taskRepoLabels(task),
      workspaces: taskWorkspaces(task),
    };
  }
  const phase = task.phase?.light;
  if (phase === null || phase === undefined) return null;
  return {
    id: phase.id,
    taskType: "phase",
    title: phase.title,
    updatedAt: phase.updatedAt,
    createdBy: phase.createdBy,
    repoIdentifiers: taskRepoIdentifiers(task),
    repoLabels: taskRepoLabels(task),
    workspaces: taskWorkspaces(task),
  };
}

function taskRepoIdentifiers(task: TaskLight): readonly TaskRepoIdentifier[] {
  const repos = task.epic?.repos ?? task.phase?.repos ?? [];
  return repos.flatMap((repo) =>
    repo.repoIdentifier === null ? [] : [repo.repoIdentifier],
  );
}

function taskRepoLabels(task: TaskLight): readonly string[] {
  return taskRepoIdentifiers(task).map(formatRepoIdentifier);
}

function taskWorkspaces(task: TaskLight): readonly TaskWorkspaceIdentifier[] {
  const workspaces = task.epic?.workspaces ?? task.phase?.workspaces ?? [];
  return workspaces.map((workspace) => ({
    hostId: workspace.hostId,
    workspacePath: workspace.workspacePath,
  }));
}

function compareTaskLights(
  left: TaskLight,
  right: TaskLight,
  sort: ListTasksSort,
  query: string | null,
): number {
  const leftProjection = taskProjection(left);
  const rightProjection = taskProjection(right);
  if (leftProjection === null || rightProjection === null) return 0;
  if (sort === "title-asc") {
    return (
      leftProjection.title.localeCompare(rightProjection.title) ||
      compareByRecent(leftProjection, rightProjection)
    );
  }
  if (sort === "title-desc") {
    return (
      rightProjection.title.localeCompare(leftProjection.title) ||
      compareByRecent(leftProjection, rightProjection)
    );
  }
  if (sort === "oldest") {
    return compareByOldest(leftProjection, rightProjection);
  }
  if (sort === "relevance" && query !== null) {
    return (
      relevanceScore(leftProjection, query) -
        relevanceScore(rightProjection, query) ||
      compareByRecent(leftProjection, rightProjection)
    );
  }
  return compareByRecent(leftProjection, rightProjection);
}

function compareByRecent(left: TaskProjection, right: TaskProjection): number {
  if (left.updatedAt > right.updatedAt) return -1;
  if (left.updatedAt < right.updatedAt) return 1;
  if (left.id > right.id) return -1;
  if (left.id < right.id) return 1;
  return 0;
}

function compareByOldest(left: TaskProjection, right: TaskProjection): number {
  if (left.updatedAt < right.updatedAt) return -1;
  if (left.updatedAt > right.updatedAt) return 1;
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}

function relevanceScore(task: TaskProjection, query: string): number {
  const title = task.title.toLowerCase();
  if (title.startsWith(query)) return 0;
  if (title.includes(query)) return 1;
  for (const label of task.repoLabels) {
    if (label.toLowerCase().startsWith(query)) return 2;
  }
  for (const label of task.repoLabels) {
    if (label.toLowerCase().includes(query)) return 3;
  }
  return 4;
}

function normalizedQuery(request: ListCloudTasksRequest): string | null {
  const query = request.filters?.query?.trim().toLowerCase();
  return query === undefined || query.length === 0 ? null : query;
}

function taskWithPreferredEpicTitle(
  task: TaskLight,
  existingTask: TaskLight | undefined,
): TaskLight {
  const epic = task.epic;
  const light = epic?.light;
  if (epic === null || epic === undefined) return task;
  if (light === null || light === undefined) return task;
  const title = liveOpenEpicTitle(light.id) ?? cachedEpicTitle(existingTask);
  if (title === null || title === light.title) return task;
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

function cachedEpicTitle(task: TaskLight | undefined): string | null {
  const title = task?.epic?.light?.title;
  return title === undefined || title.trim().length === 0 ? null : title;
}

function liveOpenEpicTitle(epicId: string): string | null {
  const handle = getOpenEpicRegistry().peek(epicId);
  if (handle === null) return null;
  const title = handle.store.getState().epic.title.trim();
  return title.length > 0 ? title : null;
}
