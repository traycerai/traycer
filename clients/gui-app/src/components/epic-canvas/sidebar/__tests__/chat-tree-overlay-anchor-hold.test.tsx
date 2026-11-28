/**
 * An open overlay holds its row in the virtualised chat tree.
 *
 * A windowed list unmounts a row the moment it leaves the window, and a hover
 * card, tooltip or menu anchored to that row would go with it. Each overlay
 * holds its row (`useOverlayAnchorHold`) while it is open: a store change that
 * pushes the row far below the window leaves the row, and the overlay, where
 * they were, and the row goes once the overlay closes.
 *
 * The real `ChatTreePanelBody` over a real epic store; jsdom lays nothing out,
 * so the window comes from the shared layout stand-in. Each case checks, in
 * the same change, that a row WITHOUT an open overlay does leave the window.
 */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DndContext } from "@dnd-kit/core";
import * as Y from "yjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chatTreeLayout } from "@/__tests__/chat-tree-virtual-layout";
import { ChatTreePanelBody } from "@/components/epic-canvas/sidebar/epic-sidebar-chat-tree";
import { CHAT_TREE_MESSAGE_HITS_NONE } from "@/components/epic-canvas/sidebar/epic-sidebar-message-hits-state";
import { OverlayAnchorHoldContext } from "@/components/ui/overlay-anchor-hold";
import {
  TooltipWrapper,
  TooltipsSuppressedProvider,
} from "@/components/ui/tooltip-wrapper";
import { TooltipProvider } from "@/components/ui/tooltip";
import { EpicSessionContext } from "@/lib/registries/epic-session-registry";
import { useAuthStore } from "@/stores/auth/auth-store";
import type { OpenedStoreForTest } from "@/stores/epics/open-epic/test-support/open-store-for-test";
import {
  EPIC_ID,
  TAB_ID,
  openChatSession,
  rootChats,
  upsertChat,
  type SeedChat,
} from "./chat-tree-test-support";

// jsdom lays nothing out: the chat tree is virtualised, so its window comes
// from the shared layout stand-in.
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
/** Whether the machine every seeded chat lives on answers: the lock case turns it off. */
const hostState = vi.hoisted(() => ({ online: true }));
vi.mock("@/hooks/agent/use-host-reachability", async (importOriginal) => {
  const reachable = await (
    await import("./chat-tree-host-mocks")
  ).hostReachabilityMock(importOriginal);
  return {
    ...reachable,
    useHostReachability: (hostId: string) =>
      hostState.online
        ? reachable.useHostReachability()
        : {
            status: "unreachable" as const,
            hostLabel: hostId,
            unavailability: "offline" as const,
            basis: "directory" as const,
            hostKind: "unknown" as const,
          },
  };
});

/** Three rows tall: the window is these plus the list's overscan. */
const VIEWPORT_PX = 90;
const HOVER_CARD_DELAY_MS = 500;
const TOOLTIP_DELAY_MS = 150;
/** The row each case opens its overlay on: the top row, at scroll 0. */
const TARGET = "c0";
/** A row beside it, with nothing open: it must leave the window. */
const BYSTANDER = "c1";
const NEWER_COUNT = 40;
const INITIAL_ROWS = rootChats(6);
/** Rows that sort above every initial row. */
const NEWER_ROWS: readonly SeedChat[] = Array.from(
  { length: NEWER_COUNT },
  (_, i) => ({
    id: `new-${String(i)}`,
    parentId: null,
    updatedAt: 200_000 + i,
  }),
);

const opened: OpenedStoreForTest[] = [];
async function mountTree(online: boolean): Promise<OpenedStoreForTest> {
  hostState.online = online;
  chatTreeLayout.setViewport(VIEWPORT_PX);
  const session = openChatSession(INITIAL_ROWS);
  opened.push(session);
  // The lock on an offline owner's row is drawn for a chat whose owner is
  // known, as every chat the cloud has published has one.
  if (!online) {
    await applyEdit(session, () => {
      const chats = session.doc.getMap<unknown>("epic").get("chats");
      if (!(chats instanceof Y.Map))
        throw new Error("the doc has no chats map");
      session.doc.transact(() => {
        for (const chat of chats.values()) {
          if (chat instanceof Y.Map) chat.set("userId", "user-1");
        }
      });
    });
  }
  render(
    <QueryClientProvider client={new QueryClient()}>
      <EpicSessionContext.Provider value={session}>
        <TooltipProvider delayDuration={TOOLTIP_DELAY_MS}>
          <DndContext>
            <ChatTreePanelBody
              epicId={EPIC_ID}
              tabId={TAB_ID}
              messageHits={CHAT_TREE_MESSAGE_HITS_NONE}
            />
          </DndContext>
        </TooltipProvider>
      </EpicSessionContext.Provider>
    </QueryClientProvider>,
  );
  expect(screen.getByTestId(`epic-sidebar-item-${TARGET}`)).toBeTruthy();
  expect(screen.getByTestId(`epic-sidebar-item-${BYSTANDER}`)).toBeTruthy();
  return session;
}
function rowOf(id: string): HTMLElement | null {
  return screen.queryByTestId(`epic-sidebar-item-${id}`);
}
async function applyEdit(
  session: OpenedStoreForTest,
  edit: () => void,
): Promise<void> {
  await act(async () => {
    edit();
    // The bridge's flush waits on macrotasks: with fake timers they are
    // advanced here, or the flush never returns.
    const flushed = session.flush();
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
    await flushed;
  });
}
/**
 * Puts `NEWER_COUNT` rows above every row, so the window (at scroll 0) no
 * longer reaches the initial ones. The bystander, with nothing open, goes.
 */
async function pushRowsOutOfWindow(session: OpenedStoreForTest): Promise<void> {
  await applyEdit(session, () => {
    for (const chat of NEWER_ROWS) upsertChat(session, chat);
  });
  expect(rowOf(BYSTANDER)).toBeNull();
  // The newest row sorts first, so it is the one drawn at the top.
  expect(rowOf(NEWER_ROWS[NEWER_COUNT - 1].id)).not.toBeNull();
}
async function deleteChat(
  session: OpenedStoreForTest,
  chatId: string,
): Promise<void> {
  await applyEdit(session, () => {
    const chats = session.doc.getMap<unknown>("epic").get("chats");
    if (!(chats instanceof Y.Map)) throw new Error("the doc has no chats map");
    session.doc.transact(() => {
      chats.delete(chatId);
    });
  });
}

beforeEach(() => {
  chatTreeLayout.reset();
  useAuthStore.setState({
    status: "signed-in",
    contextMetadata: { userId: "user-1", username: "user-1" },
  });
});
afterEach(() => {
  cleanup();
  for (const handle of opened.splice(0)) handle.dispose();
  useAuthStore.setState(useAuthStore.getInitialState(), true);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("an open overlay holds its chat-tree row in the window", () => {
  it("keeps a row with its ⋯ menu open, and lets it go when the menu closes", async () => {
    const user = userEvent.setup();
    const session = await mountTree(true);
    // A click would also focus the ⋯ button, and a focused row stays mounted
    // for the keyboard; a press that takes no focus leaves the menu's hold the
    // only thing keeping the row while the menu is open.
    act(() => {
      screen.getByTestId(`epic-sidebar-more-${TARGET}`).dispatchEvent(
        new MouseEvent("pointerdown", {
          bubbles: true,
          cancelable: true,
          button: 0,
        }),
      );
    });
    await waitFor(() => {
      expect(screen.getByRole("menu")).toBeTruthy();
    });
    await pushRowsOutOfWindow(session);
    expect(rowOf(TARGET)).not.toBeNull();
    expect(screen.getByRole("menu")).toBeTruthy();
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(rowOf(TARGET)).toBeNull();
    });
  });
  it("keeps a row with its context menu open, and lets it go when the menu closes", async () => {
    const user = userEvent.setup();
    const session = await mountTree(true);
    // A right-click would also focus the row, and the focused row stays
    // mounted for the keyboard; a menu opened without focus leaves its hold
    // the only thing keeping the row.
    fireEvent.contextMenu(screen.getByTestId(`epic-sidebar-item-${TARGET}`), {
      clientX: 40,
      clientY: 12,
    });
    await waitFor(() => {
      expect(screen.getByRole("menu")).toBeTruthy();
    });
    await pushRowsOutOfWindow(session);
    expect(rowOf(TARGET)).not.toBeNull();
    expect(screen.getByRole("menu")).toBeTruthy();
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(rowOf(TARGET)).toBeNull();
    });
  });
  it("keeps a row with its hover card open, and lets it go when the card closes", async () => {
    vi.useFakeTimers();
    const user = userEvent.setup({
      delay: null,
      advanceTimers: vi.advanceTimersByTimeAsync,
    });
    const session = await mountTree(true);
    const hovered = user.hover(
      screen.getByTestId(`epic-sidebar-item-${TARGET}`),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOVER_CARD_DELAY_MS);
    });
    await hovered;
    expect(
      screen.getByTestId(`chat-navigator-hover-title-${TARGET}`),
    ).toBeTruthy();
    await pushRowsOutOfWindow(session);
    expect(rowOf(TARGET)).not.toBeNull();
    expect(
      screen.getByTestId(`chat-navigator-hover-title-${TARGET}`),
    ).toBeTruthy();
    const left = user.unhover(
      screen.getByTestId(`epic-sidebar-item-${TARGET}`),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await left;
    fireEvent.pointerMove(document, { clientX: 9999, clientY: 9999 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(
      screen.queryByTestId(`chat-navigator-hover-title-${TARGET}`),
    ).toBeNull();
    expect(rowOf(TARGET)).toBeNull();
  });
  it("keeps a row with a tooltip on it open, and lets it go when the tooltip closes", async () => {
    vi.useFakeTimers();
    const user = userEvent.setup({
      delay: null,
      advanceTimers: vi.advanceTimersByTimeAsync,
    });
    const session = await mountTree(false);
    // The offline lock's tooltip is a `LazySidebarTooltipWrapper`, whose
    // Radix root mounts in a 0 ms task after the pointer first enters.
    const lock = screen.getByTestId(`epic-sidebar-tree-lock-${TARGET}`);
    const hovered = user.hover(lock);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TOOLTIP_DELAY_MS);
    });
    await hovered;
    expect(screen.getByRole("tooltip").textContent).toMatch(
      /last published copy/,
    );
    await pushRowsOutOfWindow(session);
    expect(rowOf(TARGET)).not.toBeNull();
    expect(screen.getByRole("tooltip")).toBeTruthy();
    const current = screen.getByTestId(`epic-sidebar-tree-lock-${TARGET}`);
    fireEvent.pointerLeave(current);
    const left = user.unhover(current);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    await left;
    fireEvent.pointerMove(document, { clientX: 9999, clientY: 9999 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(rowOf(TARGET)).toBeNull();
  });
  it("takes a hover card with its row when the row's node is deleted", async () => {
    vi.useFakeTimers();
    const user = userEvent.setup({
      delay: null,
      advanceTimers: vi.advanceTimersByTimeAsync,
    });
    const consoleError = vi.spyOn(console, "error");
    const session = await mountTree(true);
    const hovered = user.hover(
      screen.getByTestId(`epic-sidebar-item-${TARGET}`),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOVER_CARD_DELAY_MS);
    });
    await hovered;
    expect(
      screen.getByTestId(`chat-navigator-hover-title-${TARGET}`),
    ).toBeTruthy();
    await deleteChat(session, TARGET);
    // At once: a row whose node is gone does not fade out with its card.
    expect(rowOf(TARGET)).toBeNull();
    expect(
      document.body.querySelectorAll('[data-slot="hover-card-content"]'),
    ).toHaveLength(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(rowOf(TARGET)).toBeNull();
    expect(
      screen.queryByTestId(`chat-navigator-hover-title-${TARGET}`),
    ).toBeNull();
    expect(
      document.body.querySelectorAll('[data-slot="hover-card-content"]'),
    ).toHaveLength(0);
    // The harness's own notice that user-event's async wrapper ran a timer
    // outside `act` is not the card's.
    expect(
      consoleError.mock.calls.filter(
        ([first]) => !String(first).includes("not configured to support act"),
      ),
    ).toEqual([]);
    // The rest of the tree is untouched.
    expect(rowOf(BYSTANDER)).not.toBeNull();
  });
});

it("pins a controlled tooltip only while its label can be shown", () => {
  const release = vi.fn();
  const hold = vi.fn(() => release);
  function view(suppressed: boolean, label: string) {
    return (
      <TooltipProvider>
        <OverlayAnchorHoldContext.Provider value={hold}>
          <TooltipsSuppressedProvider value={suppressed}>
            <TooltipWrapper
              label={label}
              open
              side="top"
              sideOffset={undefined}
              align={undefined}
            >
              <button type="button">Trigger</button>
            </TooltipWrapper>
          </TooltipsSuppressedProvider>
        </OverlayAnchorHoldContext.Provider>
      </TooltipProvider>
    );
  }
  const { rerender } = render(view(false, ""));
  expect(hold).not.toHaveBeenCalled();

  rerender(view(false, "Shown"));
  expect(hold).toHaveBeenCalledTimes(1);
  rerender(view(true, "Shown"));
  expect(release).toHaveBeenCalledTimes(1);
  expect(hold).toHaveBeenCalledTimes(1);
});
