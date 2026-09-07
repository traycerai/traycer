import { describe, expect, it } from "vitest";

import type {
  ChatProjection,
  ChatsSlice,
} from "@/stores/epics/open-epic/types";

import { resolveQuoteChatTargets } from "../quote-chat-targets";

const SOURCE_HOST = "host-source";
const OTHER_HOST = "host-elsewhere";

function chat(fields: {
  id: string;
  title: string;
  archivedAt: number | null;
  hostId?: string | null;
}): ChatProjection {
  return {
    id: fields.id,
    title: fields.title,
    parentId: null,
    createdAt: 0,
    updatedAt: 0,
    userId: null,
    hostId: fields.hostId ?? SOURCE_HOST,
    docResident: false,
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

describe("resolveQuoteChatTargets", () => {
  it("lists open chats first, each band in sidebar order", () => {
    const targets = resolveQuoteChatTargets({
      orderedChatIds: SIDEBAR_ORDER,
      chats: CHATS,
      openChatIds: new Set(["chat-c", "chat-a"]),
      lastFocusedChatId: null,
      sourceHostId: SOURCE_HOST,
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
    const targets = resolveQuoteChatTargets({
      orderedChatIds: SIDEBAR_ORDER,
      chats: CHATS,
      openChatIds: new Set(),
      lastFocusedChatId: null,
      sourceHostId: SOURCE_HOST,
    });

    expect(targets.map((target) => target.chatId)).toEqual(SIDEBAR_ORDER);
  });

  it("excludes archived chats, which the sidebar already hides", () => {
    const withArchived = chatsSlice([
      chat({ id: "chat-live", title: "Kickoff", archivedAt: null }),
      chat({ id: "chat-gone", title: "Old", archivedAt: 5 }),
    ]);

    const targets = resolveQuoteChatTargets({
      orderedChatIds: ["chat-gone", "chat-live"],
      chats: withArchived,
      // Even open, an archived chat stays out - it is not somewhere the user
      // can follow the message to.
      openChatIds: new Set(["chat-gone"]),
      lastFocusedChatId: "chat-gone",
      sourceHostId: SOURCE_HOST,
    });

    expect(targets.map((target) => target.chatId)).toEqual(["chat-live"]);
  });

  it("never marks isOnOtherHost when the source has no host affinity", () => {
    const mixed = chatsSlice([
      chat({
        id: "chat-a",
        title: "Kickoff",
        archivedAt: null,
        hostId: SOURCE_HOST,
      }),
      chat({
        id: "chat-b",
        title: "Refactor",
        archivedAt: null,
        hostId: OTHER_HOST,
      }),
      chat({ id: "chat-c", title: "Docs", archivedAt: null, hostId: null }),
    ]);

    const targets = resolveQuoteChatTargets({
      orderedChatIds: ["chat-a", "chat-b", "chat-c"],
      chats: mixed,
      openChatIds: new Set(),
      lastFocusedChatId: null,
      // An artifact is projected onto every host serving the epic, so no
      // chat is out of reach for host reasons.
      sourceHostId: null,
    });

    expect(targets.every((target) => !target.isOnOtherHost)).toBe(true);
  });

  it("marks a chat bound to another host when the source has one", () => {
    const mixed = chatsSlice([
      chat({
        id: "chat-a",
        title: "Kickoff",
        archivedAt: null,
        hostId: SOURCE_HOST,
      }),
      chat({
        id: "chat-b",
        title: "Refactor",
        archivedAt: null,
        hostId: OTHER_HOST,
      }),
    ]);

    const targets = resolveQuoteChatTargets({
      orderedChatIds: ["chat-a", "chat-b"],
      chats: mixed,
      openChatIds: new Set(),
      lastFocusedChatId: null,
      sourceHostId: SOURCE_HOST,
    });

    expect(targets.map((target) => target.isOnOtherHost)).toEqual([
      false,
      true,
    ]);
  });

  it("leaves a legacy null-host chat reachable when the source has a host", () => {
    const legacy = chatsSlice([
      chat({
        id: "chat-legacy",
        title: "Kickoff",
        archivedAt: null,
        hostId: null,
      }),
    ]);

    const targets = resolveQuoteChatTargets({
      orderedChatIds: ["chat-legacy"],
      chats: legacy,
      openChatIds: new Set(),
      lastFocusedChatId: null,
      sourceHostId: SOURCE_HOST,
    });

    // Opening it binds it to the tab's host, so it is not somewhere else.
    expect(targets.map((target) => target.isOnOtherHost)).toEqual([false]);
  });

  it("reports no targets for a Task with no chats", () => {
    expect(
      resolveQuoteChatTargets({
        orderedChatIds: [],
        chats: chatsSlice([]),
        openChatIds: new Set(),
        lastFocusedChatId: null,
        sourceHostId: null,
      }),
    ).toEqual([]);
  });
});
