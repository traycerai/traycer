import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type {
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
  updateEpicTitleInCloudTaskCaches,
} from "@/lib/cloud-epic-tasks-query/cache";

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
