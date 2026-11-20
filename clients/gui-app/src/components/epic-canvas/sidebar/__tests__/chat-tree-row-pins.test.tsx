import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { chatTreeLayout } from "@/__tests__/chat-tree-virtual-layout";
import { useAuthStore } from "@/stores/auth/auth-store";
import type { OpenedStoreForTest } from "@/stores/epics/open-epic/test-support/open-store-for-test";
import {
  mountedChatIds,
  openChatSession,
  renderChatTree,
  rootChats,
} from "./chat-tree-test-support";

/**
 * A rename in progress and an open delete confirmation belong to their row:
 * scrolling the row out of the window must not take them with it.
 */

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

const VIEWPORT_PX = 280;
const ROW_PITCH_PX = 30;
const FAR_OFFSET_PX = 60 * ROW_PITCH_PX;

let session: OpenedStoreForTest | null = null;

beforeEach(() => {
  chatTreeLayout.reset();
  chatTreeLayout.setViewport(VIEWPORT_PX);
  useAuthStore.setState({
    status: "signed-in",
    contextMetadata: { userId: "user-1", username: "user-1" },
  });
  session = openChatSession(rootChats(100));
  renderChatTree(session);
});

afterEach(() => {
  cleanup();
  session?.dispose();
  session = null;
  useAuthStore.setState(useAuthStore.getInitialState(), true);
});

async function chooseFromMenu(rowId: string, item: string): Promise<void> {
  const user = userEvent.setup();
  await user.click(screen.getByTestId(`epic-sidebar-more-${rowId}`));
  await user.click(await screen.findByTestId(`${item}-${rowId}`));
}

describe("a row's own state while it is scrolled out of the window", () => {
  it("keeps the rename input and its typed text after the row scrolls far out of the window", async () => {
    await chooseFromMenu("c2", "epic-sidebar-rename");
    const input = await screen.findByTestId("epic-sidebar-rename-input-c2");
    const user = userEvent.setup();
    await user.clear(input);
    await user.type(input, "Half-typed name");

    chatTreeLayout.scrollTo(FAR_OFFSET_PX);

    expect(mountedChatIds()).toContain("c2");
    expect(mountedChatIds()).toContain("c60");
    expect(screen.getByTestId("epic-sidebar-rename-input-c2")).toBe(input);
    expect((input as HTMLInputElement).value).toBe("Half-typed name");
  });

  it("keeps an open delete confirmation after the row scrolls far out of the window", async () => {
    // Opened from the context menu, so no row takes focus and only the
    // confirmation's own pin holds the row.
    fireEvent.contextMenu(screen.getByTestId("epic-sidebar-item-c2"), {
      clientX: 40,
      clientY: 12,
    });
    await userEvent
      .setup()
      .click(await screen.findByTestId("epic-sidebar-context-delete-c2"));
    expect(await screen.findByText(/Delete .*Title c2/)).toBeTruthy();

    chatTreeLayout.scrollTo(FAR_OFFSET_PX);

    expect(mountedChatIds()).toContain("c2");
    expect(screen.getByText(/Delete .*Title c2/)).toBeTruthy();
  });

  it("lets the row unmount once the rename is cancelled", async () => {
    await chooseFromMenu("c2", "epic-sidebar-rename");
    const input = await screen.findByTestId("epic-sidebar-rename-input-c2");
    chatTreeLayout.scrollTo(FAR_OFFSET_PX);
    expect(mountedChatIds()).toContain("c2");

    const user = userEvent.setup();
    await user.click(input);
    await user.keyboard("{Escape}");
    // Escape hands focus back to the row, and a focused row stays mounted.
    // Focus moves to another row, so only the ended rename could hold it.
    act(() => {
      screen.getByTestId("epic-sidebar-item-c0").focus();
    });

    await waitFor(() => {
      expect(mountedChatIds()).not.toContain("c2");
    });
  });
});
