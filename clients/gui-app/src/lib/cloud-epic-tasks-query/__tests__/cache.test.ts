import { queryOptions, QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it } from "vitest";
import type {
  GetTaskContextsResponse,
  ListTaskLight,
  ListTasksResponse,
  TaskLight,
} from "@traycer/protocol/host/epic/unary-schemas";
import { isFoundTaskContext } from "@traycer/protocol/host/epic/unary-schemas";
import {
  LIST_CLOUD_TASKS_REQUEST,
  cloudEpicTasksFirstPageQueryOptions,
  cloudEpicTasksLastKnownQueryKey,
  cloudEpicTasksQueryKey,
} from "@/lib/cloud-epic-tasks-query";
import {
  readEpicTitlesFromCloudTaskCaches,
  removeDeletedEpicsFromCloudTaskCaches,
  setEpicLocalHomeInCloudTaskCaches,
  setEpicPinnedInCloudTaskCaches,
  updateEpicTitleInCloudTaskCaches,
  updateEpicTitleInTaskContextsCaches,
  writeCloudEpicTasksLastKnown,
} from "@/lib/cloud-epic-tasks-query/cache";
import { hostQueryKeys } from "@/lib/query-keys";
import {
  cloudEpicTasksPageGeneration,
  cloudEpicTasksPageIdentity,
  useCloudEpicTasksPagesStore,
} from "@/stores/epics/cloud-epic-tasks-pages-store";

describe("removeDeletedEpicsFromCloudTaskCaches", () => {
  beforeEach(() => {
    useCloudEpicTasksPagesStore.setState({
      pagesByIdentity: {},
      generationByIdentity: {},
      deletedEpicIdsByScope: {},
    });
  });

  it("removes a local-home row without decrementing the cloud facets", () => {
    // The facets are the CLOUD's aggregate: a `home: "local"` row is
    // host-synthesized and prepended, never counted there. RED before the fix:
    // removing it decremented the facet of a cloud epic that shares its repo,
    // so that cloud epic's count under-read by one.
    const queryClient = new QueryClient();
    const key = cloudEpicTasksQueryKey(
      "host-a",
      "user-1",
      LIST_CLOUD_TASKS_REQUEST,
    );
    const facets: ListTasksResponse["facets"] = {
      repos: [
        { repoIdentifier: { owner: "traycer", repo: "gui-app" }, count: 1 },
      ],
      workspaces: [],
      ownershipScopes: [{ value: "mine", count: 1 }],
    };
    queryClient.setQueryData<ListTasksResponse>(key, {
      tasks: [
        {
          ...taskLight("epic-local", "Local", "traycer/gui-app", "user-1"),
          home: "local",
        },
        taskLight("epic-cloud", "Cloud", "traycer/gui-app", "user-1"),
      ],
      hasMore: false,
      facets,
    });

    removeDeletedEpicsFromCloudTaskCaches(
      queryClient,
      { hostId: null, userId: "user-1" },
      ["epic-local"],
    );

    const after = queryClient.getQueryData<ListTasksResponse>(key);
    expect(after?.tasks.map((task) => task.epic?.light?.id)).toEqual([
      "epic-cloud",
    ]);
    expect(after?.facets).toEqual(facets);
  });

  it("removes deleted epic rows and decrements facets for matching user caches", () => {
    const queryClient = new QueryClient();
    const matchingKey = cloudEpicTasksQueryKey(
      "host-a",
      "user-1",
      LIST_CLOUD_TASKS_REQUEST,
    );
    const otherUserKey = cloudEpicTasksQueryKey(
      "host-a",
      "user-2",
      LIST_CLOUD_TASKS_REQUEST,
    );
    queryClient.setQueryData<ListTasksResponse>(matchingKey, {
      tasks: [
        taskLight("epic-a", "Alpha", "traycer/gui-app", "user-1"),
        taskLight("epic-b", "Beta", "traycer/server", "user-1"),
      ],
      hasMore: false,
      facets: {
        repos: [
          {
            repoIdentifier: { owner: "traycer", repo: "gui-app" },
            count: 1,
          },
          { repoIdentifier: { owner: "traycer", repo: "server" }, count: 1 },
        ],
        workspaces: [
          {
            workspaceIdentifier: {
              hostId: "host-a",
              workspacePath: "/repo/gui-app",
            },
            count: 1,
          },
          {
            workspaceIdentifier: {
              hostId: "host-a",
              workspacePath: "/repo/server",
            },
            count: 1,
          },
        ],
        ownershipScopes: [{ value: "mine", count: 2 }],
      },
    });
    queryClient.setQueryData<ListTasksResponse>(otherUserKey, {
      tasks: [taskLight("epic-a", "Alpha", "traycer/gui-app", "user-1")],
      hasMore: false,
    });

    removeDeletedEpicsFromCloudTaskCaches(
      queryClient,
      { hostId: null, userId: "user-1" },
      ["epic-a"],
    );

    const matching = queryClient.getQueryData<ListTasksResponse>(matchingKey);
    expect(matching?.tasks.map((task) => task.epic?.light?.id)).toEqual([
      "epic-b",
    ]);
    expect(matching?.facets).toEqual({
      repos: [
        { repoIdentifier: { owner: "traycer", repo: "server" }, count: 1 },
      ],
      workspaces: [
        {
          workspaceIdentifier: {
            hostId: "host-a",
            workspacePath: "/repo/server",
          },
          count: 1,
        },
      ],
      ownershipScopes: [{ value: "mine", count: 1 }],
    });
    expect(
      queryClient.getQueryData<ListTasksResponse>(otherUserKey)?.tasks,
    ).toHaveLength(1);
  });

  it("keeps the chat-host facet group when deleting, decrementing its counts", () => {
    // The group's PRESENCE is a sentinel: `useHistoryQuery` reads a missing
    // `chatHosts` as proof the server never applied the host filter and
    // withholds every row. Rebuilding facets without it would strand a
    // host-filtered list in "can't filter by host here" - permanently, since
    // these entries never refetch on their own.
    const queryClient = new QueryClient();
    const key = cloudEpicTasksQueryKey(
      "host-a",
      "user-1",
      LIST_CLOUD_TASKS_REQUEST,
    );
    queryClient.setQueryData<ListTasksResponse>(key, {
      tasks: [
        {
          ...taskLight("epic-a", "Alpha", "traycer/gui-app", "user-1"),
          chatHostIds: ["host-a", "host-b"],
        },
        {
          ...taskLight("epic-b", "Beta", "traycer/server", "user-1"),
          chatHostIds: ["host-b"],
        },
      ],
      hasMore: false,
      facets: {
        repos: [],
        workspaces: [],
        ownershipScopes: [{ value: "mine", count: 2 }],
        chatHosts: [
          { hostId: "host-a", count: 1 },
          { hostId: "host-b", count: 2 },
        ],
      },
    });

    removeDeletedEpicsFromCloudTaskCaches(
      queryClient,
      { hostId: null, userId: "user-1" },
      ["epic-a"],
    );

    // host-a lost its only task and drops out; host-b keeps the survivor.
    expect(
      queryClient.getQueryData<ListTasksResponse>(key)?.facets?.chatHosts,
    ).toEqual([{ hostId: "host-b", count: 1 }]);
  });

  it("clears an already-retained deleted tail and rejects its late response", () => {
    const hostId = "host-a";
    const userId = "user-1";
    const identity = cloudEpicTasksPageIdentity(
      hostId,
      userId,
      LIST_CLOUD_TASKS_REQUEST,
    );
    const staleGeneration = cloudEpicTasksPageGeneration(identity);
    const deletedTail: ListTasksResponse = {
      tasks: [taskLight("epic-deleted", "Deleted", "traycer/gui-app", userId)],
      hasMore: false,
    };
    useCloudEpicTasksPagesStore
      .getState()
      .appendPage(identity, staleGeneration, deletedTail);

    removeDeletedEpicsFromCloudTaskCaches(
      new QueryClient(),
      { hostId, userId },
      ["epic-deleted"],
    );

    expect(
      useCloudEpicTasksPagesStore.getState().pagesByIdentity[identity],
    ).toBeUndefined();
    // This is the eventual cursor response from the request that captured
    // `staleGeneration` before deletion. The store must refuse resurrection.
    useCloudEpicTasksPagesStore
      .getState()
      .appendPage(identity, staleGeneration, deletedTail);
    expect(
      useCloudEpicTasksPagesStore.getState().pagesByIdentity[identity],
    ).toBeUndefined();
  });

  it("removes a deleted epic from the host/user last-known fallback", () => {
    const queryClient = new QueryClient();
    const scope = { hostId: "host-a", userId: "user-1" };
    const lastKnownKey = cloudEpicTasksLastKnownQueryKey(
      scope.hostId,
      scope.userId,
    );
    queryClient.setQueryData<ListTasksResponse>(lastKnownKey, {
      tasks: [
        taskLight("epic-deleted", "Deleted", "traycer/gui-app", "user-1"),
      ],
      hasMore: false,
    });

    removeDeletedEpicsFromCloudTaskCaches(queryClient, scope, ["epic-deleted"]);

    expect(
      queryClient
        .getQueryData<ListTasksResponse>(lastKnownKey)
        ?.tasks.map((task) => task.epic?.light?.id),
    ).toEqual([]);
  });

  it("admits a late last-known fallback through the delete ledger", () => {
    const queryClient = new QueryClient();
    const scope = { hostId: "host-a", userId: "user-1" };
    const lastKnownKey = cloudEpicTasksLastKnownQueryKey(
      scope.hostId,
      scope.userId,
    );

    // The delete finishes before a different settled first page attempts to
    // refresh the shared fallback. The writer itself must remove the stale row
    // rather than relying on the cache having existed when delete ran.
    removeDeletedEpicsFromCloudTaskCaches(queryClient, scope, ["epic-deleted"]);
    writeCloudEpicTasksLastKnown(queryClient, scope, {
      tasks: [
        taskLight("epic-deleted", "Deleted", "traycer/gui-app", "user-1"),
      ],
      hasMore: false,
    });

    expect(
      queryClient
        .getQueryData<ListTasksResponse>(lastKnownKey)
        ?.tasks.map((task) => task.epic?.light?.id),
    ).toEqual([]);
  });

  it("admits a preserved first page and cursor tail after a tombstone", () => {
    const queryClient = new QueryClient();
    const scope = { hostId: "host-a", userId: "user-1" };
    const options = cloudEpicTasksFirstPageQueryOptions(
      scope.hostId,
      scope.userId,
      LIST_CLOUD_TASKS_REQUEST,
    );
    const normalPage: ListTasksResponse = {
      tasks: [
        taskLight("epic-orphan", "Orphan", "traycer/gui-app", scope.userId),
      ],
      hasMore: false,
    };

    // This is the already-cached first page at the moment a local deletion is
    // processed. The ordinary row is removed immediately.
    queryClient.getQueryCache().build(queryClient, {
      queryKey: options.queryKey,
      queryFn: options.queryFn,
      structuralSharing: options.structuralSharing,
    });
    queryClient.setQueryData(options.queryKey, normalPage);
    removeDeletedEpicsFromCloudTaskCaches(queryClient, scope, ["epic-orphan"]);
    expect(
      queryClient.getQueryData<ListTasksResponse>(options.queryKey)?.tasks,
    ).toEqual([]);

    const preservedPage: ListTasksResponse = {
      tasks: [
        {
          ...listTaskLight("epic-orphan", "Orphan", scope.userId),
          preservation: "orphaned-local-edits",
        },
      ],
      hasMore: false,
    };

    // A late first-page delivery must be allowed back through the same
    // tombstone boundary when it carries the durable preservation marker.
    queryClient.setQueryData(options.queryKey, preservedPage);
    expect(
      queryClient
        .getQueryData<ListTasksResponse>(options.queryKey)
        ?.tasks.map((task) => task.epic?.light?.id),
    ).toEqual(["epic-orphan"]);

    // Cursor pages use the retained-page store rather than TanStack's first
    // page. The tombstone already exists, so this late tail must be admitted
    // for the preserved row and remain rejected for an ordinary row.
    const identity = cloudEpicTasksPageIdentity(
      scope.hostId,
      scope.userId,
      LIST_CLOUD_TASKS_REQUEST,
    );
    const generation = cloudEpicTasksPageGeneration(identity);
    useCloudEpicTasksPagesStore.getState().appendPage(identity, generation, {
      tasks: preservedPage.tasks,
      hasMore: false,
    });
    const retained =
      useCloudEpicTasksPagesStore.getState().pagesByIdentity[identity];
    // Assert the tail landed before reading through it, so a page that never
    // arrived fails here rather than as an `undefined` in the row comparison.
    expect(retained).toHaveLength(1);
    expect(retained[0].tasks.map((task) => task.epic?.light?.id)).toEqual([
      "epic-orphan",
    ]);

    // The other half of that sentence, at the CURRENT generation: an ordinary
    // row for the tombstoned id is still refused. The earlier rejection in
    // this file uses a stale generation and so exercises the generation
    // guard; without this assertion a tombstone filter that admitted every
    // late row at the current generation would pass the suite.
    useCloudEpicTasksPagesStore.getState().appendPage(identity, generation, {
      tasks: [listTaskLight("epic-orphan", "Orphan", scope.userId)],
      hasMore: false,
    });
    const retainedAfterOrdinary =
      useCloudEpicTasksPagesStore.getState().pagesByIdentity[identity];
    const ordinaryRows = retainedAfterOrdinary.flatMap((page) =>
      page.tasks.filter((task) => task.preservation !== "orphaned-local-edits"),
    );
    expect(ordinaryRows).toEqual([]);
  });
});

describe("setEpicLocalHomeInCloudTaskCaches", () => {
  it("patches the matching row in the cloud.listTasks.lastKnown cache", () => {
    const queryClient = new QueryClient();
    const scope = { hostId: "host-a", userId: "user-1" };
    const lastKnownKey = cloudEpicTasksLastKnownQueryKey(
      scope.hostId,
      scope.userId,
    );
    queryClient.setQueryData<ListTasksResponse>(lastKnownKey, {
      tasks: [listTaskLight("epic-local", "Local epic", scope.userId)],
      hasMore: false,
    });

    setEpicLocalHomeInCloudTaskCaches(queryClient, scope, "epic-local", true);

    expect(
      queryClient.getQueryData<ListTasksResponse>(lastKnownKey)?.tasks[0]?.home,
    ).toBe("local");
  });
});

describe("readEpicTitlesFromCloudTaskCaches", () => {
  it("reads titles for matching user caches before deleted rows are pruned", () => {
    const queryClient = new QueryClient();
    const matchingKey = cloudEpicTasksQueryKey(
      "host-a",
      "user-1",
      LIST_CLOUD_TASKS_REQUEST,
    );
    const otherUserKey = cloudEpicTasksQueryKey(
      "host-a",
      "user-2",
      LIST_CLOUD_TASKS_REQUEST,
    );
    queryClient.setQueryData<ListTasksResponse>(matchingKey, {
      tasks: [
        taskLight("epic-a", " Alpha ", "traycer/gui-app", "user-1"),
        taskLight("epic-b", "Beta", "traycer/server", "user-1"),
      ],
      hasMore: false,
    });
    queryClient.setQueryData<ListTasksResponse>(otherUserKey, {
      tasks: [taskLight("epic-c", "Wrong user", "traycer/gui-app", "user-2")],
      hasMore: false,
    });

    expect(
      readEpicTitlesFromCloudTaskCaches(
        queryClient,
        { hostId: null, userId: "user-1" },
        ["epic-a", "epic-c", "missing"],
      ),
    ).toEqual({ "epic-a": "Alpha" });
  });
});

describe("updateEpicTitleInCloudTaskCaches", () => {
  it("updates cached history titles for matching user caches only", () => {
    const queryClient = new QueryClient();
    const matchingKey = cloudEpicTasksQueryKey(
      "host-a",
      "user-1",
      LIST_CLOUD_TASKS_REQUEST,
    );
    const otherUserKey = cloudEpicTasksQueryKey(
      "host-a",
      "user-2",
      LIST_CLOUD_TASKS_REQUEST,
    );
    queryClient.setQueryData<ListTasksResponse>(matchingKey, {
      tasks: [
        taskLight("epic-a", "Alpha", "traycer/gui-app", "user-1"),
        taskLight("epic-b", "Beta", "traycer/server", "user-1"),
      ],
      hasMore: false,
    });
    queryClient.setQueryData<ListTasksResponse>(otherUserKey, {
      tasks: [taskLight("epic-a", "Alpha", "traycer/gui-app", "user-2")],
      hasMore: false,
    });

    updateEpicTitleInCloudTaskCaches(
      queryClient,
      { hostId: "host-a", userId: "user-1" },
      "epic-a",
      "Renamed Alpha",
    );

    expect(
      queryClient
        .getQueryData<ListTasksResponse>(matchingKey)
        ?.tasks.map((task) => task.epic?.light?.title),
    ).toEqual(["Renamed Alpha", "Beta"]);
    expect(
      queryClient
        .getQueryData<ListTasksResponse>(otherUserKey)
        ?.tasks.map((task) => task.epic?.light?.title),
    ).toEqual(["Alpha"]);
  });

  it("also patches matching epic.getTaskContexts batch-title caches", () => {
    const queryClient = new QueryClient();
    const listKey = cloudEpicTasksQueryKey(
      "host-a",
      "user-1",
      LIST_CLOUD_TASKS_REQUEST,
    );
    const batchKey = hostQueryKeys.epicTaskContexts("host-a", "user-1", [
      "epic-a",
      "epic-b",
    ]);
    const otherUserBatchKey = hostQueryKeys.epicTaskContexts(
      "host-a",
      "user-2",
      ["epic-a"],
    );
    queryClient.setQueryData<ListTasksResponse>(listKey, {
      tasks: [taskLight("epic-a", "Alpha", "traycer/gui-app", "user-1")],
      hasMore: false,
    });
    queryClient.setQueryData<GetTaskContextsResponse>(batchKey, {
      tasks: {
        "epic-a": foundTask(listTaskLight("epic-a", "Alpha", "user-1")),
        "epic-b": foundTask(listTaskLight("epic-b", "Beta", "user-1")),
      },
    });
    queryClient.setQueryData<GetTaskContextsResponse>(otherUserBatchKey, {
      tasks: {
        "epic-a": foundTask(listTaskLight("epic-a", "Alpha", "user-2")),
      },
    });

    updateEpicTitleInCloudTaskCaches(
      queryClient,
      { hostId: "host-a", userId: "user-1" },
      "epic-a",
      "Renamed Alpha",
    );

    expect(
      queryClient
        .getQueryData<ListTasksResponse>(listKey)
        ?.tasks.map((task) => task.epic?.light?.title),
    ).toEqual(["Renamed Alpha"]);
    expect(taskTitleAt(queryClient, batchKey, "epic-a")).toBe("Renamed Alpha");
    expect(taskTitleAt(queryClient, batchKey, "epic-b")).toBe("Beta");
    expect(taskTitleAt(queryClient, otherUserBatchKey, "epic-a")).toBe("Alpha");
  });
});

describe("updateEpicTitleInTaskContextsCaches", () => {
  it("leaves unknown batch entries untouched", () => {
    const queryClient = new QueryClient();
    const batchKey = hostQueryKeys.epicTaskContexts("host-a", "user-1", [
      "epic-missing",
    ]);
    queryClient.setQueryData<GetTaskContextsResponse>(batchKey, {
      tasks: {
        "epic-missing": { status: "unknown", reason: "transport" },
      },
    });

    updateEpicTitleInTaskContextsCaches(
      queryClient,
      { hostId: "host-a", userId: "user-1" },
      "epic-missing",
      "Whatever",
    );

    expect(
      queryClient.getQueryData<GetTaskContextsResponse>(batchKey)?.tasks,
    ).toEqual({
      "epic-missing": { status: "unknown", reason: "transport" },
    });
  });
});

describe("setEpicPinnedInCloudTaskCaches", () => {
  it("patches matching list and exact task-context caches", () => {
    const queryClient = new QueryClient();
    const listKey = cloudEpicTasksQueryKey(
      "host-a",
      "user-1",
      LIST_CLOUD_TASKS_REQUEST,
    );
    const batchKey = hostQueryKeys.epicTaskContexts("host-a", "user-1", [
      "epic-a",
      "epic-b",
    ]);
    const otherUserBatchKey = hostQueryKeys.epicTaskContexts(
      "host-a",
      "user-2",
      ["epic-a"],
    );
    queryClient.setQueryData<ListTasksResponse>(listKey, {
      tasks: [taskLight("epic-a", "Alpha", "traycer/gui-app", "user-1")],
      hasMore: false,
    });
    queryClient.setQueryData<GetTaskContextsResponse>(batchKey, {
      tasks: {
        "epic-a": foundTask(listTaskLight("epic-a", "Alpha", "user-1")),
        "epic-b": foundTask(listTaskLight("epic-b", "Beta", "user-1")),
      },
    });
    queryClient.setQueryData<GetTaskContextsResponse>(otherUserBatchKey, {
      tasks: {
        "epic-a": foundTask(listTaskLight("epic-a", "Alpha", "user-2")),
      },
    });

    setEpicPinnedInCloudTaskCaches(
      queryClient,
      { hostId: "host-a", userId: "user-1" },
      "epic-a",
      true,
    );

    expect(
      queryClient.getQueryData<ListTasksResponse>(listKey)?.tasks[0]?.pinned,
    ).toBe(true);
    expect(taskPinnedAt(queryClient, batchKey, "epic-a")).toBe(true);
    expect(taskPinnedAt(queryClient, batchKey, "epic-b")).toBe(false);
    expect(taskPinnedAt(queryClient, otherUserBatchKey, "epic-a")).toBe(false);
  });
});

describe("cloudEpicTasksFirstPageQueryOptions cache writes", () => {
  beforeEach(() => {
    useCloudEpicTasksPagesStore.setState({
      pagesByIdentity: {},
      generationByIdentity: {},
      deletedEpicIdsByScope: {},
    });
  });

  it("keeps the previous empty page through an equal fetch", async () => {
    const fetchQueryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const options = cloudEpicTasksFirstPageQueryOptions(
      "host-a",
      "user-1",
      LIST_CLOUD_TASKS_REQUEST,
    );
    const firstEmptyPage: ListTasksResponse = { tasks: [], hasMore: false };
    const equalEmptyPage: ListTasksResponse = { tasks: [], hasMore: false };

    await fetchQueryClient.fetchQuery(
      queryOptions({
        ...options,
        staleTime: 0,
        queryFn: () => Promise.resolve(firstEmptyPage),
      }),
    );
    await fetchQueryClient.fetchQuery(
      queryOptions({
        ...options,
        staleTime: 0,
        queryFn: () => Promise.resolve(equalEmptyPage),
      }),
    );

    expect(fetchQueryClient.getQueryData(options.queryKey)).toBe(
      firstEmptyPage,
    );
  });

  it("keeps the previous populated page through equal primary setQueryData", () => {
    const options = cloudEpicTasksFirstPageQueryOptions(
      "host-a",
      "user-1",
      LIST_CLOUD_TASKS_REQUEST,
    );
    const firstPopulatedPage: ListTasksResponse = {
      tasks: [listTaskLight("epic-a", "Alpha", "user-1")],
      hasMore: false,
    };
    const equalPopulatedPage: ListTasksResponse = {
      tasks: [listTaskLight("epic-a", "Alpha", "user-1")],
      hasMore: false,
    };
    // `setQueryData` uses the existing Query's options. Build that primary
    // Query with the production options first, matching the revalidation path
    // where a pending first page has already installed them.
    const setQueryClient = new QueryClient();
    setQueryClient.getQueryCache().build(setQueryClient, {
      queryKey: options.queryKey,
      queryFn: () => Promise.resolve(firstPopulatedPage),
      structuralSharing: options.structuralSharing,
    });
    setQueryClient.setQueryData(options.queryKey, firstPopulatedPage);
    setQueryClient.setQueryData(options.queryKey, equalPopulatedPage);

    expect(setQueryClient.getQueryData(options.queryKey)).toBe(
      firstPopulatedPage,
    );
  });
});

function taskLight(
  id: string,
  title: string,
  repo: string,
  createdBy: string,
): TaskLight {
  const [owner, repoName] = repo.split("/");
  return {
    epic: {
      light: {
        id,
        title,
        initialUserPrompt: "",
        ticketCount: 0,
        specCount: 0,
        storyCount: 0,
        reviewCount: 0,
        status: "draft",
        createdAt: Date.parse("2026-04-22T10:00:00.000Z"),
        updatedAt: Date.parse("2026-04-22T11:00:00.000Z"),
        createdBy,
        version: "1.0.0",
      },
      permission: null,
      repos: [
        {
          task: { taskId: id, taskType: "epic" },
          repoIdentifier: {
            owner,
            repo: repoName,
          },
          createdAt: Date.parse("2026-04-22T10:00:00.000Z"),
          createdBy,
        },
      ],
      workspaces: [
        {
          task: { taskId: id, taskType: "epic" },
          hostId: "host-a",
          workspacePath: `/repo/${repoName}`,
          createdAt: Date.parse("2026-04-22T10:00:00.000Z"),
        },
      ],
      roomInfo: null,
    },
  };
}

function listTaskLight(
  id: string,
  title: string,
  createdBy: string,
): ListTaskLight {
  return {
    ...taskLight(id, title, "traycer/gui-app", createdBy),
    pinned: false,
  };
}

function foundTask(
  task: ListTaskLight,
): GetTaskContextsResponse["tasks"][string] {
  return { status: "found", task };
}

function taskTitleAt(
  queryClient: QueryClient,
  queryKey: readonly unknown[],
  taskId: string,
): string | undefined {
  const resolution =
    queryClient.getQueryData<GetTaskContextsResponse>(queryKey)?.tasks[taskId];
  return isFoundTaskContext(resolution)
    ? resolution.task.epic?.light?.title
    : undefined;
}

function taskPinnedAt(
  queryClient: QueryClient,
  queryKey: readonly unknown[],
  taskId: string,
): boolean | undefined {
  const resolution =
    queryClient.getQueryData<GetTaskContextsResponse>(queryKey)?.tasks[taskId];
  return isFoundTaskContext(resolution) ? resolution.task.pinned : undefined;
}
