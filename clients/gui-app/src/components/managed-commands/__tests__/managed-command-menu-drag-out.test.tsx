import "../../../../__tests__/test-browser-apis";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import type { ManagedCommand } from "@traycer/protocol/host/managed-command/unary-schemas";
import { TooltipProvider } from "@/components/ui/tooltip";

/**
 * Dragging a row out of a chat's monitors menu onto the canvas, driven as a
 * real pointer gesture through the real `RootDndProvider`.
 *
 * dnd-kit reads a drag's payload LIVE off the draggable that started it, so
 * the whole gesture hangs on the source row staying mounted: closing the
 * popover the moment the drag began emptied `active.data.current`, and every
 * collision and the drop itself then saw no source at all - a drag-out that
 * animated an overlay and did nothing.
 */

vi.mock("@/lib/host/stream-runtime-context", () => ({
  useWsStreamClient: () => null,
  useStreamMethodSupport: () => "supported",
  useStreamMethodSchemaVersion: () => null,
}));

vi.mock(
  "@/hooks/managed-command/use-managed-command-lifecycle-mutations",
  () => ({
    useManagedCommandStart: () => ({ mutate: vi.fn(), isPending: false }),
    useManagedCommandStop: () => ({ mutate: vi.fn(), isPending: false }),
    useManagedCommandStopAll: () => ({ mutate: vi.fn(), isPending: false }),
    useManagedCommandDelete: () => ({ mutate: vi.fn(), isPending: false }),
    useManagedCommandStopAllIsPending: () => false,
  }),
);

import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";
import { EpicSessionContext } from "@/lib/registries/epic-session-registry";
import {
  createOpenEpicStore,
  type EpicStreamClientFactory,
  type OpenEpicStoreHandle,
} from "@/stores/epics/open-epic/store";
import {
  disposeManagedCommandChatSessions,
  installManagedCommandChatSession,
  type ManagedCommandChatSessionStub,
} from "@/stores/managed-commands/test-support/managed-command-chat-session";
import { ManagedCommandChatMenu } from "@/components/managed-commands/managed-command-chat-menu";
import { RootDndProvider } from "@/components/epic-canvas/dnd/root-dnd-provider";
import { useEpicDndStore } from "@/components/epic-canvas/dnd/dnd-store";
import { PaneDropZone } from "@/components/epic-canvas/dnd/pane-drop-zone";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { findOpenArtifactInTab } from "@/stores/epics/canvas/canvas-selectors";
import { collectPanes } from "@/stores/epics/canvas/tile-tree";
import { useTabsStore } from "@/stores/tabs/store";
import { __resetTabNavigationControllerForTesting } from "@/lib/tab-navigation";
import type { EpicNodeRef } from "@/stores/epics/canvas/types";

const EPIC_ID = "epic-1";
const TAB_ID = "tab-1";
const CHAT_ID = "chat-1";
const HOST_ID = "host-1";

/** A tile already on the canvas, so the drop has a real pane to land in. */
const SEED_TILE: EpicNodeRef = {
  id: "seed-spec",
  instanceId: "seed-spec-instance",
  type: "spec",
  name: "Seed spec",
  hostId: HOST_ID,
};

const MONITOR: ManagedCommand = {
  id: "cmd-1",
  kind: "monitor",
  description: "deploy watcher",
  status: { state: "running", pid: 4410, startedAtMs: 10 },
  chatId: CHAT_ID,
  createdAtMs: 10,
  updatedAtMs: 10,
};

const noopStreamClientFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});

let epicHandle: OpenEpicStoreHandle;

let chatSession: ManagedCommandChatSessionStub;

/**
 * The pane's measured box. dnd-kit measures a droppable the moment it
 * registers - and a pane drop zone registers mid-drag - so the stub has to be
 * in place before the gesture starts, not after the element appears.
 */
const PANE_RECT = new DOMRect(200, 0, 400, 400);
// Everything else keeps the all-zero box jsdom lays out anyway.
const EMPTY_RECT = new DOMRect(0, 0, 0, 0);

function stubPaneGeometry(): void {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function measure(this: HTMLElement): DOMRect {
      return this.dataset.testid === "pane-drop-zone" ? PANE_RECT : EMPTY_RECT;
    },
  );
}

function Harness(props: { readonly paneId: string }): ReactNode {
  return (
    <EpicSessionContext.Provider value={epicHandle}>
      <TabHostProvider hostId={HOST_ID}>
        <TooltipProvider>
          <RootDndProvider>
            <div data-testid="drag-harness" />
            <ManagedCommandChatMenu
              epicId={EPIC_ID}
              chatId={CHAT_ID}
              hostId={HOST_ID}
              viewTabId={TAB_ID}
            />
            <PaneDropZone
              paneId={props.paneId}
              viewTabId={TAB_ID}
              tabCount={1}
            />
          </RootDndProvider>
        </TooltipProvider>
      </TabHostProvider>
    </EpicSessionContext.Provider>
  );
}

function seedCanvasPane(): string {
  useEpicCanvasStore.getState().openEpicTabWithId(TAB_ID, EPIC_ID, "Epic 1");
  useEpicCanvasStore.getState().openTileInTab(TAB_ID, SEED_TILE);
  const canvas = useEpicCanvasStore.getState().canvasByTabId[TAB_ID];
  const paneId = collectPanes(canvas?.root ?? null).at(0)?.id;
  if (paneId === undefined) throw new Error("Expected a seeded pane");
  return paneId;
}

async function renderHarness(paneId: string): Promise<void> {
  const rootRoute = createRootRoute({
    component: () => <Harness paneId={paneId} />,
  });
  const epicTabRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/epics/$epicId/$tabId",
    validateSearch: (
      search: Record<string, unknown>,
    ): { focusedAt: number | undefined } => ({
      focusedAt:
        typeof search.focusedAt === "number" ? search.focusedAt : undefined,
    }),
    component: () => <div data-testid="epic-tab-body" />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([epicTabRoute]),
    history: createMemoryHistory({
      initialEntries: [`/epics/${EPIC_ID}/${TAB_ID}`],
    }),
  });
  render(<RouterProvider router={router} />);
  await screen.findByTestId("drag-harness");
}

/** pointerdown, then a move past the 5px activation distance. */
function startRowDrag(row: HTMLElement): void {
  act(() => {
    fireEvent.pointerDown(row, {
      pointerId: 1,
      isPrimary: true,
      button: 0,
      clientX: 10,
      clientY: 10,
    });
  });
  act(() => {
    fireEvent.pointerMove(row, { pointerId: 1, clientX: 40, clientY: 10 });
  });
}

/**
 * Two moves deep into the pane's rect: the first only re-measures after the
 * zone mounted, the second resolves the collision the drop commits against.
 */
function moveIntoPane(): void {
  act(() => {
    fireEvent.pointerMove(document, {
      pointerId: 1,
      clientX: 400,
      clientY: 200,
    });
  });
  act(() => {
    fireEvent.pointerMove(document, {
      pointerId: 1,
      clientX: 401,
      clientY: 201,
    });
  });
}

function dropOnPane(): void {
  act(() => {
    fireEvent.pointerUp(document, {
      pointerId: 1,
      clientX: 401,
      clientY: 201,
    });
  });
}

function dragRowOntoPane(row: HTMLElement): void {
  startRowDrag(row);
  moveIntoPane();
  dropOnPane();
}

beforeEach(() => {
  stubPaneGeometry();
  __resetTabNavigationControllerForTesting();
  epicHandle = createOpenEpicStore({
    epicId: EPIC_ID,
    streamClientFactory: noopStreamClientFactory,
    userId: null,
    onAuthError: null,
  });
  chatSession = installManagedCommandChatSession({
    epicId: EPIC_ID,
    chatId: CHAT_ID,
  });
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
});

afterEach(async () => {
  // dnd-kit keeps a click-swallowing document listener for 50ms after a drag
  // ends (its own guard against the browser's post-drag click). Without
  // waiting it out, the NEXT test's first click never reaches React.
  await new Promise((resolve) => {
    setTimeout(resolve, 60);
  });
  vi.restoreAllMocks();
  cleanup();
  epicHandle.dispose();
  disposeManagedCommandChatSessions();
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useTabsStore.setState(useTabsStore.getInitialState(), true);
  useEpicDndStore.getState().dragEnded();
});

describe("dragging a monitors-menu row onto the canvas", () => {
  it("carries the row's payload all the way to the drop and lands its window", async () => {
    const paneId = seedCanvasPane();
    await renderHarness(paneId);
    act(() => {
      chatSession.setCommands([MONITOR]);
    });
    fireEvent.click(screen.getByTestId("managed-command-chat-menu-trigger"));

    dragRowOntoPane(screen.getByTestId("managed-command-menu-row-cmd-1"));

    // The command's output window is on the canvas. Closing the popover at
    // drag start unmounted the draggable, and dnd-kit then handed the drop an
    // empty source - so nothing was ever placed.
    expect(findOpenArtifactInTab(TAB_ID, "cmd-1")).not.toBeNull();
  });

  it("keeps the source row mounted for the whole gesture, then closes", async () => {
    const paneId = seedCanvasPane();
    await renderHarness(paneId);
    act(() => {
      chatSession.setCommands([MONITOR]);
    });
    fireEvent.click(screen.getByTestId("managed-command-chat-menu-trigger"));
    startRowDrag(screen.getByTestId("managed-command-menu-row-cmd-1"));
    moveIntoPane();

    // Mid-gesture: still there, just out of the way.
    expect(
      screen.queryByTestId("managed-command-menu-row-cmd-1"),
    ).not.toBeNull();

    dropOnPane();

    // The menu is a passing thing; once the gesture is over it gets out of the
    // way for good.
    expect(screen.queryByTestId("managed-command-menu-row-cmd-1")).toBeNull();
  });

  it("moves an already-open window rather than opening a second one", async () => {
    const paneId = seedCanvasPane();
    await renderHarness(paneId);
    act(() => {
      chatSession.setCommands([MONITOR]);
    });
    fireEvent.click(screen.getByTestId("managed-command-chat-menu-trigger"));
    fireEvent.click(screen.getByTestId("managed-command-menu-row-cmd-1"));
    const opened = findOpenArtifactInTab(TAB_ID, "cmd-1");
    expect(opened).not.toBeNull();

    dragRowOntoPane(screen.getByTestId("managed-command-menu-row-cmd-1"));

    // One window per command: the tile ref's content id IS the command id, so
    // a second drop resolves to a move of the same instance.
    const afterDrop = findOpenArtifactInTab(TAB_ID, "cmd-1");
    expect(afterDrop?.instanceId).toBe(opened?.instanceId);
  });
});
