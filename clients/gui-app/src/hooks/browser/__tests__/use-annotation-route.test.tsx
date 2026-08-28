import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAnnotationRoute } from "@/hooks/browser/use-annotation-route";
import { useLastFocusedChatStore } from "@/stores/chat/last-focused-chat-store";
import type { ChatProjection } from "@/stores/epics/open-epic/types";

const epicChats = vi.hoisted(() => {
  let chats: {
    readonly byId: Readonly<Record<string, ChatProjection>>;
    readonly allIds: readonly string[];
  } = { byId: {}, allIds: [] };
  const listeners = new Set<() => void>();
  return {
    set(
      next: Readonly<Record<string, ChatProjection>>,
      orderedIds: readonly string[],
    ): void {
      chats = { byId: next, allIds: orderedIds };
      for (const listener of listeners) listener();
    },
    store: {
      getState: () => ({ chats }),
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
  };
});

vi.mock("@/providers/use-open-epic-handle", () => ({
  useMaybeOpenEpicHandle: () => ({ store: epicChats.store }),
  useOpenEpicHandle: () => ({ store: epicChats.store }),
}));

vi.mock("@/components/epic-canvas/sidebar/epic-sidebar-selection", () => ({
  useSidebarChatOrder: () => epicChats.store.getState().chats.allIds,
}));

const EPIC_ID = "epic-annotation-route";
const HOST_ID = "host-annotation-route";
const OTHER_HOST_ID = "host-other";

function chatProjection(
  id: string,
  title: string,
  archivedAt: number | null,
  hostId: string | null,
): ChatProjection {
  return {
    id,
    title,
    parentId: null,
    createdAt: 1,
    updatedAt: 1,
    userId: null,
    hostId,
    isTitleEditedByUser: false,
    settings: null,
    archivedAt,
  };
}

function seedChats(
  chats: Readonly<Record<string, ChatProjection>>,
  orderedIds: readonly string[],
): void {
  epicChats.set(chats, orderedIds);
}

function resetStores(): void {
  useLastFocusedChatStore.setState({ chatIdByEpicId: {} });
  epicChats.set({}, []);
}

beforeEach(() => {
  resetStores();
});

afterEach(() => {
  cleanup();
  resetStores();
});

describe("useAnnotationRoute", () => {
  it("lists the sidebar roster and prefers the controller over last-focused", () => {
    seedChats(
      {
        "chat-first": chatProjection("chat-first", "First chat", null, HOST_ID),
        "chat-focused": chatProjection(
          "chat-focused",
          "Focused chat",
          null,
          HOST_ID,
        ),
        "chat-controller": chatProjection(
          "chat-controller",
          "Controller chat",
          null,
          HOST_ID,
        ),
      },
      ["chat-first", "chat-focused", "chat-controller"],
    );
    useLastFocusedChatStore.setState({
      chatIdByEpicId: { [EPIC_ID]: "chat-focused" },
    });

    const { result } = renderHook(() =>
      useAnnotationRoute({
        epicId: EPIC_ID,
        tileInstanceId: "tile-1",
        browserHostId: HOST_ID,
        preferredChatId: "chat-controller",
        fallbackChatId: null,
      }),
    );

    expect(result.current).toEqual({
      targets: [
        { chatId: "chat-first", label: "First chat" },
        { chatId: "chat-focused", label: "Focused chat" },
        { chatId: "chat-controller", label: "Controller chat" },
      ],
      defaultChatId: "chat-controller",
    });
  });

  it("uses last-focused when no preferred controller is in the roster", () => {
    seedChats(
      {
        "chat-first": chatProjection("chat-first", "First chat", null, HOST_ID),
        "chat-focused": chatProjection(
          "chat-focused",
          "Focused chat",
          null,
          HOST_ID,
        ),
      },
      ["chat-first", "chat-focused"],
    );
    useLastFocusedChatStore.setState({
      chatIdByEpicId: { [EPIC_ID]: "chat-focused" },
    });

    const { result } = renderHook(() =>
      useAnnotationRoute({
        epicId: EPIC_ID,
        tileInstanceId: "tile-1",
        browserHostId: HOST_ID,
        preferredChatId: "chat-missing",
        fallbackChatId: null,
      }),
    );

    expect(result.current.defaultChatId).toBe("chat-focused");
    expect(result.current.targets.map((target) => target.chatId)).toEqual([
      "chat-first",
      "chat-focused",
    ]);
  });

  it("defaults to the first roster chat when preferred and last-focused are absent", () => {
    seedChats(
      {
        "chat-first": chatProjection("chat-first", "First chat", null, HOST_ID),
        "chat-second": chatProjection(
          "chat-second",
          "Second chat",
          null,
          HOST_ID,
        ),
      },
      ["chat-first", "chat-second"],
    );

    const { result } = renderHook(() =>
      useAnnotationRoute({
        epicId: EPIC_ID,
        tileInstanceId: "tile-1",
        browserHostId: HOST_ID,
        preferredChatId: null,
        fallbackChatId: null,
      }),
    );

    expect(result.current.defaultChatId).toBe("chat-first");
  });

  it("omits archived and other-host chats from the roster", () => {
    seedChats(
      {
        "chat-live": chatProjection("chat-live", "Live chat", null, HOST_ID),
        "chat-archived": chatProjection(
          "chat-archived",
          "Archived",
          1_700,
          HOST_ID,
        ),
        "chat-foreign": chatProjection(
          "chat-foreign",
          "Foreign",
          null,
          OTHER_HOST_ID,
        ),
      },
      ["chat-live", "chat-archived", "chat-foreign"],
    );

    const { result } = renderHook(() =>
      useAnnotationRoute({
        epicId: EPIC_ID,
        tileInstanceId: "tile-1",
        browserHostId: HOST_ID,
        preferredChatId: "chat-archived",
        fallbackChatId: null,
      }),
    );

    expect(result.current).toEqual({
      targets: [{ chatId: "chat-live", label: "Live chat" }],
      defaultChatId: "chat-live",
    });
  });

  it("reacts when last-focused is recorded after mount", () => {
    const { result } = renderHook(() =>
      useAnnotationRoute({
        epicId: EPIC_ID,
        tileInstanceId: "tile-1",
        browserHostId: HOST_ID,
        preferredChatId: null,
        fallbackChatId: null,
      }),
    );
    expect(result.current).toEqual({ targets: [], defaultChatId: null });

    act(() => {
      seedChats(
        {
          "chat-later": chatProjection(
            "chat-later",
            "Later chat",
            null,
            HOST_ID,
          ),
        },
        ["chat-later"],
      );
      useLastFocusedChatStore
        .getState()
        .recordFocusedChat(EPIC_ID, "chat-later");
    });

    expect(result.current).toEqual({
      targets: [{ chatId: "chat-later", label: "Later chat" }],
      defaultChatId: "chat-later",
    });
  });

  it("keeps the latest controller after active control clears", () => {
    seedChats(
      {
        "chat-controller": chatProjection(
          "chat-controller",
          "Controller chat",
          null,
          HOST_ID,
        ),
        "chat-focused": chatProjection(
          "chat-focused",
          "Focused chat",
          null,
          HOST_ID,
        ),
      },
      ["chat-controller", "chat-focused"],
    );

    let preferredChatId: string | null = "chat-controller";
    const { result, rerender } = renderHook(() =>
      useAnnotationRoute({
        epicId: EPIC_ID,
        tileInstanceId: "tile-1",
        browserHostId: HOST_ID,
        preferredChatId,
        fallbackChatId: null,
      }),
    );
    const first = result.current;
    expect(first.defaultChatId).toBe("chat-controller");

    act(() => {
      preferredChatId = null;
      useLastFocusedChatStore
        .getState()
        .recordFocusedChat(EPIC_ID, "chat-focused");
      rerender();
    });
    expect(result.current).toEqual(first);
    expect(result.current.defaultChatId).toBe("chat-controller");
  });
});
