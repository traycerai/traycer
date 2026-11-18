import { describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";
import { cloudChatListQueryKey } from "@/lib/chats/cloud-chat-list-cache";
import {
  applyOwnCloudChatVisibility,
  invalidateCloudChatViewerScope,
  reconcileCloudChatSummary,
} from "@/lib/chats/cloud-chat-visibility-cache";
import { cloudChatQueryKeys } from "@/lib/query-keys/cloud-chat-query-keys";

const HOST_ID = "host-1";
const VIEWER = "user-1";
const TASK = "task-1";

function summary(
  chatId: string,
  visibility: "private" | "task",
  ownerUserId: string,
): CloudChatSummary {
  return {
    identity: { taskId: TASK, chatId, ownerUserId },
    ownerHostId: HOST_ID,
    createdAt: 1,
    visibility,
    title: chatId,
    isTitleEditedByUser: false,
    parentChatId: null,
    isArchived: false,
    runSettingsSummary: null,
    metadataUpdatedAt: 1,
    headSha256: null,
    publishedAt: 1,
    throughRecordSeq: null,
    isOwnedByViewer: ownerUserId === VIEWER,
  };
}

function listKey() {
  return cloudChatListQueryKey({
    hostId: HOST_ID,
    viewerUserId: VIEWER,
    taskId: TASK,
  });
}

describe("reconcileCloudChatSummary", () => {
  it("replaces the matching identity triple in the viewer's list cache", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(listKey(), {
      chats: [
        summary("chat-1", "private", VIEWER),
        summary("chat-2", "task", VIEWER),
      ],
    });

    reconcileCloudChatSummary(queryClient, {
      hostId: HOST_ID,
      viewerUserId: VIEWER,
      chat: summary("chat-1", "task", VIEWER),
    });

    expect(queryClient.getQueryData(listKey())).toEqual({
      chats: [
        summary("chat-1", "task", VIEWER),
        summary("chat-2", "task", VIEWER),
      ],
    });
  });

  it("does not touch another viewer's cache slot", () => {
    const queryClient = new QueryClient();
    const otherKey = cloudChatListQueryKey({
      hostId: HOST_ID,
      viewerUserId: "other-user",
      taskId: TASK,
    });
    queryClient.setQueryData(otherKey, {
      chats: [summary("chat-1", "private", VIEWER)],
    });

    reconcileCloudChatSummary(queryClient, {
      hostId: HOST_ID,
      viewerUserId: VIEWER,
      chat: summary("chat-1", "task", VIEWER),
    });

    expect(queryClient.getQueryData(otherKey)).toEqual({
      chats: [summary("chat-1", "private", VIEWER)],
    });
  });
});

describe("applyOwnCloudChatVisibility", () => {
  it("rewrites only the viewer's own rows", () => {
    const queryClient = new QueryClient();
    const foreign = summary("chat-foreign", "task", "someone-else");
    queryClient.setQueryData(listKey(), {
      chats: [summary("chat-1", "private", VIEWER), foreign],
    });

    applyOwnCloudChatVisibility(queryClient, {
      hostId: HOST_ID,
      viewerUserId: VIEWER,
      taskId: TASK,
      visibility: "task",
    });

    expect(queryClient.getQueryData(listKey())).toEqual({
      chats: [summary("chat-1", "task", VIEWER), foreign],
    });
  });
});

describe("invalidateCloudChatViewerScope", () => {
  it("invalidates the viewer-scoped cloud-chat prefix", () => {
    const queryClient = new QueryClient();
    const invalidateQueries = vi
      .spyOn(queryClient, "invalidateQueries")
      .mockResolvedValue();

    invalidateCloudChatViewerScope(queryClient, HOST_ID, VIEWER);

    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: cloudChatQueryKeys.scope(HOST_ID, VIEWER),
    });
  });
});
