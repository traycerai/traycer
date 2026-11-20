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
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
import { chatTreeLayout } from "@/__tests__/chat-tree-virtual-layout";
import { ChatTreePanelBody } from "@/components/epic-canvas/sidebar/epic-sidebar-chat-tree";
import { CHAT_TREE_MESSAGE_HITS_NONE } from "@/components/epic-canvas/sidebar/epic-sidebar-message-hits-state";
import { TooltipProvider } from "@/components/ui/tooltip";
import { EpicSessionContext } from "@/lib/registries/epic-session-registry";
import { useAuthStore } from "@/stores/auth/auth-store";
import type { EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import {
  openStoreForTest,
  type OpenedStoreForTest,
} from "@/stores/epics/open-epic/test-support/open-store-for-test";
import type { ChatProjection, TreeNode } from "@/stores/epics/open-epic/types";

// jsdom lays nothing out: the chat tree is virtualised, so its window comes
// from the shared layout stand-in.
vi.mock("@tanstack/react-virtual", async (importOriginal) =>
  (await import("@/__tests__/chat-tree-virtual-layout")).mockReactVirtual(
    importOriginal,
  ),
);
vi.mock("@/hooks/host/use-host-client-for-host-id", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/hooks/host/use-host-client-for-host-id")
    >();
  return { ...actual, useHostClientForHostId: () => null };
});
vi.mock("@/hooks/agent/use-host-reachability", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/hooks/agent/use-host-reachability")
    >();
  return {
    ...actual,
    useHostReachability: (hostId: string) =>
      hostId === OFFLINE_HOST_ID
        ? {
            status: "unreachable" as const,
            hostLabel: "Tanveer's laptop",
            unavailability: "offline" as const,
            basis: "directory" as const,
            hostKind: "unknown" as const,
          }
        : {
            status: "reachable" as const,
            hostLabel: "This machine",
            unavailability: null,
            basis: "directory" as const,
            hostKind: "local" as const,
          },
  };
});
const OFFLINE_HOST_ID = vi.hoisted(() => "host-offline");
const OWNER_PR_REFERENCES = vi.hoisted(() =>
  Object.freeze({
    references: [],
    isPending: false,
    error: false,
    sendRefresh: () => undefined,
  }),
);
vi.mock("@/hooks/pr/use-owner-pr-references", () => ({
  useOwnerListPrReferences: () => OWNER_PR_REFERENCES,
}));
vi.mock(
  "@/hooks/notifications/use-host-notification-indicators-query",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/hooks/notifications/use-host-notification-indicators-query")
      >();
    const { EMPTY_INDICATOR_STATE_RESPONSE } =
      await import("@/stores/notifications/notification-indicator-state");
    const frozen = {
      data: EMPTY_INDICATOR_STATE_RESPONSE,
      isPending: false,
      isFetching: false,
      error: null,
      refetch: (): Promise<void> => Promise.resolve(),
    } as const;
    return { ...actual, useHostNotificationIndicators: () => frozen };
  },
);

const EPIC_ID = "epic-overlay-anchor-hold";
const TAB_ID = "tab-overlay-anchor-hold";
const USER_ID = "viewer-1";
const HOST_ID = "host-a";
/** Three rows tall: the window is these plus the list's overscan. */
const VIEWPORT_PX = 90;
const HOVER_CARD_DELAY_MS = 500;
const TOOLTIP_DELAY_MS = 150;
/** The row each case opens its overlay on: the top row, at scroll 0. */
const TARGET = "chat-0";
/** A row beside it, with nothing open: it must leave the window. */
const BYSTANDER = "chat-1";
const NEWER_COUNT = 40;

interface RowSpec {
  readonly id: string;
  /** The tree sorts newest first. */
  readonly updatedAt: number;
}
const INITIAL_ROWS: readonly RowSpec[] = Array.from({ length: 6 }, (_, i) => ({
  id: `chat-${String(i)}`,
  updatedAt: 1000 - i,
}));
/** Rows that sort above every initial row. */
const NEWER_ROWS: readonly RowSpec[] = Array.from(
  { length: NEWER_COUNT },
  (_, i) => ({ id: `new-${String(i)}`, updatedAt: 2000 + i }),
);

function meta(): SnapshotMetaEpic {
  return {
    schemaVersion: "1.0",
    epicLight: {
      id: EPIC_ID,
      title: "Overlay anchor hold",
      initialUserPrompt: "",
      ticketCount: 0,
      specCount: 0,
      storyCount: 0,
      reviewCount: 0,
      status: "open",
      createdAt: 0,
      updatedAt: 0,
      createdBy: "user",
      version: "1",
    },
    permissionRole: "editor",
    repos: [],
    workspaces: [],
    repoMapping: [],
    workspaceFolders: [],
    unresolvedRepos: [],
    hostStateVectorBase64: "AA==",
  };
}
function seedDoc(): Uint8Array {
  const donor = new Y.Doc();
  const epic = donor.getMap<unknown>("epic");
  epic.set("title", "Overlay anchor hold");
  epic.set("artifacts", new Y.Map<unknown>());
  epic.set("tuiAgents", new Y.Map<unknown>());
  epic.set("chats", new Y.Map<unknown>());
  return Y.encodeStateAsUpdate(donor);
}
function openSession(): OpenedStoreForTest {
  const captured: { value: EpicStreamCallbacks | null } = { value: null };
  const factory: EpicStreamClientFactory = (_id, callbacks) => {
    captured.value = callbacks;
    return {
      applyUpdate: () => undefined,
      awareness: () => undefined,
      applyArtifactRoomUpdate: () => undefined,
      artifactRoomAwareness: () => undefined,
      retryMigration: () => undefined,
      close: () => undefined,
    };
  };
  const handle = openStoreForTest({
    epicId: EPIC_ID,
    userId: USER_ID,
    factories: { streamClientFactory: factory, laneSelection: null },
    writeCommand: null,
  });
  if (captured.value === null) throw new Error("factory not invoked");
  captured.value.onSnapshot(meta(), seedDoc());
  return handle;
}
function treeNode(spec: RowSpec): TreeNode {
  return {
    id: spec.id,
    parentId: null,
    title: `Agent ${spec.id}`,
    type: "chat",
    status: null,
    createdAt: 1,
    updatedAt: spec.updatedAt,
  };
}
/** The host the target row's chat lives on: offline only for the lock case. */
const targetHost: { value: string } = { value: HOST_ID };
function chatProjection(spec: RowSpec): ChatProjection {
  return {
    id: spec.id,
    title: `Agent ${spec.id}`,
    parentId: null,
    createdAt: 1,
    updatedAt: spec.updatedAt,
    userId: USER_ID,
    ownedByViewer: true,
    hostId: spec.id === TARGET ? targetHost.value : HOST_ID,
    isTitleEditedByUser: false,
    docResident: false,
    archivedAt: null,
    settings: null,
  };
}
/** Replaces the task's chats with `rows`, all roots. */
function setRows(session: OpenedStoreForTest, rows: readonly RowSpec[]): void {
  const nodeById: Record<string, TreeNode> = {};
  const byId: Record<string, ChatProjection> = {};
  for (const row of rows) {
    nodeById[row.id] = treeNode(row);
    byId[row.id] = chatProjection(row);
  }
  act(() => {
    session.store.setState({
      tree: {
        rootIds: rows.map((row) => row.id),
        childrenByParent: {},
        nodeById,
      },
      chats: { allIds: Object.keys(byId), byId },
    });
  });
}
const opened: OpenedStoreForTest[] = [];
function mountTree(hostOfTarget: string): OpenedStoreForTest {
  targetHost.value = hostOfTarget;
  chatTreeLayout.setViewport(VIEWPORT_PX);
  const session = openSession();
  opened.push(session);
  setRows(session, INITIAL_ROWS);
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
/**
 * Puts `NEWER_COUNT` rows above every row, so the window (at scroll 0) no
 * longer reaches the initial ones. The bystander, with nothing open, goes.
 */
function pushRowsOutOfWindow(session: OpenedStoreForTest): void {
  setRows(session, [...NEWER_ROWS, ...INITIAL_ROWS]);
  expect(rowOf(BYSTANDER)).toBeNull();
  // The newest row sorts first, so it is the one drawn at the top.
  expect(rowOf(NEWER_ROWS[NEWER_COUNT - 1].id)).not.toBeNull();
}

beforeEach(() => {
  chatTreeLayout.reset();
  useAuthStore.setState({
    status: "signed-in",
    contextMetadata: { userId: USER_ID, username: USER_ID },
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
    const session = mountTree(HOST_ID);
    await user.click(screen.getByTestId(`epic-sidebar-more-${TARGET}`));
    await waitFor(() => {
      expect(screen.getByRole("menu")).toBeTruthy();
    });
    pushRowsOutOfWindow(session);
    expect(rowOf(TARGET)).not.toBeNull();
    expect(screen.getByRole("menu")).toBeTruthy();
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(rowOf(TARGET)).toBeNull();
    });
  });

  it("keeps a row with its context menu open, and lets it go when the menu closes", async () => {
    const user = userEvent.setup();
    const session = mountTree(HOST_ID);
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
    pushRowsOutOfWindow(session);
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
    const session = mountTree(HOST_ID);
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
    pushRowsOutOfWindow(session);
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
    const session = mountTree(OFFLINE_HOST_ID);
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
    pushRowsOutOfWindow(session);
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
    const session = mountTree(HOST_ID);
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
    setRows(
      session,
      INITIAL_ROWS.filter((row) => row.id !== TARGET),
    );
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
