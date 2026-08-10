import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type {
  GetTaskContextsResponse,
  ListTaskLight,
  ListTasksResponse,
  TaskLight,
} from "@traycer/protocol/host/epic/unary-schemas";
import {
  LIST_CLOUD_TASKS_REQUEST,
  cloudEpicTasksQueryKey,
} from "@/lib/cloud-epic-tasks-query";
import {
  readEpicTitlesFromCloudTaskCaches,
  removeDeletedEpicsFromCloudTaskCaches,
  setEpicPinnedInCloudTaskCaches,
  updateEpicTitleInCloudTaskCaches,
  updateEpicTitleInTaskContextsCaches,
} from "@/lib/cloud-epic-tasks-query/cache";
import { hostQueryKeys } from "@/lib/query-keys";

describe("removeDeletedEpicsFromCloudTaskCaches", () => {
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
        "epic-a": listTaskLight("epic-a", "Alpha", "user-1"),
        "epic-b": listTaskLight("epic-b", "Beta", "user-1"),
      },
    });
    queryClient.setQueryData<GetTaskContextsResponse>(otherUserBatchKey, {
      tasks: {
        "epic-a": listTaskLight("epic-a", "Alpha", "user-2"),
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
    expect(
      queryClient.getQueryData<GetTaskContextsResponse>(batchKey)?.tasks[
        "epic-a"
      ]?.epic?.light?.title,
    ).toBe("Renamed Alpha");
    expect(
      queryClient.getQueryData<GetTaskContextsResponse>(batchKey)?.tasks[
        "epic-b"
      ]?.epic?.light?.title,
    ).toBe("Beta");
    expect(
      queryClient.getQueryData<GetTaskContextsResponse>(otherUserBatchKey)
        ?.tasks["epic-a"]?.epic?.light?.title,
    ).toBe("Alpha");
  });
});

describe("updateEpicTitleInTaskContextsCaches", () => {
  it("leaves null batch entries untouched", () => {
    const queryClient = new QueryClient();
    const batchKey = hostQueryKeys.epicTaskContexts("host-a", "user-1", [
      "epic-missing",
    ]);
    queryClient.setQueryData<GetTaskContextsResponse>(batchKey, {
      tasks: { "epic-missing": null },
    });

    updateEpicTitleInTaskContextsCaches(
      queryClient,
      { hostId: "host-a", userId: "user-1" },
      "epic-missing",
      "Whatever",
    );

    expect(
      queryClient.getQueryData<GetTaskContextsResponse>(batchKey)?.tasks,
    ).toEqual({ "epic-missing": null });
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
        "epic-a": listTaskLight("epic-a", "Alpha", "user-1"),
        "epic-b": listTaskLight("epic-b", "Beta", "user-1"),
      },
    });
    queryClient.setQueryData<GetTaskContextsResponse>(otherUserBatchKey, {
      tasks: {
        "epic-a": listTaskLight("epic-a", "Alpha", "user-2"),
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
    expect(
      queryClient.getQueryData<GetTaskContextsResponse>(batchKey)?.tasks[
        "epic-a"
      ]?.pinned,
    ).toBe(true);
    expect(
      queryClient.getQueryData<GetTaskContextsResponse>(batchKey)?.tasks[
        "epic-b"
      ]?.pinned,
    ).toBe(false);
    expect(
      queryClient.getQueryData<GetTaskContextsResponse>(otherUserBatchKey)
        ?.tasks["epic-a"]?.pinned,
    ).toBe(false);
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
