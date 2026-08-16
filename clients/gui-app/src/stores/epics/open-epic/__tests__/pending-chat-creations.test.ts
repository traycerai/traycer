/**
 * Pure-function unit tests for `pending-chat-creations.ts` - the union that
 * folds a client's in-flight chat creations into the record slice. The
 * store-integrated behavior (poll survival, real-row handover, retraction,
 * user switch) lives in `chat-records-union.test.ts`'s "pending chat
 * creations" describe block, next to the record-row equivalents it mirrors.
 */
import { describe, expect, it } from "vitest";
import {
  chatProjectionFromPendingCreation,
  unionPendingChatCreations,
  type RetainedChatCreation,
} from "@/stores/epics/open-epic/pending-chat-creations";
import { EMPTY_CHATS_SLICE } from "@/stores/epics/open-epic/types";
import type {
  ChatProjection,
  ChatsSlice,
} from "@/stores/epics/open-epic/types";

function pendingCreation(
  overrides: Partial<RetainedChatCreation["pending"]>,
): RetainedChatCreation["pending"] {
  return {
    chatId: "chat-1",
    hostId: "host-1",
    parentChatId: null,
    title: "",
    ownerUserId: "user-1",
    ...overrides,
  };
}

function retained(
  overrides: Partial<RetainedChatCreation>,
): RetainedChatCreation {
  return {
    pending: pendingCreation({}),
    ownerUserId: "user-a",
    createdAt: 1_000,
    ...overrides,
  };
}

function chatProjection(overrides: Partial<ChatProjection>): ChatProjection {
  return {
    id: "existing",
    title: "Existing",
    parentId: null,
    createdAt: 1,
    updatedAt: 1,
    userId: "user-a",
    hostId: "host-1",
    isTitleEditedByUser: false,
    settings: null,
    archivedAt: null,
    ...overrides,
  };
}

function chatsSlice(entries: readonly ChatProjection[]): ChatsSlice {
  if (entries.length === 0) return EMPTY_CHATS_SLICE;
  const byId: Record<string, ChatProjection> = {};
  const allIds: string[] = [];
  for (const entry of entries) {
    byId[entry.id] = entry;
    allIds.push(entry.id);
  }
  return { byId, allIds };
}

describe("chatProjectionFromPendingCreation", () => {
  it("projects the submitted facts, with settings null and both timestamps at createdAt", () => {
    const projection = chatProjectionFromPendingCreation(
      retained({
        pending: pendingCreation({
          chatId: "c",
          hostId: "h",
          parentChatId: "p",
          title: "Draft title",
        }),
        ownerUserId: "user-a",
        createdAt: 5_000,
      }),
    );
    expect(projection).toEqual({
      id: "c",
      title: "Draft title",
      parentId: "p",
      createdAt: 5_000,
      updatedAt: 5_000,
      userId: "user-a",
      hostId: "h",
      isTitleEditedByUser: false,
      settings: null,
      archivedAt: null,
    });
  });
});

describe("unionPendingChatCreations", () => {
  it("returns records BY REFERENCE when nothing is pending", () => {
    const records = chatsSlice([chatProjection({})]);
    expect(unionPendingChatCreations(records, [], null)).toBe(records);
  });

  it("returns records BY REFERENCE when every pending entry's chat is already served", () => {
    const records = chatsSlice([chatProjection({ id: "chat-1" })]);
    const result = unionPendingChatCreations(
      records,
      [retained({ pending: pendingCreation({ chatId: "chat-1" }) })],
      null,
    );
    // Ablation: drop the `Object.hasOwn(records.byId, chatId)` skip and this
    // returns a freshly merged object instead - same content, new identity,
    // which would cost every downstream consumer a re-render for nothing.
    expect(result).toBe(records);
  });

  it("folds a pending entry in when its chat is not already served", () => {
    const records = chatsSlice([chatProjection({ id: "existing" })]);
    const result = unionPendingChatCreations(
      records,
      [
        retained({
          pending: pendingCreation({ chatId: "pending-1", title: "Draft" }),
        }),
      ],
      null,
    );
    expect(result).not.toBe(records);
    expect(result.allIds.slice().sort()).toEqual(["existing", "pending-1"]);
    expect(result.byId["pending-1"].title).toBe("Draft");
    // The input slice's own entries and identity are untouched.
    expect(result.byId.existing).toBe(records.byId.existing);
  });

  it("skips a pending entry whose chat is already in the records slice, and keeps the served fields", () => {
    const records = chatsSlice([
      chatProjection({ id: "chat-1", title: "Served title" }),
    ]);
    const result = unionPendingChatCreations(
      records,
      [
        retained({
          pending: pendingCreation({ chatId: "chat-1", title: "Stale draft" }),
        }),
      ],
      null,
    );
    expect(result.allIds).toEqual(["chat-1"]);
    expect(result.byId["chat-1"].title).toBe("Served title");
  });

  it("applies the owner-visibility filter, exactly like a record row", () => {
    const records = chatsSlice([]);
    const result = unionPendingChatCreations(
      records,
      [
        retained({
          pending: pendingCreation({ chatId: "mine" }),
          ownerUserId: "user-a",
        }),
        retained({
          pending: pendingCreation({ chatId: "theirs" }),
          ownerUserId: "user-b",
        }),
      ],
      "user-a",
    );
    expect(result.allIds).toEqual(["mine"]);
  });

  it("never emits two entries for the same chat id across multiple pending rows", () => {
    // Not reachable through the store today (the registry is keyed so at
    // most one retained row exists per chat), but the union's own dedupe
    // guard against a duplicate id in `retained` is exercised directly here.
    const records = chatsSlice([]);
    const result = unionPendingChatCreations(
      records,
      [
        retained({ pending: pendingCreation({ chatId: "dup", title: "A" }) }),
        retained({ pending: pendingCreation({ chatId: "dup", title: "B" }) }),
      ],
      null,
    );
    expect(result.allIds).toEqual(["dup"]);
    expect(result.byId.dup.title).toBe("A");
  });
});
