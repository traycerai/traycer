/**
 * First-use overlay mounting for desktop sidebar chat, artifact, and cloud
 * chat rows.
 *
 * Overlay roots must stay unmounted on a never-touched row, and the FIRST
 * gesture that needs one must still open it on that same event. The
 * context-menu cases are the coordinator's stop condition: if the first
 * `contextmenu` cannot open the menu at the pointer, C is dropped.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { userEvent, type UserEvent } from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DndContext } from "@dnd-kit/core";
import * as Y from "yjs";
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
import { EpicSessionContext } from "@/lib/registries/epic-session-registry";
import { ArtifactTreePanelBody } from "@/components/epic-canvas/sidebar/epic-sidebar-artifact-tree";
import { ChatTreePanelBody } from "@/components/epic-canvas/sidebar/epic-sidebar-chat-tree";
import { EpicSidebarCloudChatRow } from "@/components/epic-canvas/sidebar/epic-sidebar-cloud-chat-row";
import { CHAT_TREE_MESSAGE_HITS_NONE } from "@/components/epic-canvas/sidebar/epic-sidebar-message-hits-state";
import { STATUS_LABELS } from "@/components/epic-canvas/sidebar/epic-sidebar-tree-shared";
import { useNewConversationModalOpenStore } from "@/stores/epics/new-conversation-modal-open-store";
import { type EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import {
  openStoreForTest,
  type OpenedStoreForTest,
} from "@/stores/epics/open-epic/test-support/open-store-for-test";
import {
  getPaneScopedDndId,
  getSidebarNodeDragId,
  getSidebarReparentRowDropId,
} from "@/components/epic-canvas/dnd/dnd";
import {
  SidebarBulkSelectionProvider,
  useSidebarBulkSelection,
} from "@/components/epic-canvas/sidebar/epic-sidebar-selection";
import { useEffect, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TooltipProvider } from "@/components/ui/tooltip";

const overlayMounted = vi.hoisted(() => ({
  contextMenu: 0,
  dropdownMenu: 0,
  tooltip: 0,
  tooltipWrapper: 0,
  hoverCard: 0,
  confirmDialog: 0,
}));

const dndRegistrations = vi.hoisted(() => ({
  draggableIds: [] as string[],
  droppableIds: [] as string[],
}));

const OWNER_PR_REFERENCES = vi.hoisted(() =>
  Object.freeze({
    references: [],
    isPending: false,
    error: false,
    sendRefresh: () => undefined,
  }),
);

vi.mock("@/hooks/host/use-host-client-for-host-id", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/hooks/host/use-host-client-for-host-id")
    >();
  return { ...actual, useHostClientForHostId: () => null };
});

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

vi.mock("@/hooks/agent/use-host-reachability", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/hooks/agent/use-host-reachability")
    >();
  return {
    ...actual,
    useHostReachability: (hostId: string) => {
      if (hostId === "host-b") {
        return {
          status: "unreachable" as const,
          hostLabel: "Tanveer's laptop",
          unavailability: "offline" as const,
          basis: "directory" as const,
          hostKind: "unknown" as const,
        };
      }
      // Every seeded row's owner is "host-a". The real hook resolves this
      // from a host directory query whose result depends on real elapsed
      // time (`useLoadDeadline`) - fine for the overlay-mounting assertions
      // this file mostly makes, but a row action that is gated on
      // `canMutate` (New child agent, rename, delete) needs a STABLE
      // "reachable" verdict so it isn't a coin flip against whatever fake
      // timers an earlier test in this file left the clock at.
      if (hostId === "host-a") {
        return {
          status: "reachable" as const,
          hostLabel: "This machine",
          unavailability: null,
          basis: "directory" as const,
          hostKind: "local" as const,
        };
      }
      return actual.useHostReachability(hostId);
    },
  };
});

vi.mock("@dnd-kit/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dnd-kit/core")>();
  return {
    ...actual,
    useDraggable: (input: Parameters<typeof actual.useDraggable>[0]) => {
      dndRegistrations.draggableIds.push(String(input.id));
      return actual.useDraggable(input);
    },
    useDroppable: (input: Parameters<typeof actual.useDroppable>[0]) => {
      dndRegistrations.droppableIds.push(String(input.id));
      return actual.useDroppable(input);
    },
  };
});

vi.mock("@/components/ui/context-menu", async (importOriginal) => {
  const React = await import("react");
  const actual =
    await importOriginal<typeof import("@/components/ui/context-menu")>();
  function ContextMenu(
    props: React.ComponentProps<typeof actual.ContextMenu>,
  ): React.ReactNode {
    React.useEffect(() => {
      overlayMounted.contextMenu += 1;
      return () => {
        overlayMounted.contextMenu -= 1;
      };
    }, []);
    return React.createElement(actual.ContextMenu, props);
  }
  return { ...actual, ContextMenu };
});

vi.mock("@/components/ui/dropdown-menu", async (importOriginal) => {
  const React = await import("react");
  const actual =
    await importOriginal<typeof import("@/components/ui/dropdown-menu")>();
  function DropdownMenuRoot(
    props: React.ComponentProps<typeof actual.DropdownMenu>,
  ): React.ReactNode {
    React.useEffect(() => {
      overlayMounted.dropdownMenu += 1;
      return () => {
        overlayMounted.dropdownMenu -= 1;
      };
    }, []);
    return React.createElement(actual.DropdownMenu, props);
  }
  return { ...actual, DropdownMenu: DropdownMenuRoot };
});

vi.mock("@/components/ui/tooltip", async (importOriginal) => {
  const React = await import("react");
  const actual =
    await importOriginal<typeof import("@/components/ui/tooltip")>();
  function Tooltip(
    props: React.ComponentProps<typeof actual.Tooltip>,
  ): React.ReactNode {
    React.useEffect(() => {
      overlayMounted.tooltip += 1;
      return () => {
        overlayMounted.tooltip -= 1;
      };
    }, []);
    return React.createElement(actual.Tooltip, props);
  }
  return { ...actual, Tooltip };
});

vi.mock("@/components/ui/tooltip-wrapper", async (importOriginal) => {
  const React = await import("react");
  const actual =
    await importOriginal<typeof import("@/components/ui/tooltip-wrapper")>();
  function TooltipWrapper(
    props: React.ComponentProps<typeof actual.TooltipWrapper>,
  ): React.ReactNode {
    React.useEffect(() => {
      overlayMounted.tooltipWrapper += 1;
      return () => {
        overlayMounted.tooltipWrapper -= 1;
      };
    }, []);
    return React.createElement(actual.TooltipWrapper, props);
  }
  return { ...actual, TooltipWrapper };
});

vi.mock("@/components/ui/hover-card", async (importOriginal) => {
  const React = await import("react");
  const actual =
    await importOriginal<typeof import("@/components/ui/hover-card")>();
  function HoverCard(
    props: React.ComponentProps<typeof actual.HoverCard>,
  ): React.ReactNode {
    React.useEffect(() => {
      overlayMounted.hoverCard += 1;
      return () => {
        overlayMounted.hoverCard -= 1;
      };
    }, []);
    return React.createElement(actual.HoverCard, props);
  }
  return { ...actual, HoverCard };
});

vi.mock(
  "@/components/ui/confirm-destructive-dialog",
  async (importOriginal) => {
    const React = await import("react");
    const actual =
      await importOriginal<
        typeof import("@/components/ui/confirm-destructive-dialog")
      >();
    function ConfirmDestructiveDialog(
      props: React.ComponentProps<typeof actual.ConfirmDestructiveDialog>,
    ): React.ReactNode {
      React.useEffect(() => {
        overlayMounted.confirmDialog += 1;
        return () => {
          overlayMounted.confirmDialog -= 1;
        };
      }, []);
      return React.createElement(actual.ConfirmDestructiveDialog, props);
    }
    return { ...actual, ConfirmDestructiveDialog };
  },
);

const EPIC_ID = "epic-first-use-overlays";
const TAB_ID = "tab-first-use";
const USER_ID = "user-1";
const ROW_A = "chat-a";
const ROW_B = "chat-b";
const TITLE_A = "Alpha chat";
const TITLE_B = "Beta chat";
const POINTER = { clientX: 142, clientY: 87 } as const;
const KEY_POINT = { clientX: 24, clientY: 40 } as const;
const ART_A = "ticket-a";
const ART_B = "spec-b";
const TITLE_ART_A = "Alpha ticket";
const TOOLTIP_DELAY_MS = 150;
/** Same summary the cloud-row suite already mounts. */
const CLOUD_CHAT: CloudChatSummary = {
  identity: {
    taskId: "d60781ca-e0d3-4318-bf2a-e03d8ce4e3a7",
    chatId: "56254cae-aa80-4d06-914c-5086cdd65e3c",
    ownerUserId: "user-1",
  },
  ownerHostId: "host-b",
  createdAt: 100,
  visibility: "task",
  title: "Walkthrough",
  isTitleEditedByUser: false,
  parentChatId: null,
  isArchived: false,
  runSettingsSummary: null,
  metadataUpdatedAt: 300,
  headSha256: null,
  publishedAt: 300,
  throughRecordSeq: null,
  isOwnedByViewer: true,
};

interface ContextMenuPoint {
  readonly clientX: number;
  readonly clientY: number;
}

function resetOverlayMounted(): void {
  overlayMounted.contextMenu = 0;
  overlayMounted.dropdownMenu = 0;
  overlayMounted.tooltip = 0;
  overlayMounted.tooltipWrapper = 0;
  overlayMounted.hoverCard = 0;
  overlayMounted.confirmDialog = 0;
}

function expectNoOverlayRoots(): void {
  // Row agent hover is eager (HoverCard). First-use dropdown, context-menu,
  // confirm, and leaf tooltip roots stay unmounted until a gesture.
  expect(overlayMounted.contextMenu).toBe(0);
  expect(overlayMounted.dropdownMenu).toBe(0);
  expect(overlayMounted.tooltip).toBe(0);
  expect(overlayMounted.tooltipWrapper).toBe(0);
  expect(overlayMounted.confirmDialog).toBe(0);
}

function makeMeta(): SnapshotMetaEpic {
  return {
    schemaVersion: "1.0",
    epicLight: {
      id: EPIC_ID,
      title: "First-use overlays",
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

function chatEntry(id: string, title: string): Y.Map<unknown> {
  const entry = new Y.Map<unknown>();
  entry.set("id", id);
  entry.set("title", title);
  entry.set("parentId", null);
  entry.set("createdAt", 1);
  entry.set("updatedAt", 1);
  entry.set("hostId", "host-a");
  entry.set("archivedAt", null);
  entry.set("messages", new Y.Array<unknown>());
  return entry;
}

function seedDoc(): Uint8Array {
  const donor = new Y.Doc();
  const epic = donor.getMap<unknown>("epic");
  const chats = new Y.Map<unknown>();
  chats.set(ROW_A, chatEntry(ROW_A, TITLE_A));
  chats.set(ROW_B, chatEntry(ROW_B, TITLE_B));
  epic.set("title", "First-use overlays");
  epic.set("artifacts", new Y.Map<unknown>());
  epic.set("tuiAgents", new Y.Map<unknown>());
  epic.set("chats", chats);
  return Y.encodeStateAsUpdate(donor);
}

function artifactEntry(
  id: string,
  kind: string,
  title: string,
  status: number | null,
): Y.Map<unknown> {
  const entry = new Y.Map<unknown>();
  entry.set("id", id);
  entry.set("kind", kind);
  entry.set("title", title);
  entry.set("parentId", null);
  entry.set("createdAt", 1);
  entry.set("updatedAt", 1);
  if (status !== null) entry.set("status", status);
  return entry;
}

function seedArtifactDoc(): Uint8Array {
  const donor = new Y.Doc();
  const epic = donor.getMap<unknown>("epic");
  const artifacts = new Y.Map<unknown>();
  artifacts.set(ART_A, artifactEntry(ART_A, "ticket", TITLE_ART_A, 0));
  artifacts.set(ART_B, artifactEntry(ART_B, "spec", "Beta spec", null));
  epic.set("title", "First-use overlays");
  epic.set("artifacts", artifacts);
  epic.set("tuiAgents", new Y.Map<unknown>());
  epic.set("chats", new Y.Map<unknown>());
  return Y.encodeStateAsUpdate(donor);
}

function openSeededStore(seed: Uint8Array): OpenedStoreForTest {
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
  captured.value.onSnapshot(makeMeta(), seed);
  return handle;
}

function createSession(): OpenedStoreForTest {
  return openSeededStore(seedDoc());
}

function createArtifactSession(): OpenedStoreForTest {
  return openSeededStore(seedArtifactDoc());
}

function captureContextMenuPoints(): {
  readonly events: ContextMenuPoint[];
  readonly stop: () => void;
} {
  const events: ContextMenuPoint[] = [];
  const onContextMenu = (event: Event): void => {
    if (!(event instanceof MouseEvent)) return;
    events.push({ clientX: event.clientX, clientY: event.clientY });
  };
  document.addEventListener("contextmenu", onContextMenu, true);
  return {
    events,
    stop: () => {
      document.removeEventListener("contextmenu", onContextMenu, true);
    },
  };
}

async function rightClickAt(
  user: UserEvent,
  element: Element,
  point: ContextMenuPoint,
): Promise<void> {
  await user.pointer({
    keys: "[MouseRight]",
    target: element,
    coords: {
      x: point.clientX,
      y: point.clientY,
      clientX: point.clientX,
      clientY: point.clientY,
    },
  });
}

/**
 * jsdom may construct pointer events without `pointerType`. The long-press
 * path keys off that field, so stamp it (and the press point) onto whatever
 * `fireEvent` built when the native constructor is missing.
 */
function firePointer(
  element: Element,
  type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel",
  pointerType: "touch" | "mouse" | "pen",
): void {
  if (typeof PointerEvent === "function") {
    fireEvent(
      element,
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        pointerType,
        isPrimary: true,
        button: 0,
        clientX: POINTER.clientX,
        clientY: POINTER.clientY,
      }),
    );
    return;
  }
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "pointerType", { value: pointerType });
  Object.defineProperty(event, "clientX", { value: POINTER.clientX });
  Object.defineProperty(event, "clientY", { value: POINTER.clientY });
  fireEvent(element, event);
}

function fireBrowserContextMenu(
  element: Element,
  point: ContextMenuPoint,
): void {
  fireEvent.contextMenu(element, {
    clientX: point.clientX,
    clientY: point.clientY,
    button: 2,
  });
}

function rowContextMenuTrigger(row: HTMLElement): HTMLElement {
  const wrapper = row.closest('[data-slot="context-menu-trigger"]');
  if (!(wrapper instanceof HTMLElement)) {
    throw new Error("expected the row drop wrapper");
  }
  return wrapper;
}

function EnterSelectionMode(props: { readonly children: ReactNode }) {
  const selection = useSidebarBulkSelection();
  const enter = selection.enterSelectionMode;
  useEffect(() => {
    enter();
  }, [enter]);
  return props.children;
}

function moreTriggerSnapshot(element: HTMLElement): {
  readonly tagName: string;
  readonly type: string | null;
  readonly ariaHasPopup: string | null;
  readonly ariaExpanded: string | null;
  readonly dataState: string | null;
  readonly ariaLabel: string | null;
  readonly testId: string | null;
} {
  return {
    tagName: element.tagName,
    type: element.getAttribute("type"),
    ariaHasPopup: element.getAttribute("aria-haspopup"),
    ariaExpanded: element.getAttribute("aria-expanded"),
    dataState: element.getAttribute("data-state"),
    ariaLabel: element.getAttribute("aria-label"),
    testId: element.getAttribute("data-testid"),
  };
}

const opened: OpenedStoreForTest[] = [];

function renderTree(): HTMLElement {
  const handle = createSession();
  opened.push(handle);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <EpicSessionContext.Provider value={handle}>
        <DndContext>
          <ChatTreePanelBody
            epicId={EPIC_ID}
            tabId={TAB_ID}
            messageHits={CHAT_TREE_MESSAGE_HITS_NONE}
          />
        </DndContext>
      </EpicSessionContext.Provider>
    </QueryClientProvider>,
  );
  return screen.getByTestId(`epic-sidebar-item-${ROW_A}`);
}

function renderTreeInSelectionMode(): HTMLElement {
  const handle = createSession();
  opened.push(handle);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <EpicSessionContext.Provider value={handle}>
        <DndContext>
          <SidebarBulkSelectionProvider panelId="chats" collapsed={false}>
            <EnterSelectionMode>
              <ChatTreePanelBody
                epicId={EPIC_ID}
                tabId={TAB_ID}
                messageHits={CHAT_TREE_MESSAGE_HITS_NONE}
              />
            </EnterSelectionMode>
          </SidebarBulkSelectionProvider>
        </DndContext>
      </EpicSessionContext.Provider>
    </QueryClientProvider>,
  );
  return screen.getByTestId(`epic-sidebar-item-${ROW_A}`);
}

function renderArtifactTree(): HTMLElement {
  const handle = createArtifactSession();
  opened.push(handle);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <EpicSessionContext.Provider value={handle}>
        <TooltipProvider delayDuration={150}>
          <DndContext>
            <ArtifactTreePanelBody epicId={EPIC_ID} tabId={TAB_ID} />
          </DndContext>
        </TooltipProvider>
      </EpicSessionContext.Provider>
    </QueryClientProvider>,
  );
  return screen.getByTestId(`epic-sidebar-item-${ART_A}`);
}

function renderCloudRow(): HTMLElement {
  const handle = createSession();
  opened.push(handle);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <EpicSessionContext.Provider value={handle}>
        <TooltipProvider delayDuration={150}>
          <EpicSidebarCloudChatRow
            chat={CLOUD_CHAT}
            tabId={TAB_ID}
            depth={0}
            selectionMode={false}
          />
        </TooltipProvider>
      </EpicSessionContext.Provider>
    </QueryClientProvider>,
  );
  return screen.getByTestId(
    `epic-sidebar-cloud-item-${CLOUD_CHAT.identity.chatId}`,
  );
}

async function expectContextMenuVisible(
  nodeId: string,
  otherNodeId: string,
): Promise<void> {
  await waitFor(() => {
    expect(
      screen.getByTestId(`epic-sidebar-context-rename-${nodeId}`),
    ).toBeTruthy();
  });
  expect(screen.getByRole("menu")).toBeTruthy();
  expect(overlayMounted.contextMenu).toBe(1);
  expect(
    screen.queryByTestId(`epic-sidebar-context-rename-${otherNodeId}`),
  ).toBeNull();
}

afterEach(() => {
  cleanup();
  for (const handle of opened.splice(0)) handle.dispose();
  dndRegistrations.draggableIds = [];
  dndRegistrations.droppableIds = [];
  resetOverlayMounted();
  useNewConversationModalOpenStore.getState().close();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("sidebar row first-use overlays", () => {
  it("mounts no overlay roots on a never-touched row", () => {
    renderTree();
    expect(screen.getByTestId(`epic-sidebar-item-${ROW_A}`)).toBeTruthy();
    expect(screen.getByTestId(`epic-sidebar-item-${ROW_B}`)).toBeTruthy();
    expectNoOverlayRoots();
  });

  it("opens the context menu on the first right-click at that pointer", async () => {
    const user = userEvent.setup();
    const row = renderTree();
    expectNoOverlayRoots();
    const captured = captureContextMenuPoints();
    try {
      await rightClickAt(user, row, POINTER);
      await expectContextMenuVisible(ROW_A, ROW_B);
      expect(captured.events.length).toBeGreaterThanOrEqual(2);
      expect(captured.events[0]).toEqual(POINTER);
      expect(captured.events[captured.events.length - 1]).toEqual(POINTER);
    } finally {
      captured.stop();
    }
  });

  it("opens the context menu on the first browser contextmenu event at the focused row", async () => {
    const row = renderTree();
    expectNoOverlayRoots();
    row.focus();
    fireBrowserContextMenu(row, KEY_POINT);
    await expectContextMenuVisible(ROW_A, ROW_B);
  });

  it("returns focus to the same row button after closing a first-use context menu with Escape", async () => {
    const user = userEvent.setup();
    const row = renderTree();
    row.focus();
    fireBrowserContextMenu(row, KEY_POINT);
    await expectContextMenuVisible(ROW_A, ROW_B);
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("menu")).toBeNull();
    });
    expect(document.activeElement).toBe(row);
  });

  it("keeps the row wrapper and button nodes connected across the first context-menu open", async () => {
    const user = userEvent.setup();
    const row = renderTree();
    const wrapper = rowContextMenuTrigger(row);
    expectNoOverlayRoots();
    await rightClickAt(user, row, POINTER);
    await expectContextMenuVisible(ROW_A, ROW_B);
    expect(wrapper.isConnected).toBe(true);
    expect(row.isConnected).toBe(true);
    expect(
      rowContextMenuTrigger(screen.getByTestId(`epic-sidebar-item-${ROW_A}`)),
    ).toBe(wrapper);
    expect(screen.getByTestId(`epic-sidebar-item-${ROW_A}`)).toBe(row);
  });

  it("keeps focus on the same selection checkbox through a right-click in selection mode, which opens no menu", async () => {
    const user = userEvent.setup();
    renderTreeInSelectionMode();
    const checkbox = screen.getByTestId(`epic-sidebar-select-${ROW_A}`);
    checkbox.focus();
    const focused = document.activeElement;
    if (!(focused instanceof HTMLInputElement)) {
      throw new Error("expected the row checkbox");
    }
    // Selection mode withdraws the row context menu entirely (its
    // `contextMenu` prop is `null` while `selectionMode` is true), so this
    // right-click is a genuine no-op - confirmed by the wrapper never
    // mounting a menu root, not merely by an end state that would also hold
    // if the gesture had done nothing at all for some other reason.
    fireBrowserContextMenu(focused, KEY_POINT);
    expect(screen.queryByRole("menu")).toBeNull();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(focused);
    expect(focused.isConnected).toBe(true);
  });

  it("keeps focus on the same selection checkbox when the row's name tooltip opens in selection mode", async () => {
    vi.useFakeTimers();
    const user = userEvent.setup({
      delay: null,
      advanceTimers: vi.advanceTimersByTimeAsync,
    });
    const row = renderTreeInSelectionMode();
    const checkbox = screen.getByTestId(`epic-sidebar-select-${ROW_A}`);
    checkbox.focus();
    const focused = document.activeElement;
    if (!(focused instanceof HTMLInputElement)) {
      throw new Error("expected the row checkbox");
    }
    // Selection mode drops owner-metadata hover (no host is passed while
    // bulk-selecting) and falls back to a plain full-name tooltip - same
    // stationary-hover timing pattern as "shows the hover card after the
    // normal 500ms delay on a stationary first hover": pointerenter arms the
    // 500ms intent timeout, and `user.hover`'s own `act` waits for it, so the
    // hover must be started before the timers are advanced.
    expect(screen.queryByRole("tooltip")).toBeNull();
    const hovered = user.hover(row);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    await hovered;
    expect(screen.getByRole("tooltip").textContent).toBe(TITLE_A);
    expect(document.activeElement).toBe(focused);
    expect(focused.isConnected).toBe(true);
    expect(screen.getByTestId(`epic-sidebar-item-${ROW_A}`)).toBe(row);
  });

  it("opens the context menu on a never-touched chat row after a 700ms touch long-press", async () => {
    vi.useFakeTimers();
    const row = renderTree();
    expectNoOverlayRoots();
    firePointer(row, "pointerdown", "touch");
    act(() => {
      vi.advanceTimersByTime(700);
    });
    vi.useRealTimers();
    await expectContextMenuVisible(ROW_A, ROW_B);
    // Close before the test ends: a Radix menu opened under fake timers and
    // then abandoned open at `cleanup()` corrupts Radix's own dismissable-
    // layer stack for whichever LATER test opens the next real menu - that
    // test's own keyboard activation silently no-ops with no error anywhere.
    await userEvent.setup().keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("menu")).toBeNull();
    });
  });

  it("cancels a touch long-press on pointerup before 700ms: no menu and no overlay roots", () => {
    vi.useFakeTimers();
    const row = renderTree();
    expectNoOverlayRoots();
    firePointer(row, "pointerdown", "touch");
    act(() => {
      vi.advanceTimersByTime(300);
    });
    firePointer(row, "pointerup", "touch");
    act(() => {
      vi.advanceTimersByTime(700);
    });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(
      screen.queryByTestId(`epic-sidebar-context-rename-${ROW_A}`),
    ).toBeNull();
    expectNoOverlayRoots();
  });

  it("cancels a touch long-press on pointermove: no menu after 700ms", () => {
    vi.useFakeTimers();
    const row = renderTree();
    firePointer(row, "pointerdown", "touch");
    firePointer(row, "pointermove", "touch");
    act(() => {
      vi.advanceTimersByTime(800);
    });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(
      screen.queryByTestId(`epic-sidebar-context-rename-${ROW_A}`),
    ).toBeNull();
  });

  it("does not open the context menu on a mouse pointerdown held for 1000ms", () => {
    vi.useFakeTimers();
    const row = renderTree();
    firePointer(row, "pointerdown", "mouse");
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(
      screen.queryByTestId(`epic-sidebar-context-rename-${ROW_A}`),
    ).toBeNull();
    expect(overlayMounted.contextMenu).toBe(0);
  });

  it("keeps a touch press on a never-touched More button from also arming the row's long-press context menu", () => {
    vi.useFakeTimers();
    try {
      renderTree();
      expectNoOverlayRoots();
      const more = screen.getByTestId(`epic-sidebar-more-${ROW_A}`);
      // The row wrapper's own long-press timer arms on the SAME pointerdown,
      // via bubbling from the More button - it must see that the trigger
      // already consumed this event (`preventDefault`) and skip arming.
      firePointer(more, "pointerdown", "touch");
      expect(screen.getAllByRole("menu")).toHaveLength(1);
      act(() => {
        vi.advanceTimersByTime(700);
      });
      expect(screen.getAllByRole("menu")).toHaveLength(1);
      expect(
        screen.queryByTestId(`epic-sidebar-context-rename-${ROW_A}`),
      ).toBeNull();
      expect(overlayMounted.contextMenu).toBe(0);
      expect(overlayMounted.dropdownMenu).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a pen press on a never-touched More button from also arming the row's long-press context menu", () => {
    vi.useFakeTimers();
    try {
      renderTree();
      expectNoOverlayRoots();
      const more = screen.getByTestId(`epic-sidebar-more-${ROW_A}`);
      firePointer(more, "pointerdown", "pen");
      expect(screen.getAllByRole("menu")).toHaveLength(1);
      act(() => {
        vi.advanceTimersByTime(700);
      });
      expect(screen.getAllByRole("menu")).toHaveLength(1);
      expect(
        screen.queryByTestId(`epic-sidebar-context-rename-${ROW_A}`),
      ).toBeNull();
      expect(overlayMounted.contextMenu).toBe(0);
      expect(overlayMounted.dropdownMenu).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("registers a never-touched row as draggable and as a drop target", () => {
    renderTree();
    expectNoOverlayRoots();
    expect(dndRegistrations.draggableIds).toEqual(
      expect.arrayContaining([
        getPaneScopedDndId(TAB_ID, getSidebarNodeDragId(ROW_A)),
        getPaneScopedDndId(TAB_ID, getSidebarNodeDragId(ROW_B)),
      ]),
    );
    expect(dndRegistrations.droppableIds).toEqual(
      expect.arrayContaining([
        getPaneScopedDndId(TAB_ID, getSidebarReparentRowDropId(ROW_A)),
        getPaneScopedDndId(TAB_ID, getSidebarReparentRowDropId(ROW_B)),
      ]),
    );
  });

  it("keeps never-touched row text, roles, and more-button aria equal to a closed Radix trigger", () => {
    const closed = render(
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={`Agent actions for ${TITLE_A}`}
            data-testid={`epic-sidebar-more-${ROW_A}`}
          >
            more
          </Button>
        </DropdownMenuTrigger>
      </DropdownMenu>,
    );
    const closedSnapshot = moreTriggerSnapshot(
      screen.getByTestId(`epic-sidebar-more-${ROW_A}`),
    );
    closed.unmount();
    resetOverlayMounted();

    const row = renderTree();
    const more = screen.getByTestId(`epic-sidebar-more-${ROW_A}`);
    expect(moreTriggerSnapshot(more)).toEqual(closedSnapshot);
    expect(row.getAttribute("data-testid")).toBe(`epic-sidebar-item-${ROW_A}`);
    expect(row.getAttribute("data-sidebar-node-id")).toBe(ROW_A);
    expect(row.getAttribute("data-artifact-type")).toBe("chat");
    expect(row.getAttribute("aria-label")).toBe(TITLE_A);
    expect(row.closest("[role='treeitem']")).not.toBeNull();
    expect(row.textContent).toContain(TITLE_A);
    expectNoOverlayRoots();
  });

  it("opens the more menu on the first click of a never-touched more button", async () => {
    const user = userEvent.setup();
    renderTree();
    expectNoOverlayRoots();
    await user.click(screen.getByTestId(`epic-sidebar-more-${ROW_A}`));
    await waitFor(() => {
      expect(screen.getByTestId(`epic-sidebar-rename-${ROW_A}`)).toBeTruthy();
    });
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(overlayMounted.dropdownMenu).toBe(1);
    expect(screen.queryByTestId(`epic-sidebar-rename-${ROW_B}`)).toBeNull();
  });

  it("names the open more menu from the trigger button that is in the DOM", async () => {
    const user = userEvent.setup();
    renderTree();
    await user.click(screen.getByTestId(`epic-sidebar-more-${ROW_A}`));
    await waitFor(() => {
      expect(screen.getByRole("menu")).toBeTruthy();
    });
    const trigger = screen.getByTestId(`epic-sidebar-more-${ROW_A}`);
    const menu = screen.getByRole("menu");
    expect(menu.getAttribute("aria-labelledby")).toBe(trigger.id);
    expect(trigger.id.length).toBeGreaterThan(0);
    const triggerName = trigger.getAttribute("aria-label");
    if (triggerName === null) throw new Error("expected the more trigger name");
    expect(screen.getByRole("menu", { name: triggerName })).toBe(menu);
  });

  it("opens the more menu on the first Enter of a focused more button", async () => {
    const user = userEvent.setup();
    renderTree();
    screen.getByTestId(`epic-sidebar-more-${ROW_A}`).focus();
    await user.keyboard("{Enter}");
    await waitFor(() => {
      expect(screen.getByTestId(`epic-sidebar-rename-${ROW_A}`)).toBeTruthy();
    });
    expect(overlayMounted.dropdownMenu).toBe(1);
  });

  it("focuses the first more-menu item on the first Enter of a never-touched trigger", async () => {
    const user = userEvent.setup();
    renderTree();
    screen.getByTestId(`epic-sidebar-more-${ROW_A}`).focus();
    await user.keyboard("{Enter}");
    await waitFor(() => {
      expect(screen.getByRole("menu")).toBeTruthy();
    });
    const firstItem = await waitFor(() => {
      const item = screen.getAllByRole("menuitem")[0];
      expect(document.activeElement).toBe(item);
      return item;
    });
    expect(document.activeElement).not.toBe(screen.getByRole("menu"));
    expect(document.activeElement).toBe(firstItem);

    // The next Enter must ACTIVATE that same focused item, not merely leave
    // it focused: "New child agent" is the first entry, and its handler is
    // the only thing in this test that opens the New Conversation modal.
    expect(useNewConversationModalOpenStore.getState().request).toBeNull();
    await user.keyboard("{Enter}");
    await waitFor(() => {
      expect(
        useNewConversationModalOpenStore.getState().request,
      ).not.toBeNull();
    });
    const request = useNewConversationModalOpenStore.getState().request;
    if (request === null) throw new Error("expected a modal open request");
    expect(request.parentId).toBe(ROW_A);
    expect(request.epicId).toBe(EPIC_ID);
  });

  it("opens the more menu on the first Space of a focused more button", async () => {
    const user = userEvent.setup();
    renderTree();
    screen.getByTestId(`epic-sidebar-more-${ROW_A}`).focus();
    await user.keyboard(" ");
    await waitFor(() => {
      expect(screen.getByTestId(`epic-sidebar-rename-${ROW_A}`)).toBeTruthy();
    });
    expect(overlayMounted.dropdownMenu).toBe(1);
  });

  it("shows the hover card after the normal 500ms delay on a stationary first hover", async () => {
    vi.useFakeTimers();
    const user = userEvent.setup({
      delay: null,
      advanceTimers: vi.advanceTimersByTimeAsync,
    });
    const row = renderTree();
    expectNoOverlayRoots();
    expect(overlayMounted.hoverCard).toBeGreaterThan(0);
    // `user.hover` is wrapped in Testing Library `act`. Pointerenter arms the
    // 500ms intent timeout, and that act waits for it, so awaiting hover
    // before advancing timers never resolves.
    const hovered = user.hover(row);
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(
      screen.queryByTestId(`chat-navigator-hover-title-${ROW_A}`),
    ).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    await hovered;
    expect(
      screen.getByTestId(`chat-navigator-hover-title-${ROW_A}`).textContent,
    ).toBe(TITLE_A);
  });

  it("starts a drag from a never-touched row on the first pointer drag", async () => {
    const started: string[] = [];
    const handle = createSession();
    opened.push(handle);
    render(
      <QueryClientProvider client={new QueryClient()}>
        <EpicSessionContext.Provider value={handle}>
          <DndContext
            onDragStart={(event) => {
              started.push(String(event.active.id));
            }}
          >
            <ChatTreePanelBody
              epicId={EPIC_ID}
              tabId={TAB_ID}
              messageHits={CHAT_TREE_MESSAGE_HITS_NONE}
            />
          </DndContext>
        </EpicSessionContext.Provider>
      </QueryClientProvider>,
    );
    const row = screen.getByTestId(`epic-sidebar-item-${ROW_A}`);
    expectNoOverlayRoots();
    const user = userEvent.setup();
    await user.pointer([
      { keys: "[MouseLeft>]", target: row, coords: { x: 10, y: 10 } },
      { coords: { x: 40, y: 12 } },
    ]);
    expect(started).toContain(
      getPaneScopedDndId(TAB_ID, getSidebarNodeDragId(ROW_A)),
    );
    // Release the button before the test ends. `dnd-kit`'s pointer sensor
    // attaches its move/up listeners at the DOCUMENT level for the duration
    // of the drag, and an unmount mid-drag does not fire the browser
    // gesture's own end - a later test's real keyboard activation of an
    // unrelated Radix menu item silently no-ops with those still attached.
    await user.pointer([{ keys: "[/MouseLeft]", target: row }]);
  });

  it("mounts no overlay roots on a never-touched artifact row", () => {
    renderArtifactTree();
    expect(screen.getByTestId(`epic-sidebar-item-${ART_A}`)).toBeTruthy();
    expect(screen.getByTestId(`epic-sidebar-item-${ART_B}`)).toBeTruthy();
    expectNoOverlayRoots();
  });

  it("opens the artifact more menu on the first click", async () => {
    const user = userEvent.setup();
    renderArtifactTree();
    expectNoOverlayRoots();
    await user.click(screen.getByTestId(`epic-sidebar-more-${ART_A}`));
    await waitFor(() => {
      expect(screen.getByTestId(`epic-sidebar-rename-${ART_A}`)).toBeTruthy();
    });
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(overlayMounted.dropdownMenu).toBe(1);
    expect(screen.queryByTestId(`epic-sidebar-rename-${ART_B}`)).toBeNull();
  });

  it("opens the artifact add-child menu on the first click of a never-touched add button", async () => {
    const user = userEvent.setup();
    renderArtifactTree();
    expectNoOverlayRoots();
    await user.click(screen.getByTestId(`epic-sidebar-add-${ART_A}`));
    await waitFor(() => {
      expect(screen.getByTestId(`epic-sidebar-add-spec-${ART_A}`)).toBeTruthy();
    });
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(overlayMounted.dropdownMenu).toBe(1);
    expect(screen.queryByTestId(`epic-sidebar-add-spec-${ART_B}`)).toBeNull();
  });

  it("opens the artifact add-child menu on the first Enter of a focused add button", async () => {
    const user = userEvent.setup();
    renderArtifactTree();
    expectNoOverlayRoots();
    screen.getByTestId(`epic-sidebar-add-${ART_A}`).focus();
    await user.keyboard("{Enter}");
    await waitFor(() => {
      expect(screen.getByTestId(`epic-sidebar-add-spec-${ART_A}`)).toBeTruthy();
    });
    expect(overlayMounted.dropdownMenu).toBe(1);
  });

  it("names the open add-child menu from the trigger button that is in the DOM", async () => {
    const user = userEvent.setup();
    renderArtifactTree();
    await user.click(screen.getByTestId(`epic-sidebar-add-${ART_A}`));
    await waitFor(() => {
      expect(screen.getByRole("menu")).toBeTruthy();
    });
    const trigger = screen.getByTestId(`epic-sidebar-add-${ART_A}`);
    const menu = screen.getByRole("menu");
    expect(menu.getAttribute("aria-labelledby")).toBe(trigger.id);
    expect(trigger.id.length).toBeGreaterThan(0);
    const triggerName = trigger.getAttribute("aria-label");
    if (triggerName === null) throw new Error("expected the add trigger name");
    expect(screen.getByRole("menu", { name: triggerName })).toBe(menu);
  });

  it("focuses the first add-menu item on the first Enter of a never-touched add button, then activates it on the next Enter", async () => {
    const user = userEvent.setup();
    renderArtifactTree();
    expectNoOverlayRoots();
    screen.getByTestId(`epic-sidebar-add-${ART_A}`).focus();
    await user.keyboard("{Enter}");
    await waitFor(() => {
      expect(screen.getByRole("menu")).toBeTruthy();
    });
    const firstItem = await waitFor(() => {
      const item = screen.getAllByRole("menuitem")[0];
      expect(document.activeElement).toBe(item);
      return item;
    });
    expect(document.activeElement).toBe(firstItem);

    // The next Enter must ACTIVATE that same focused item, not merely leave
    // it focused: the first addable kind ("ticket") queues a pending-create
    // row, which only that item's handler (`performAddChild`) produces.
    //
    // Dispatched with a plain, SYNCHRONOUS `fireEvent` inside `act`, not
    // `user.keyboard`: the pending row is a transient echo of an in-flight
    // mutation (this render has no host client, so `epic.createArtifact`
    // rejects and the pending row is cleared again on that rejection).
    // `user.keyboard` is itself async and yields to the microtask queue, so
    // by the time its promise settles the reject's `onError` has already run
    // and the row is gone again - the assertion would see nothing not
    // because the handler never ran, but because it ran AND finished. A
    // synchronous dispatch inside `act` flushes exactly the handler's own
    // synchronous state updates and returns before that microtask gets a
    // turn, so the still-pending row is what the assertion below observes.
    expect(screen.queryByTestId("epic-sidebar-pending-create")).toBeNull();
    act(() => {
      fireEvent.keyDown(firstItem, { key: "Enter", code: "Enter" });
    });
    expect(screen.getByTestId("epic-sidebar-pending-create")).toBeTruthy();
    expect(
      screen.getByTestId("epic-sidebar-pending-create").textContent,
    ).toContain("New ticket");
  });

  it("opens the artifact add-child menu on the first Space of a focused add button", async () => {
    const user = userEvent.setup();
    renderArtifactTree();
    expectNoOverlayRoots();
    screen.getByTestId(`epic-sidebar-add-${ART_A}`).focus();
    await user.keyboard(" ");
    await waitFor(() => {
      expect(screen.getByTestId(`epic-sidebar-add-spec-${ART_A}`)).toBeTruthy();
    });
    expect(overlayMounted.dropdownMenu).toBe(1);
  });

  it("keeps a touch press on a never-touched artifact Add button from also arming the row's long-press context menu", () => {
    vi.useFakeTimers();
    try {
      renderArtifactTree();
      expectNoOverlayRoots();
      const add = screen.getByTestId(`epic-sidebar-add-${ART_A}`);
      firePointer(add, "pointerdown", "touch");
      expect(screen.getAllByRole("menu")).toHaveLength(1);
      act(() => {
        vi.advanceTimersByTime(700);
      });
      expect(screen.getAllByRole("menu")).toHaveLength(1);
      expect(
        screen.queryByTestId(`epic-sidebar-context-rename-${ART_A}`),
      ).toBeNull();
      expect(overlayMounted.contextMenu).toBe(0);
      expect(overlayMounted.dropdownMenu).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens the artifact context menu on the first right-click at that pointer", async () => {
    const user = userEvent.setup();
    const row = renderArtifactTree();
    expectNoOverlayRoots();
    const captured = captureContextMenuPoints();
    try {
      await rightClickAt(user, row, POINTER);
      await expectContextMenuVisible(ART_A, ART_B);
      expect(captured.events.length).toBeGreaterThanOrEqual(2);
      expect(captured.events[0]).toEqual(POINTER);
      expect(captured.events[captured.events.length - 1]).toEqual(POINTER);
    } finally {
      captured.stop();
    }
  });

  it("shows the artifact status tooltip after the normal delay on a stationary first hover", async () => {
    vi.useFakeTimers();
    const user = userEvent.setup({
      delay: null,
      advanceTimers: vi.advanceTimersByTimeAsync,
    });
    renderArtifactTree();
    expectNoOverlayRoots();
    const dot = screen.getByTestId(`epic-sidebar-status-dot-${ART_A}`);
    const hovered = user.hover(dot);
    expect(overlayMounted.tooltipWrapper).toBe(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TOOLTIP_DELAY_MS);
    });
    await hovered;
    expect(overlayMounted.tooltipWrapper).toBe(1);
    expect(screen.getByRole("tooltip").textContent).toBe(STATUS_LABELS[0]);
  });

  it("mounts no overlay roots on a never-touched cloud chat row", () => {
    renderCloudRow();
    expect(
      screen.getByTestId(
        `epic-sidebar-cloud-item-${CLOUD_CHAT.identity.chatId}`,
      ),
    ).toBeTruthy();
    expectNoOverlayRoots();
  });

  it("shows the cloud lock tooltip after the normal delay on a stationary first hover", async () => {
    vi.useFakeTimers();
    const user = userEvent.setup({
      delay: null,
      advanceTimers: vi.advanceTimersByTimeAsync,
    });
    renderCloudRow();
    expectNoOverlayRoots();
    const lock = screen.getByTestId(
      `epic-sidebar-cloud-lock-${CLOUD_CHAT.identity.chatId}`,
    );
    const hovered = user.hover(lock);
    expect(overlayMounted.tooltipWrapper).toBe(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TOOLTIP_DELAY_MS);
    });
    await hovered;
    expect(overlayMounted.tooltipWrapper).toBe(1);
    expect(screen.getByRole("tooltip").textContent).toMatch(/offline/i);
  });
});
