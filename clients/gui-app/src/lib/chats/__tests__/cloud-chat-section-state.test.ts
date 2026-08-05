import { describe, expect, it } from "vitest";
import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";
import {
  cloudChatRowKey,
  composeCloudChatSectionState,
  selectCloudOnlyChats,
} from "@/lib/chats/cloud-chat-section-state";

/**
 * The sidebar section's whole decision, asserted as data.
 *
 * Every case here is about whether a section EXISTS, which is the one thing a
 * render test in jsdom would also be able to say - and would say through a
 * layer of mocked query hooks. The rule is worth more than the wiring, so the
 * rule is what is tested.
 */

function summary(fields: {
  readonly chatId: string;
  readonly ownerUserId: string;
}): CloudChatSummary {
  return {
    identity: {
      taskId: "task-1",
      chatId: fields.chatId,
      ownerUserId: fields.ownerUserId,
    },
    ownerHostId: "host-other",
    createdAt: 1,
    visibility: "task",
    title: fields.chatId,
    isTitleEditedByUser: false,
    parentChatId: null,
    isArchived: false,
    runSettingsSummary: null,
    metadataUpdatedAt: 2,
    headSha256: null,
    publishedAt: null,
    throughRecordSeq: null,
    isOwnedByViewer: true,
  };
}

const CLOUD_ONLY = summary({ chatId: "chat-cloud", ownerUserId: "u-1" });
const ALSO_LOCAL = summary({ chatId: "chat-local", ownerUserId: "u-1" });

describe("hiding rather than failing", () => {
  it("hides on an older host, and on any other failure", () => {
    expect(
      composeCloudChatSectionState({
        chats: undefined,
        isError: true,
        isFetching: false,
        localChatIds: [],
      }),
    ).toEqual({ kind: "hidden" });
  });

  it("hides - does NOT spin - for a signed-out viewer", () => {
    // The failure this pins: a disabled TanStack query is `isPending` forever,
    // so a section keyed on pending alone shows "Checking your other devices…"
    // to every signed-out user until they sign in.
    expect(
      composeCloudChatSectionState({
        chats: undefined,
        isError: false,
        isFetching: false,
        localChatIds: [],
      }),
    ).toEqual({ kind: "hidden" });
  });

  it("spins only while a request is genuinely in flight", () => {
    expect(
      composeCloudChatSectionState({
        chats: undefined,
        isError: false,
        isFetching: true,
        localChatIds: [],
      }),
    ).toEqual({ kind: "loading" });
  });

  it("hides when every cloud chat is already on this device", () => {
    expect(
      composeCloudChatSectionState({
        chats: [ALSO_LOCAL],
        isError: false,
        isFetching: false,
        localChatIds: ["chat-local"],
      }),
    ).toEqual({ kind: "hidden" });
  });

  it("hides for a task with no cloud chats at all", () => {
    expect(
      composeCloudChatSectionState({
        chats: [],
        isError: false,
        isFetching: false,
        localChatIds: [],
      }),
    ).toEqual({ kind: "hidden" });
  });
});

describe("the dedup", () => {
  it("shows only the chats the local tree is not already showing", () => {
    const state = composeCloudChatSectionState({
      chats: [ALSO_LOCAL, CLOUD_ONLY],
      isError: false,
      isFetching: false,
      localChatIds: ["chat-local"],
    });

    expect(state.kind).toBe("rows");
    if (state.kind !== "rows") return;
    // Showing `chat-local` in both places would read as two chats.
    expect(state.rows.map((row) => row.identity.chatId)).toEqual([
      "chat-cloud",
    ]);
  });

  it("preserves the server's order among what survives", () => {
    const first = summary({ chatId: "a", ownerUserId: "u-1" });
    const second = summary({ chatId: "b", ownerUserId: "u-1" });

    expect(
      selectCloudOnlyChats([second, first], []).map(
        (row) => row.identity.chatId,
      ),
    ).toEqual(["b", "a"]);
  });

  it("does not treat an empty local set as 'everything is local'", () => {
    expect(selectCloudOnlyChats([CLOUD_ONLY, ALSO_LOCAL], [])).toHaveLength(2);
  });
});

describe("row keys", () => {
  it("separates two hosts that minted the SAME chat id under one task", () => {
    // The collision the identity triple exists for. Keyed on `chatId` alone,
    // React would collapse these into one element and swap their content when
    // the list reorders.
    expect(
      cloudChatRowKey({
        taskId: "t",
        ownerUserId: "u-1",
        chatId: "same",
      }),
    ).not.toBe(
      cloudChatRowKey({ taskId: "t", ownerUserId: "u-2", chatId: "same" }),
    );
  });
});
