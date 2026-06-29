import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ListTasksResponse,
  TaskLight,
} from "@traycer/protocol/host/epic/unary-schemas";
import {
  LIST_CLOUD_TASKS_REQUEST,
  cloudEpicTasksQueryKey,
  type ListCloudTasksRequest,
} from "@/lib/cloud-epic-tasks-query";
import { useEpicCreate } from "@/hooks/epic/use-epic-create-mutation";

interface TaskWorkspaceInput {
  readonly hostId: string;
  readonly workspacePath: string;
}

interface MakeTaskInput {
  readonly id: string;
  readonly title: string;
  readonly createdBy: string;
  readonly updatedAt: number;
  readonly repos: readonly string[];
  readonly workspaces: readonly TaskWorkspaceInput[];
}

interface CreateEpicMutationContext {
  readonly hostId: string | null;
  readonly userId: string | null;
}

interface CapturedCreateOptions {
  readonly onMutate: () => CreateEpicMutationContext;
  readonly onSuccess: (
    response: { readonly task: TaskLight | null | undefined },
    variables: Record<string, never>,
    ctx: CreateEpicMutationContext,
  ) => void;
}

const testState = vi.hoisted(() => ({
  activeHostId: "host-1",
  requestContextUserId: "user-1",
  capturedOptions: null as CapturedCreateOptions | null,
}));

vi.mock("@/lib/host", () => ({
  useHostClient: () => ({
    getActiveHostId: () => testState.activeHostId,
    getRequestContextUserId: () => testState.requestContextUserId,
  }),
}));

vi.mock("@/hooks/host/use-host-query", () => ({
  useHostMutation: (args: { readonly options: CapturedCreateOptions }) => {
    testState.capturedOptions = args.options;
    return { mutate: vi.fn(), isPending: false };
  },
}));

vi.mock("@/lib/host-error-toast", () => ({
  toastFromHostError: vi.fn(),
}));

function makeWrapper(
  queryClient: QueryClient,
): ({ children }: { readonly children: ReactNode }) => ReactNode {
  return ({ children }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

function makeTask(input: MakeTaskInput): TaskLight {
  return {
    epic: {
      light: {
        id: input.id,
        title: input.title,
        initialUserPrompt: "",
        ticketCount: 0,
        specCount: 0,
        storyCount: 0,
        reviewCount: 0,
        status: "draft",
        createdAt: input.updatedAt,
        updatedAt: input.updatedAt,
        createdBy: input.createdBy,
        version: "1",
      },
      permission: null,
      repos: input.repos.map((repo) => {
        const [owner, repoName] = repo.split("/");
        return {
          task: { taskId: input.id, taskType: "epic" as const },
          repoIdentifier: {
            owner,
            repo: repoName,
          },
          createdAt: input.updatedAt,
          createdBy: input.createdBy,
        };
      }),
      workspaces: input.workspaces.map((workspace) => ({
        task: { taskId: input.id, taskType: "epic" as const },
        hostId: workspace.hostId,
        workspacePath: workspace.workspacePath,
        createdAt: input.updatedAt,
      })),
      roomInfo: null,
    },
    phase: null,
  };
}

function taskIds(response: ListTasksResponse | undefined): readonly string[] {
  return response?.tasks.map((task) => task.epic?.light?.id ?? "") ?? [];
}

function repoFacetLabels(
  response: ListTasksResponse | undefined,
): readonly string[] {
  return (
    response?.facets?.repos.map(
      (facet) => `${facet.repoIdentifier.owner}/${facet.repoIdentifier.repo}`,
    ) ?? []
  );
}

describe("useEpicCreate", () => {
  beforeEach(() => {
    testState.activeHostId = "host-1";
    testState.requestContextUserId = "user-1";
    testState.capturedOptions = null;
  });

  it("patches every matching cloud task cache for the active host and user", () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const defaultRequest: ListCloudTasksRequest = LIST_CLOUD_TASKS_REQUEST;
    const mineRequest: ListCloudTasksRequest = {
      ...LIST_CLOUD_TASKS_REQUEST,
      filters: { ownershipScopes: ["mine"] },
    };
    const sharedRequest: ListCloudTasksRequest = {
      ...LIST_CLOUD_TASKS_REQUEST,
      filters: { ownershipScopes: ["shared"] },
    };
    const queryRequest: ListCloudTasksRequest = {
      ...LIST_CLOUD_TASKS_REQUEST,
      filters: { query: "unmatched" },
      sort: "relevance",
    };
    const oldTask = makeTask({
      id: "old",
      title: "Old epic",
      createdBy: "user-1",
      updatedAt: 1,
      repos: [],
      workspaces: [],
    });
    const createdTask = makeTask({
      id: "new",
      title: "New epic",
      createdBy: "user-1",
      updatedAt: 2,
      repos: [],
      workspaces: [],
    });

    for (const request of [
      defaultRequest,
      mineRequest,
      sharedRequest,
      queryRequest,
    ]) {
      queryClient.setQueryData<ListTasksResponse>(
        cloudEpicTasksQueryKey("host-1", "user-1", request),
        { tasks: [oldTask], hasMore: false },
      );
    }

    renderHook(() => useEpicCreate(), { wrapper: makeWrapper(queryClient) });
    const options = testState.capturedOptions;
    if (options === null) throw new Error("expected mutation options");

    options.onSuccess({ task: createdTask }, {}, options.onMutate());

    expect(
      taskIds(
        queryClient.getQueryData(
          cloudEpicTasksQueryKey("host-1", "user-1", defaultRequest),
        ),
      ),
    ).toEqual(["new", "old"]);
    expect(
      taskIds(
        queryClient.getQueryData(
          cloudEpicTasksQueryKey("host-1", "user-1", mineRequest),
        ),
      ),
    ).toEqual(["new", "old"]);
    expect(
      taskIds(
        queryClient.getQueryData(
          cloudEpicTasksQueryKey("host-1", "user-1", sharedRequest),
        ),
      ),
    ).toEqual(["old"]);
    expect(
      taskIds(
        queryClient.getQueryData(
          cloudEpicTasksQueryKey("host-1", "user-1", queryRequest),
        ),
      ),
    ).toEqual(["old"]);
  });

  it("patches cached facets only when the created task matches the cache request", () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const defaultRequest: ListCloudTasksRequest = LIST_CLOUD_TASKS_REQUEST;
    const repoFilteredRequest: ListCloudTasksRequest = {
      ...LIST_CLOUD_TASKS_REQUEST,
      filters: {
        repoIdentifiers: [{ owner: "traycer", repo: "gui-app" }],
        repoMatchMode: "any",
      },
    };
    const oldTask = makeTask({
      id: "old",
      title: "Old epic",
      createdBy: "user-1",
      updatedAt: 1,
      repos: ["traycer/gui-app"],
      workspaces: [],
    });
    const createdTask = makeTask({
      id: "new",
      title: "New epic",
      createdBy: "user-1",
      updatedAt: 2,
      repos: ["traycer/host"],
      workspaces: [{ hostId: "host-1", workspacePath: "/Users/me/host" }],
    });
    const initialFacets: NonNullable<ListTasksResponse["facets"]> = {
      repos: [
        {
          repoIdentifier: { owner: "traycer", repo: "gui-app" },
          count: 1,
        },
      ],
      workspaces: [],
      ownershipScopes: [
        { value: "mine", count: 1 },
        { value: "shared", count: 0 },
      ],
    };

    queryClient.setQueryData<ListTasksResponse>(
      cloudEpicTasksQueryKey("host-1", "user-1", defaultRequest),
      { tasks: [oldTask], hasMore: false, facets: initialFacets },
    );
    queryClient.setQueryData<ListTasksResponse>(
      cloudEpicTasksQueryKey("host-1", "user-1", repoFilteredRequest),
      { tasks: [oldTask], hasMore: false, facets: initialFacets },
    );

    renderHook(() => useEpicCreate(), { wrapper: makeWrapper(queryClient) });
    const options = testState.capturedOptions;
    if (options === null) throw new Error("expected mutation options");

    options.onSuccess({ task: createdTask }, {}, options.onMutate());

    const defaultResponse = queryClient.getQueryData<ListTasksResponse>(
      cloudEpicTasksQueryKey("host-1", "user-1", defaultRequest),
    );
    expect(taskIds(defaultResponse)).toEqual(["new", "old"]);
    expect(repoFacetLabels(defaultResponse)).toEqual([
      "traycer/gui-app",
      "traycer/host",
    ]);
    expect(defaultResponse?.facets?.workspaces).toEqual([
      {
        workspaceIdentifier: {
          hostId: "host-1",
          workspacePath: "/Users/me/host",
        },
        count: 1,
      },
    ]);
    expect(defaultResponse?.facets?.ownershipScopes).toEqual([
      { value: "mine", count: 2 },
      { value: "shared", count: 0 },
    ]);

    const repoFilteredResponse = queryClient.getQueryData<ListTasksResponse>(
      cloudEpicTasksQueryKey("host-1", "user-1", repoFilteredRequest),
    );
    expect(taskIds(repoFilteredResponse)).toEqual(["old"]);
    expect(repoFacetLabels(repoFilteredResponse)).toEqual(["traycer/gui-app"]);
    expect(repoFilteredResponse?.facets?.workspaces).toEqual([]);
    expect(repoFilteredResponse?.facets?.ownershipScopes).toEqual([
      { value: "mine", count: 1 },
      { value: "shared", count: 0 },
    ]);
  });

  it("preserves an existing generated title when the live epic session is gone", () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const cachedGeneratedTask = makeTask({
      id: "new",
      title: "Generated history title",
      createdBy: "user-1",
      updatedAt: 2,
      repos: [],
      workspaces: [],
    });
    const staleCreateResponseTask = makeTask({
      id: "new",
      title: "Initial user prompt",
      createdBy: "user-1",
      updatedAt: 2,
      repos: [],
      workspaces: [],
    });
    const queryKey = cloudEpicTasksQueryKey(
      "host-1",
      "user-1",
      LIST_CLOUD_TASKS_REQUEST,
    );
    queryClient.setQueryData<ListTasksResponse>(queryKey, {
      tasks: [cachedGeneratedTask],
      hasMore: false,
    });

    renderHook(() => useEpicCreate(), { wrapper: makeWrapper(queryClient) });
    const options = testState.capturedOptions;
    if (options === null) throw new Error("expected mutation options");

    options.onSuccess(
      { task: staleCreateResponseTask },
      {},
      options.onMutate(),
    );

    expect(
      queryClient.getQueryData<ListTasksResponse>(queryKey)?.tasks[0]?.epic
        ?.light?.title,
    ).toBe("Generated history title");
  });
});
