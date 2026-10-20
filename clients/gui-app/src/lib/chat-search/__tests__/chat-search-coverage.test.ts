import { QueryClient, queryOptions } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";
import type { EnvironmentListResponse } from "@traycer/protocol/host/environment/contracts";
import { cloudChatListQueryKey } from "@/lib/chats/cloud-chat-list-cache";
import { queryKeys } from "@/lib/query-keys";
import {
  chatSearchCoverage,
  heldTeamEnvironmentIds,
  heldViewerTaskChats,
  type ChatSearchCoverageInput,
} from "../chat-search-coverage";

const VIEWER = "viewer-1";
const HOST = "host-1";
const TASK = "task-1";

function chat(
  chatId: string,
  ownerUserId: string,
  ownerHostId: string,
): CloudChatSummary {
  return {
    identity: { taskId: TASK, chatId, ownerUserId },
    ownerHostId,
    createdAt: 1,
    visibility: "task",
    title: chatId,
    isTitleEditedByUser: false,
    parentChatId: null,
    isArchived: false,
    runSettingsSummary: null,
    metadataUpdatedAt: 1,
    headSha256: null,
    publishedAt: null,
    throughRecordSeq: null,
    isOwnedByViewer: ownerUserId === VIEWER,
  };
}

function input(
  overrides: Partial<ChatSearchCoverageInput>,
): ChatSearchCoverageInput {
  return {
    searchHostId: HOST,
    viewerId: VIEWER,
    epicId: TASK,
    viewerChats: [chat("a", VIEWER, HOST)],
    arms: null,
    ...overrides,
  };
}

describe("chatSearchCoverage", () => {
  it("is unknown for every-task scope, no searched host, or no held viewer list", () => {
    expect(chatSearchCoverage(input({ epicId: null }))).toEqual({
      kind: "unknown",
    });
    expect(chatSearchCoverage(input({ searchHostId: null }))).toEqual({
      kind: "unknown",
    });
    expect(chatSearchCoverage(input({ viewerChats: null }))).toEqual({
      kind: "unknown",
    });
  });

  it("is unknown in a pool build until the team environments are held and all settled", () => {
    const settled = new Set(["env-1"]);
    expect(
      chatSearchCoverage(
        input({
          arms: {
            teamEnvironmentIds: null,
            settledEnvironmentIds: settled,
            chats: [],
          },
        }),
      ),
    ).toEqual({ kind: "unknown" });
    expect(
      chatSearchCoverage(
        input({
          arms: {
            teamEnvironmentIds: ["env-1", "env-2"],
            settledEnvironmentIds: settled,
            chats: [],
          },
        }),
      ),
    ).toEqual({ kind: "unknown" });
  });

  it("is complete when every known chat is on the searched host and the viewer's", () => {
    expect(
      chatSearchCoverage(
        input({
          viewerChats: [chat("a", VIEWER, HOST), chat("b", VIEWER, HOST)],
          arms: {
            teamEnvironmentIds: ["env-1"],
            settledEnvironmentIds: new Set(["env-1"]),
            chats: [],
          },
        }),
      ),
    ).toEqual({ kind: "complete" });
  });

  it("counts chats on another host or owned by another user, arm rows included", () => {
    const coverage = chatSearchCoverage(
      input({
        viewerChats: [chat("a", VIEWER, HOST), chat("b", VIEWER, "host-2")],
        arms: {
          teamEnvironmentIds: ["env-1"],
          settledEnvironmentIds: new Set(["env-1"]),
          chats: [chat("m", "member", HOST), chat("n", "member", "sandbox-1")],
        },
      }),
    );

    expect(coverage).toEqual({ kind: "elsewhere", count: 3 });
  });

  it("counts a chat on both the viewer and arm lists once", () => {
    const coverage = chatSearchCoverage(
      input({
        viewerChats: [chat("b", VIEWER, "host-2")],
        arms: {
          teamEnvironmentIds: [],
          settledEnvironmentIds: new Set(),
          chats: [chat("b", VIEWER, "host-2")],
        },
      }),
    );

    expect(coverage).toEqual({ kind: "elsewhere", count: 1 });
  });
});

describe("held reads from the query cache", () => {
  let queryClient = new QueryClient();

  afterEach(() => {
    queryClient.clear();
    queryClient = new QueryClient();
  });

  it("reads a settled viewer chat list for the task from whichever host carried it", () => {
    queryClient.setQueryData(
      cloudChatListQueryKey({
        hostId: HOST,
        viewerUserId: VIEWER,
        taskId: TASK,
      }),
      { chats: [chat("a", VIEWER, HOST)] },
    );

    expect(heldViewerTaskChats(queryClient, VIEWER, TASK)).toEqual([
      chat("a", VIEWER, HOST),
    ]);
    expect(heldViewerTaskChats(queryClient, "someone-else", TASK)).toBeNull();
    expect(heldViewerTaskChats(queryClient, VIEWER, "other-task")).toBeNull();
  });

  it("ignores an errored list", () => {
    const key = cloudChatListQueryKey({
      hostId: HOST,
      viewerUserId: VIEWER,
      taskId: TASK,
    });
    queryClient.setQueryData(key, { chats: [chat("a", VIEWER, HOST)] });
    queryClient.getQueryCache().find({ queryKey: key })?.setState({
      status: "error",
      data: undefined,
    });

    expect(heldViewerTaskChats(queryClient, VIEWER, TASK)).toBeNull();
  });

  it("ignores a list that is still pending", () => {
    void queryClient
      .prefetchQuery(
        queryOptions({
          queryKey: cloudChatListQueryKey({
            hostId: HOST,
            viewerUserId: VIEWER,
            taskId: TASK,
          }),
          queryFn: () => new Promise<never>(() => undefined),
        }),
      )
      .catch(() => undefined);

    expect(heldViewerTaskChats(queryClient, VIEWER, TASK)).toBeNull();
  });

  it("reads the viewer's team environment ids from the cached environment list", () => {
    const environmentListKey = queryOptions<EnvironmentListResponse>({
      queryKey: [...queryKeys.hostMethod(HOST, "environment.list", {}), VIEWER],
    }).queryKey;
    queryClient.setQueryData(environmentListKey, {
      environments: [
        {
          environmentId: "env-personal",
          ownerKind: "user",
          ownerId: VIEWER,
          roomId: "r1",
          label: "Personal",
        },
        {
          environmentId: "env-team",
          ownerKind: "organization",
          ownerId: "org-1",
          roomId: "r2",
          label: "Team",
        },
      ],
    });

    expect(heldTeamEnvironmentIds(queryClient, VIEWER)).toEqual(["env-team"]);
    expect(heldTeamEnvironmentIds(queryClient, "someone-else")).toBeNull();
  });

  it("ignores an errored environment list", () => {
    const key = [...queryKeys.hostMethod(HOST, "environment.list", {}), VIEWER];
    queryClient.setQueryData(key, { environments: [] });
    queryClient.getQueryCache().find({ queryKey: key })?.setState({
      status: "error",
      data: undefined,
    });

    expect(heldTeamEnvironmentIds(queryClient, VIEWER)).toBeNull();
  });
});
