import { describe, expect, it } from "vitest";

import {
  resolveAnnotationRoute,
  type AnnotationRoute,
} from "@/lib/browser-view/annotation/browser-annotation-router";
import type {
  ChatProjection,
  ChatsSlice,
} from "@/stores/epics/open-epic/types";

const HOST_ID = "host-annotation-router";
const OTHER_HOST_ID = "host-other";

function chat(title: string, hostId: string | null): ChatProjection {
  return {
    id: title,
    title,
    parentId: null,
    createdAt: 1,
    updatedAt: 1,
    userId: null,
    hostId,
    isTitleEditedByUser: false,
    settings: null,
    archivedAt: null,
  };
}

interface RouteCase {
  readonly name: string;
  readonly orderedChatIds: readonly string[];
  readonly preferredChatId: string | null;
  readonly lastFocusedChatId: string | null;
  readonly chats: Readonly<Record<string, ChatProjection>>;
  readonly expected: AnnotationRoute;
}

describe("resolveAnnotationRoute", () => {
  it.each<RouteCase>([
    {
      name: "lists the reachable roster and defaults to the first chat",
      orderedChatIds: ["chat-first", "chat-second"],
      preferredChatId: null,
      lastFocusedChatId: null,
      chats: {
        "chat-first": chat("First chat", HOST_ID),
        "chat-second": chat("Second chat", HOST_ID),
      },
      expected: {
        targets: [
          { chatId: "chat-first", label: "First chat" },
          { chatId: "chat-second", label: "Second chat" },
        ],
        defaultChatId: "chat-first",
      },
    },
    {
      name: "preferred controller wins over last-focused and first",
      orderedChatIds: ["chat-first", "chat-focused", "chat-controller"],
      preferredChatId: "chat-controller",
      lastFocusedChatId: "chat-focused",
      chats: {
        "chat-first": chat("First chat", HOST_ID),
        "chat-focused": chat("Focused chat", HOST_ID),
        "chat-controller": chat("Controller chat", HOST_ID),
      },
      expected: {
        targets: [
          { chatId: "chat-first", label: "First chat" },
          { chatId: "chat-focused", label: "Focused chat" },
          { chatId: "chat-controller", label: "Controller chat" },
        ],
        defaultChatId: "chat-controller",
      },
    },
    {
      name: "last-focused wins when preferred is absent",
      orderedChatIds: ["chat-first", "chat-focused"],
      preferredChatId: null,
      lastFocusedChatId: "chat-focused",
      chats: {
        "chat-first": chat("First chat", HOST_ID),
        "chat-focused": chat("Focused chat", HOST_ID),
      },
      expected: {
        targets: [
          { chatId: "chat-first", label: "First chat" },
          { chatId: "chat-focused", label: "Focused chat" },
        ],
        defaultChatId: "chat-focused",
      },
    },
    {
      name: "preferred outside the roster falls through to last-focused",
      orderedChatIds: ["chat-first", "chat-focused"],
      preferredChatId: "chat-missing",
      lastFocusedChatId: "chat-focused",
      chats: {
        "chat-first": chat("First chat", HOST_ID),
        "chat-focused": chat("Focused chat", HOST_ID),
      },
      expected: {
        targets: [
          { chatId: "chat-first", label: "First chat" },
          { chatId: "chat-focused", label: "Focused chat" },
        ],
        defaultChatId: "chat-focused",
      },
    },
    {
      name: "preferred and last-focused outside the roster fall through to first",
      orderedChatIds: ["chat-first", "chat-second"],
      preferredChatId: "chat-gone",
      lastFocusedChatId: "chat-also-gone",
      chats: {
        "chat-first": chat("First chat", HOST_ID),
        "chat-second": chat("Second chat", HOST_ID),
      },
      expected: {
        targets: [
          { chatId: "chat-first", label: "First chat" },
          { chatId: "chat-second", label: "Second chat" },
        ],
        defaultChatId: "chat-first",
      },
    },
    {
      name: "empty title is Untitled agent",
      orderedChatIds: ["chat-untitled"],
      preferredChatId: null,
      lastFocusedChatId: null,
      chats: { "chat-untitled": chat("", HOST_ID) },
      expected: {
        targets: [{ chatId: "chat-untitled", label: "Untitled agent" }],
        defaultChatId: "chat-untitled",
      },
    },
    {
      name: "omits other-host chats and keeps null-host chats",
      orderedChatIds: ["chat-local", "chat-foreign", "chat-unbound"],
      preferredChatId: null,
      lastFocusedChatId: null,
      chats: {
        "chat-local": chat("Local", HOST_ID),
        "chat-foreign": chat("Foreign", OTHER_HOST_ID),
        "chat-unbound": chat("Unbound", null),
      },
      expected: {
        targets: [
          { chatId: "chat-local", label: "Local" },
          { chatId: "chat-unbound", label: "Unbound" },
        ],
        defaultChatId: "chat-local",
      },
    },
    {
      name: "empty roster has a null default",
      orderedChatIds: ["chat-deleted"],
      preferredChatId: "chat-deleted",
      lastFocusedChatId: "chat-deleted",
      chats: {},
      expected: {
        targets: [],
        defaultChatId: null,
      },
    },
    {
      name: "unknown ordered ids are dropped from the roster",
      orderedChatIds: ["chat-live", "chat-missing"],
      preferredChatId: null,
      lastFocusedChatId: "chat-missing",
      chats: { "chat-live": chat("Live chat", HOST_ID) },
      expected: {
        targets: [{ chatId: "chat-live", label: "Live chat" }],
        defaultChatId: "chat-live",
      },
    },
  ])(
    "$name",
    ({
      orderedChatIds,
      preferredChatId,
      lastFocusedChatId,
      chats,
      expected,
    }) => {
      expect(
        resolveAnnotationRoute({
          orderedChatIds,
          chats: { byId: chats, allIds: orderedChatIds } satisfies ChatsSlice,
          browserHostId: HOST_ID,
          preferredChatId,
          lastFocusedChatId,
        }),
      ).toEqual(expected);
    },
  );
});
