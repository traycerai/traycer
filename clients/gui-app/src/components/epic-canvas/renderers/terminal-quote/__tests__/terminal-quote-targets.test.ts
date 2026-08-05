import { describe, expect, it } from "vitest";

import type {
  ChatProjection,
  ChatsSlice,
} from "@/stores/epics/open-epic/types";

import { resolveTerminalQuoteChatTargets } from "../terminal-quote-targets";

function chat(fields: {
  id: string;
  title: string;
  updatedAt: number;
  archivedAt: number | null;
}): ChatProjection {
  return {
    id: fields.id,
    title: fields.title,
    parentId: null,
    createdAt: 0,
    updatedAt: fields.updatedAt,
    userId: null,
    hostId: null,
    isTitleEditedByUser: false,
    archivedAt: fields.archivedAt,
    settings: null,
  };
}

function chatsSlice(chats: ReadonlyArray<ChatProjection>): ChatsSlice {
  return {
    byId: Object.fromEntries(chats.map((entry) => [entry.id, entry])),
    allIds: chats.map((entry) => entry.id),
  };
}

describe("resolveTerminalQuoteChatTargets", () => {
  const chats = chatsSlice([
    chat({ id: "chat-old", title: "Kickoff", updatedAt: 10, archivedAt: null }),
    chat({
      id: "chat-new",
      title: "Refactor",
      updatedAt: 90,
      archivedAt: null,
    }),
    chat({ id: "chat-mid", title: "Docs", updatedAt: 50, archivedAt: null }),
  ]);

  it("puts the last focused chat first and marks it", () => {
    const targets = resolveTerminalQuoteChatTargets(chats, "chat-old");

    // "chat-new" streamed most recently, but the user was typing in "chat-old",
    // and that is what the primary action targets.
    expect(targets.map((target) => target.chatId)).toEqual([
      "chat-old",
      "chat-new",
      "chat-mid",
    ]);
    expect(targets.map((target) => target.isLastFocused)).toEqual([
      true,
      false,
      false,
    ]);
  });

  it("falls back to the most recent chat when nothing has been focused", () => {
    const targets = resolveTerminalQuoteChatTargets(chats, null);

    expect(targets.map((target) => target.chatId)).toEqual([
      "chat-new",
      "chat-mid",
      "chat-old",
    ]);
    // The fallback is a guess, so no row claims to be where the user was last
    // working.
    expect(targets.some((target) => target.isLastFocused)).toBe(false);
  });

  it("ignores a focus record for a chat that is gone", () => {
    const targets = resolveTerminalQuoteChatTargets(chats, "chat-deleted");

    expect(targets[0]?.chatId).toBe("chat-new");
    expect(targets.some((target) => target.isLastFocused)).toBe(false);
  });

  it("excludes archived chats, which the sidebar already hides", () => {
    const withArchived = chatsSlice([
      chat({
        id: "chat-live",
        title: "Kickoff",
        updatedAt: 10,
        archivedAt: null,
      }),
      chat({ id: "chat-gone", title: "Old", updatedAt: 99, archivedAt: 5 }),
    ]);

    expect(
      resolveTerminalQuoteChatTargets(withArchived, "chat-gone").map(
        (target) => target.chatId,
      ),
    ).toEqual(["chat-live"]);
  });

  it("reports no targets for a Task with no chats", () => {
    expect(resolveTerminalQuoteChatTargets(chatsSlice([]), null)).toEqual([]);
  });

  it("names an untitled chat the way every other chat surface does", () => {
    const untitled = chatsSlice([
      chat({ id: "chat-1", title: "", updatedAt: 1, archivedAt: null }),
    ]);

    expect(resolveTerminalQuoteChatTargets(untitled, null)[0]?.title).toBe(
      "Untitled agent",
    );
  });
});
