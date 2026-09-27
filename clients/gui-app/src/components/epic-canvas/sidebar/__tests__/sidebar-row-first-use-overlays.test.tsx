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
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
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
  expect(overlayMounted).toEqual({
    contextMenu: 0,
    dropdownMenu: 0,
    tooltip: 0,
    tooltipWrapper: 0,
    hoverCard: 0,
    confirmDialog: 0,
  });
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

function stubRowBox(element: HTMLElement, point: ContextMenuPoint): void {
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
    x: point.clientX,
    y: point.clientY,
    left: point.clientX,
    top: point.clientY,
    right: point.clientX + 160,
    bottom: point.clientY + 28,
    width: 160,
    height: 28,
    toJSON: () => ({}),
  });
}

async function pressContextMenuKey(
  user: UserEvent,
  element: HTMLElement,
  point: ContextMenuPoint,
): Promise<void> {
  const wrapper = element.parentElement;
  if (wrapper === null) {
    throw new Error("expected the row wrapper to host contextmenu replay");
  }
  stubRowBox(wrapper, point);
  element.focus();
  await user.keyboard("{ContextMenu}");
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

  it("opens the context menu on the first ContextMenu key at the focused row", async () => {
    const user = userEvent.setup();
    const row = renderTree();
    expectNoOverlayRoots();
    const captured = captureContextMenuPoints();
    try {
      await pressContextMenuKey(user, row, KEY_POINT);
      await expectContextMenuVisible(ROW_A, ROW_B);
      expect(captured.events).toEqual([
        { clientX: KEY_POINT.clientX + 8, clientY: KEY_POINT.clientY + 8 },
      ]);
    } finally {
      captured.stop();
    }
  });

  it("leaves Shift+F10 unchanged: it does not open the menu", async () => {
    const user = userEvent.setup();
    const row = renderTree();
    row.focus();
    await user.keyboard("{Shift>}{F10}{/Shift}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(
      screen.queryByTestId(`epic-sidebar-context-rename-${ROW_A}`),
    ).toBeNull();
    expect(overlayMounted.contextMenu).toBe(0);
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
    // `user.hover` is wrapped in Testing Library `act`. Pointerenter arms the
    // 500ms intent timeout, and that act waits for it, so awaiting hover
    // before advancing timers never resolves.
    const hovered = user.hover(row);
    expect(overlayMounted.hoverCard).toBe(0);
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(
      screen.queryByTestId(`chat-navigator-hover-title-${ROW_A}`),
    ).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    await hovered;
    expect(overlayMounted.hoverCard).toBe(1);
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
