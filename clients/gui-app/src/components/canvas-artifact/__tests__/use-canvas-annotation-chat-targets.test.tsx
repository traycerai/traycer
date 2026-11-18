import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import type { ChatProjection } from "@/stores/epics/open-epic/types";
import { useCanvasAnnotationChatTargets } from "../use-canvas-annotation-chat-targets";

const SCOPE_HOST = "host-1";

function chat(id: string, hostId: string | null): ChatProjection {
  return {
    id,
    title: id,
    parentId: null,
    createdAt: 0,
    updatedAt: 0,
    userId: null,
    ownedByViewer: true,
    hostId,
    docResident: false,
    isTitleEditedByUser: false,
    archivedAt: null,
    settings: null,
  };
}

const chats = [chat("same", SCOPE_HOST), chat("elsewhere", "host-2")];

vi.mock("@/providers/use-open-epic-handle", () => ({
  useOpenEpicHandle: () => ({
    store: createStore(() => ({
      chats: {
        byId: Object.fromEntries(chats.map((entry) => [entry.id, entry])),
        allIds: chats.map((entry) => entry.id),
      },
    })),
  }),
}));
vi.mock("@/components/epic-canvas/sidebar/epic-sidebar-selection", () => ({
  useSidebarChatOrder: () => ["same", "elsewhere"],
}));
vi.mock("@/stores/epics/canvas/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/stores/epics/canvas/store")>()),
  useOpenTileContentIds: () => new Set<string>(),
}));

describe("useCanvasAnnotationChatTargets", () => {
  it("lists a chat bound to another host as an ordinary target", () => {
    const { result } = renderHook(() =>
      useCanvasAnnotationChatTargets({ epicId: "epic-1", viewTabId: "tab-1" }),
    );

    expect(
      result.current.map((target) => [target.chatId, target.isOnOtherHost]),
    ).toEqual([
      ["same", false],
      ["elsewhere", false],
    ]);
  });
});
