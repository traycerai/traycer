/**
 * `lib/chats/cloud-chat-deletions.ts` - identity scoping and concurrency.
 *
 * The suppression key is the full task+owner+host+chatId tuple, not just
 * `chatId` (which is host-minted and not unique under a task - see
 * `lib/chats/unified-chat-list.ts`), so these pin that a deletion never
 * leaks across a dimension it did not name: another host's row under the
 * same id, another task, another owner, or - after a fork - the still-live
 * lineage still holding the ORIGINAL id while this device's copy publishes
 * into a derived clone id.
 *
 * The concurrency cases cover `settleCloudChatDeletion`'s Map/Set shape
 * directly: `confirmed` is monotonic (only ever grown, never pruned by a
 * later failure), which is what makes two overlapping delete attempts for
 * the same chat safe regardless of settle order.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";
import {
  beginCloudChatDeletion,
  filterDeletedCloudChats,
  settleCloudChatDeletion,
  useCloudChatDeletions,
} from "@/lib/chats/cloud-chat-deletions";
import {
  cloudChatListQueryKey,
  readCloudKnownChatIds,
} from "@/lib/chats/cloud-chat-list-cache";

const TASK = "task-1";
const OTHER_TASK = "task-2";
const VIEWER = "viewer-1";
const OTHER_USER = "viewer-2";
const HOST_A = "host-a";
const HOST_B = "host-b";

function cloudChat(overrides: {
  readonly taskId: string;
  readonly chatId: string;
  readonly ownerUserId: string;
  readonly ownerHostId: string;
  readonly title: string;
}): CloudChatSummary {
  return {
    identity: {
      taskId: overrides.taskId,
      chatId: overrides.chatId,
      ownerUserId: overrides.ownerUserId,
    },
    ownerHostId: overrides.ownerHostId,
    title: overrides.title,
    createdAt: 1,
    visibility: "private",
    isTitleEditedByUser: false,
    parentChatId: null,
    isArchived: false,
    runSettingsSummary: null,
    metadataUpdatedAt: 1,
    headSha256: null,
    publishedAt: null,
    throughRecordSeq: null,
    isOwnedByViewer: overrides.ownerUserId === VIEWER,
  };
}

beforeEach(() => {
  useCloudChatDeletions.setState({ pending: new Map(), confirmed: new Set() });
});

afterEach(() => {
  useCloudChatDeletions.setState(useCloudChatDeletions.getInitialState(), true);
});

describe("cloud chat deletion identity scoping", () => {
  it("a confirmed deletion on one host does not hide the same task/owner/chatId on ANOTHER host", () => {
    const rowOnA = cloudChat({
      taskId: TASK,
      chatId: "chat-1",
      ownerUserId: VIEWER,
      ownerHostId: HOST_A,
      title: "On A",
    });
    const rowOnB = cloudChat({
      taskId: TASK,
      chatId: "chat-1",
      ownerUserId: VIEWER,
      ownerHostId: HOST_B,
      title: "On B",
    });

    const token = beginCloudChatDeletion({
      taskId: TASK,
      ownerUserId: VIEWER,
      ownerHostId: HOST_A,
      chatId: "chat-1",
    });
    settleCloudChatDeletion(token, true);

    expect(
      filterDeletedCloudChats(
        [rowOnA, rowOnB],
        useCloudChatDeletions.getState(),
      ).map((c) => c.title),
    ).toEqual(["On B"]);
  });

  it("does not hide the same owner/host/chatId under a DIFFERENT task, or another owner's row under the same task/host/chatId", () => {
    const target = cloudChat({
      taskId: TASK,
      chatId: "chat-1",
      ownerUserId: VIEWER,
      ownerHostId: HOST_A,
      title: "Target",
    });
    const otherTask = cloudChat({
      taskId: OTHER_TASK,
      chatId: "chat-1",
      ownerUserId: VIEWER,
      ownerHostId: HOST_A,
      title: "Other task",
    });
    const otherOwner = cloudChat({
      taskId: TASK,
      chatId: "chat-1",
      ownerUserId: OTHER_USER,
      ownerHostId: HOST_A,
      title: "Other owner",
    });

    const token = beginCloudChatDeletion({
      taskId: TASK,
      ownerUserId: VIEWER,
      ownerHostId: HOST_A,
      chatId: "chat-1",
    });
    settleCloudChatDeletion(token, true);

    expect(
      filterDeletedCloudChats(
        [target, otherTask, otherOwner],
        useCloudChatDeletions.getState(),
      )
        .map((c) => c.title)
        .sort(),
    ).toEqual(["Other owner", "Other task"]);
  });

  it("deleting the forked (redirected) id hides only the clone row, not the original id's still-live host lineage", () => {
    // The live fork witness `unified-chat-list.test.ts` documents: a local
    // chat's publication moved from its original id to a server-derived
    // clone id after a fork, while the OTHER host's lineage kept the
    // original id as a genuinely different chat.
    const ORIGINAL_ID = "56254cae-aa80-4d06-914c-5086cdd65e3c";
    const CLONE_ID = "d44cc96fc1d364fe4a9e3cd2d5eb2eea";
    const incumbent = cloudChat({
      taskId: TASK,
      chatId: ORIGINAL_ID,
      ownerUserId: VIEWER,
      ownerHostId: HOST_B,
      title: "Incumbent (other host, original id)",
    });
    const clone = cloudChat({
      taskId: TASK,
      chatId: CLONE_ID,
      ownerUserId: VIEWER,
      ownerHostId: HOST_A,
      title: "Clone (this host, redirected id)",
    });

    // `useEpicDeleteChat` resolves the publication target BEFORE beginning
    // the deletion - the identity it suppresses is the CLONE id, not the
    // chat's pre-fork local id.
    const token = beginCloudChatDeletion({
      taskId: TASK,
      ownerUserId: VIEWER,
      ownerHostId: HOST_A,
      chatId: CLONE_ID,
    });
    settleCloudChatDeletion(token, true);

    expect(
      filterDeletedCloudChats(
        [incumbent, clone],
        useCloudChatDeletions.getState(),
      ).map((c) => c.title),
    ).toEqual(["Incumbent (other host, original id)"]);
  });

  it("keeps a confirmed deletion confirmed when an overlapping token for the SAME identity later fails", () => {
    const identity = {
      taskId: TASK,
      ownerUserId: VIEWER,
      ownerHostId: HOST_A,
      chatId: "chat-1",
    };
    const row = cloudChat({
      taskId: TASK,
      chatId: "chat-1",
      ownerUserId: VIEWER,
      ownerHostId: HOST_A,
      title: "Mine",
    });

    // Two in-flight deletes for the same chat - a double-click, or a retry
    // racing the original request - mint two tokens for the same identity.
    const tokenA = beginCloudChatDeletion(identity);
    const tokenB = beginCloudChatDeletion(identity);

    settleCloudChatDeletion(tokenA, true);
    expect(
      filterDeletedCloudChats([row], useCloudChatDeletions.getState()),
    ).toEqual([]);

    // B settling as a FAILURE afterwards must not un-confirm what A already
    // confirmed - `settleCloudChatDeletion` only ever ADDS to `confirmed`,
    // never removes from it.
    settleCloudChatDeletion(tokenB, false);
    expect(
      filterDeletedCloudChats([row], useCloudChatDeletions.getState()),
    ).toEqual([]);
  });

  it("keeps the row hidden while a sibling token is still pending, even after the other one fails first", () => {
    const identity = {
      taskId: TASK,
      ownerUserId: VIEWER,
      ownerHostId: HOST_A,
      chatId: "chat-1",
    };
    const row = cloudChat({
      taskId: TASK,
      chatId: "chat-1",
      ownerUserId: VIEWER,
      ownerHostId: HOST_A,
      title: "Mine",
    });

    const tokenA = beginCloudChatDeletion(identity);
    const tokenB = beginCloudChatDeletion(identity);

    settleCloudChatDeletion(tokenB, false);
    // A is still pending - the row must stay hidden.
    expect(
      filterDeletedCloudChats([row], useCloudChatDeletions.getState()),
    ).toEqual([]);

    settleCloudChatDeletion(tokenA, true);
    expect(
      filterDeletedCloudChats([row], useCloudChatDeletions.getState()),
    ).toEqual([]);
  });

  it("restores the row once every token for it has failed", () => {
    const identity = {
      taskId: TASK,
      ownerUserId: VIEWER,
      ownerHostId: HOST_A,
      chatId: "chat-1",
    };
    const row = cloudChat({
      taskId: TASK,
      chatId: "chat-1",
      ownerUserId: VIEWER,
      ownerHostId: HOST_A,
      title: "Mine",
    });

    const token = beginCloudChatDeletion(identity);
    settleCloudChatDeletion(token, false);

    expect(
      filterDeletedCloudChats([row], useCloudChatDeletions.getState()),
    ).toEqual([row]);
  });

  it("readCloudKnownChatIds excludes a confirmed-deleted chat from the viewer-owned id set", () => {
    const queryClient = new QueryClient();
    const mine = cloudChat({
      taskId: TASK,
      chatId: "chat-1",
      ownerUserId: VIEWER,
      ownerHostId: HOST_A,
      title: "Mine",
    });
    const alsoMine = cloudChat({
      taskId: TASK,
      chatId: "chat-2",
      ownerUserId: VIEWER,
      ownerHostId: HOST_A,
      title: "Also mine",
    });
    queryClient.setQueryData(
      cloudChatListQueryKey({
        hostId: HOST_A,
        viewerUserId: VIEWER,
        taskId: TASK,
      }),
      { chats: [mine, alsoMine] },
    );

    expect(
      readCloudKnownChatIds(queryClient, {
        hostId: HOST_A,
        viewerUserId: VIEWER,
        taskId: TASK,
      }),
    ).toEqual(new Set(["chat-1", "chat-2"]));

    const token = beginCloudChatDeletion({
      taskId: TASK,
      ownerUserId: VIEWER,
      ownerHostId: HOST_A,
      chatId: "chat-1",
    });
    settleCloudChatDeletion(token, true);

    expect(
      readCloudKnownChatIds(queryClient, {
        hostId: HOST_A,
        viewerUserId: VIEWER,
        taskId: TASK,
      }),
    ).toEqual(new Set(["chat-2"]));
  });
});
