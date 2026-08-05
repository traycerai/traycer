import { describe, expect, it } from "vitest";

import type {
  ChatProjection,
  ChatsSlice,
} from "@/stores/epics/open-epic/types";

import { resolveTerminalQuoteChatTargets } from "../terminal-quote-targets";

/** The host the terminal tile under test is bound to. */
const TERMINAL_HOST = "host-terminal";
const OTHER_HOST = "host-elsewhere";

function chat(fields: {
  id: string;
  title: string;
  archivedAt: number | null;
}): ChatProjection {
  return {
    id: fields.id,
    title: fields.title,
    parentId: null,
    createdAt: 0,
    updatedAt: 0,
    userId: null,
    hostId: TERMINAL_HOST,
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

// The sidebar's own order, already resolved upstream by `useSidebarChatOrder`.
const SIDEBAR_ORDER = ["chat-a", "chat-b", "chat-c", "chat-d"];

const CHATS = chatsSlice([
  chat({ id: "chat-a", title: "Kickoff", archivedAt: null }),
  chat({ id: "chat-b", title: "Refactor", archivedAt: null }),
  chat({ id: "chat-c", title: "Docs", archivedAt: null }),
  chat({ id: "chat-d", title: "Spike", archivedAt: null }),
]);

describe("resolveTerminalQuoteChatTargets", () => {
  it("lists open chats first, each band in sidebar order", () => {
    const targets = resolveTerminalQuoteChatTargets({
      orderedChatIds: SIDEBAR_ORDER,
      chats: CHATS,
      openChatIds: new Set(["chat-c", "chat-a"]),
      lastFocusedChatId: null,
      terminalHostId: TERMINAL_HOST,
    });

    // "chat-c" is open but sits below "chat-a" in the sidebar, and stays below
    // it here: being open promotes a band, never a row within one.
    expect(targets.map((target) => target.chatId)).toEqual([
      "chat-a",
      "chat-c",
      "chat-b",
      "chat-d",
    ]);
    expect(targets.map((target) => target.isOpen)).toEqual([
      true,
      true,
      false,
      false,
    ]);
  });

  it("keeps sidebar order intact when nothing is open", () => {
    const targets = resolveTerminalQuoteChatTargets({
      orderedChatIds: SIDEBAR_ORDER,
      chats: CHATS,
      openChatIds: new Set(),
      lastFocusedChatId: null,
      terminalHostId: TERMINAL_HOST,
    });

    expect(targets.map((target) => target.chatId)).toEqual(SIDEBAR_ORDER);
  });

  it("marks the last focused chat without moving it", () => {
    const targets = resolveTerminalQuoteChatTargets({
      orderedChatIds: SIDEBAR_ORDER,
      chats: CHATS,
      openChatIds: new Set(),
      lastFocusedChatId: "chat-c",
      terminalHostId: TERMINAL_HOST,
    });

    // Recency is a hint, not the ordering: "chat-c" is marked where the
    // sidebar puts it rather than jumping the queue.
    expect(targets.map((target) => target.isLastFocused)).toEqual([
      false,
      false,
      true,
      false,
    ]);
  });

  it("ignores a focus record for a chat that is gone", () => {
    const targets = resolveTerminalQuoteChatTargets({
      orderedChatIds: SIDEBAR_ORDER,
      chats: CHATS,
      openChatIds: new Set(),
      lastFocusedChatId: "chat-deleted",
      terminalHostId: TERMINAL_HOST,
    });

    expect(targets.some((target) => target.isLastFocused)).toBe(false);
  });

  it("excludes archived chats, which the sidebar already hides", () => {
    const withArchived = chatsSlice([
      chat({ id: "chat-live", title: "Kickoff", archivedAt: null }),
      chat({ id: "chat-gone", title: "Old", archivedAt: 5 }),
    ]);

    const targets = resolveTerminalQuoteChatTargets({
      orderedChatIds: ["chat-gone", "chat-live"],
      chats: withArchived,
      // Even open, an archived chat stays out - it is not somewhere the user
      // can follow the message to.
      openChatIds: new Set(["chat-gone"]),
      lastFocusedChatId: "chat-gone",
      terminalHostId: TERMINAL_HOST,
    });

    expect(targets.map((target) => target.chatId)).toEqual(["chat-live"]);
  });

  it("drops an ordered id with no live chat record", () => {
    const targets = resolveTerminalQuoteChatTargets({
      orderedChatIds: ["chat-a", "chat-vanished", "chat-b"],
      chats: CHATS,
      openChatIds: new Set(),
      lastFocusedChatId: null,
      terminalHostId: TERMINAL_HOST,
    });

    expect(targets.map((target) => target.chatId)).toEqual([
      "chat-a",
      "chat-b",
    ]);
  });

  it("reports no targets for a Task with no chats", () => {
    expect(
      resolveTerminalQuoteChatTargets({
        orderedChatIds: [],
        chats: chatsSlice([]),
        openChatIds: new Set(),
        lastFocusedChatId: null,
        terminalHostId: TERMINAL_HOST,
      }),
    ).toEqual([]);
  });

  it("marks a chat on another host without moving or dropping it", () => {
    const mixed = chatsSlice([
      chat({ id: "chat-a", title: "Kickoff", archivedAt: null }),
      {
        ...chat({ id: "chat-b", title: "Refactor", archivedAt: null }),
        hostId: OTHER_HOST,
      },
      {
        ...chat({ id: "chat-c", title: "Docs", archivedAt: null }),
        hostId: OTHER_HOST,
      },
      chat({ id: "chat-d", title: "Spike", archivedAt: null }),
    ]);

    const targets = resolveTerminalQuoteChatTargets({
      orderedChatIds: SIDEBAR_ORDER,
      chats: mixed,
      // The open band promotes an unreachable chat exactly as it would any
      // other: the roster's ordering is the sidebar's, marking is separate.
      openChatIds: new Set(["chat-c"]),
      lastFocusedChatId: null,
      terminalHostId: TERMINAL_HOST,
    });

    expect(targets.map((target) => target.chatId)).toEqual([
      "chat-c",
      "chat-a",
      "chat-b",
      "chat-d",
    ]);
    expect(targets.map((target) => target.isOnOtherHost)).toEqual([
      true,
      false,
      true,
      false,
    ]);
  });

  it("marks nothing in a single-host Task", () => {
    const targets = resolveTerminalQuoteChatTargets({
      orderedChatIds: SIDEBAR_ORDER,
      chats: CHATS,
      openChatIds: new Set(["chat-a"]),
      lastFocusedChatId: "chat-b",
      terminalHostId: TERMINAL_HOST,
    });

    expect(targets.every((target) => !target.isOnOtherHost)).toBe(true);
  });

  it("offers a legacy chat with no recorded host, which adopts this tab's", () => {
    const legacy = chatsSlice([
      {
        ...chat({ id: "chat-legacy", title: "Kickoff", archivedAt: null }),
        hostId: null,
      },
    ]);

    const targets = resolveTerminalQuoteChatTargets({
      orderedChatIds: ["chat-legacy"],
      chats: legacy,
      openChatIds: new Set(),
      lastFocusedChatId: null,
      terminalHostId: TERMINAL_HOST,
    });

    // Opening it binds it to the tab's host, so it is not somewhere else.
    expect(targets.map((target) => target.isOnOtherHost)).toEqual([false]);
  });

  it("names an untitled chat the way every other chat surface does", () => {
    const untitled = chatsSlice([
      chat({ id: "chat-1", title: "", archivedAt: null }),
    ]);

    expect(
      resolveTerminalQuoteChatTargets({
        orderedChatIds: ["chat-1"],
        chats: untitled,
        openChatIds: new Set(),
        lastFocusedChatId: null,
        terminalHostId: TERMINAL_HOST,
      })[0]?.title,
    ).toBe("Untitled agent");
  });
});
