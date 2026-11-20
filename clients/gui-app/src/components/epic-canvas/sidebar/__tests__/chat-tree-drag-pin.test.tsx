/**
 * The dragged chat's row stays mounted while a drag scrolls the virtualised
 * chat tree far past it, and unmounts once the drag ends and it is out of
 * range. dnd-kit keeps measuring a source that unmounts as a detached node, so
 * the overlay jumps and auto-scroll dies; the pin (`ChatTreeDragSupport`) is
 * what holds it.
 *
 * The real `ChatTreePanelBody` inside the real `RootDndProvider`, a real
 * pointer gesture on a row, and the layout stood in by `chatTreeLayout`.
 */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chatTreeLayout } from "@/__tests__/chat-tree-virtual-layout";
import { RootDndProvider } from "@/components/epic-canvas/dnd/root-dnd-provider";
import { useEpicDndStore } from "@/components/epic-canvas/dnd/dnd-store";
import { ChatTreePanelBody } from "@/components/epic-canvas/sidebar/epic-sidebar-chat-tree";
import { CHAT_TREE_MESSAGE_HITS_NONE } from "@/components/epic-canvas/sidebar/epic-sidebar-message-hits-state";
import {
  EPIC_ID,
  TAB_ID,
  openChatSession,
  rootChats,
} from "./chat-tree-test-support";
import { EpicSessionContext } from "@/lib/registries/epic-session-registry";
import type { OpenedStoreForTest } from "@/stores/epics/open-epic/test-support/open-store-for-test";

vi.mock("@tanstack/react-virtual", async (importOriginal) =>
  (await import("@/__tests__/chat-tree-virtual-layout")).mockReactVirtual(
    importOriginal,
  ),
);
vi.mock("@/hooks/host/use-host-client-for-host-id", async (importOriginal) =>
  (await import("./chat-tree-host-mocks")).hostClientForHostIdMock(
    importOriginal,
  ),
);
vi.mock(
  "@/hooks/epic/use-task-hosts-view",
  async () => (await import("./chat-tree-host-mocks")).taskHostsViewMock,
);
vi.mock(
  "@/hooks/pr/use-owner-pr-references",
  async () => (await import("./chat-tree-host-mocks")).ownerPrReferencesMock,
);
vi.mock(
  "@/hooks/notifications/use-host-notification-indicators-query",
  async (importOriginal) =>
    (await import("./chat-tree-host-mocks")).notificationIndicatorsMock(
      importOriginal,
    ),
);
vi.mock("@/hooks/agent/use-host-reachability", async (importOriginal) =>
  (await import("./chat-tree-host-mocks")).hostReachabilityMock(importOriginal),
);
vi.mock("@/hooks/chats/use-cloud-chat-queries", async (importOriginal) =>
  (await import("./chat-tree-host-mocks")).cloudChatQueriesMock(importOriginal),
);

const ROW_COUNT = 200;
const ROW_PX = 30;
const VIEWPORT_PX = 300;
const opened: OpenedStoreForTest[] = [];

function rowElement(id: string): HTMLElement | null {
  return screen.queryByTestId(`epic-sidebar-item-${id}`);
}

describe("the chat tree while a drag scrolls it", () => {
  beforeEach(() => {
    chatTreeLayout.reset();
    chatTreeLayout.setRowHeight(() => ROW_PX);
    chatTreeLayout.setViewport(VIEWPORT_PX);
  });
  afterEach(() => {
    cleanup();
    for (const handle of opened.splice(0)) handle.dispose();
    useEpicDndStore.setState(useEpicDndStore.getInitialState(), true);
  });

  it("keeps the dragged row mounted far out of range, and lets it go once the drag ends", () => {
    const session = openChatSession(rootChats(ROW_COUNT));
    opened.push(session);
    render(
      <QueryClientProvider client={new QueryClient()}>
        <EpicSessionContext.Provider value={session}>
          <RootDndProvider>
            <ChatTreePanelBody
              epicId={EPIC_ID}
              tabId={TAB_ID}
              messageHits={CHAT_TREE_MESSAGE_HITS_NONE}
            />
          </RootDndProvider>
        </EpicSessionContext.Provider>
      </QueryClientProvider>,
    );
    const source = screen.getByTestId("epic-sidebar-item-c5");
    expect(rowElement("c6")).not.toBeNull();
    expect(
      document.activeElement,
      "the source row must not be focused, or its focus pin would hold it",
    ).not.toBe(source);

    act(() => {
      fireEvent.pointerDown(source, {
        pointerId: 1,
        isPrimary: true,
        button: 0,
        clientX: 10,
        clientY: 10,
      });
    });
    act(() => {
      fireEvent.pointerMove(source, { pointerId: 1, clientX: 30, clientY: 10 });
    });
    act(() => {
      fireEvent.pointerMove(source, { pointerId: 1, clientX: 60, clientY: 20 });
    });
    expect(useEpicDndStore.getState().activeSource?.kind).toBe("sidebar-node");

    chatTreeLayout.scrollTo(ROW_PX * 120);
    expect(document.activeElement).not.toBe(source);
    expect(
      rowElement("c5"),
      "the dragged row must stay mounted after the list scrolled far past it",
    ).not.toBeNull();
    expect(
      rowElement("c6"),
      "an equally distant row that is not dragged must have unmounted",
    ).toBeNull();
    expect(rowElement("c125")).not.toBeNull();

    act(() => {
      fireEvent.keyDown(document, { key: "Escape", code: "Escape" });
    });
    act(() => {
      fireEvent.pointerUp(source, { pointerId: 1, clientX: 60, clientY: 20 });
    });
    expect(useEpicDndStore.getState().activeSource).toBeNull();
    expect(
      rowElement("c5"),
      "once the drag ended the row is out of range and unmounts",
    ).toBeNull();
  });
});
