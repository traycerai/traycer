import "../../../../../__tests__/test-browser-apis";
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
 * Dragging a shell's transcript door - the start card's and every restart
 * card's "Open in tab" button - out onto the canvas, driven as a real pointer
 * gesture through the real `RootDndProvider`.
 *
 * The door became a drag source on the SAME payload the Background-panel row
 * already drops (see `chat-background-panel-drag-out`), so this proves that
 * same contract for a second surface - and its one real difference: a deleted shell's door is
 * not a button at all, so it must not register as a drag source either.
 */

vi.mock("@/lib/host/stream-runtime-context", () => ({
  useWsStreamClient: () => null,
  useStreamMethodSupport: () => "supported",
  useStreamMethodSchemaVersion: () => null,
}));

import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";
import { EpicSessionContext } from "@/lib/registries/epic-session-registry";
import { EpicViewTabContext } from "@/components/epic-canvas/view-tab-context";
import { ChatTranscriptProvider } from "@/components/chat/chat-transcript-context";
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
import { RootDndProvider } from "@/components/epic-canvas/dnd/root-dnd-provider";
import { useEpicDndStore } from "@/components/epic-canvas/dnd/dnd-store";
import { PaneDropZone } from "@/components/epic-canvas/dnd/pane-drop-zone";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { findOpenArtifactInTab } from "@/stores/epics/canvas/canvas-selectors";
import { collectPanes } from "@/stores/epics/canvas/tile-tree";
import { useTabsStore } from "@/stores/tabs/store";
import { __resetTabNavigationControllerForTesting } from "@/lib/tab-navigation";
import type { EpicNodeRef } from "@/stores/epics/canvas/types";
import { ToolSegment } from "../tool-segment";

const EPIC_ID = "epic-1";
const TAB_ID = "tab-1";
const CHAT_ID = "chat-1";
const HOST_ID = "host-1";
const COMMAND_ID = "cmd-1";
const COMMAND_LINE = "tail -f deploy.log";

/** A tile already on the canvas, so the drop has a real pane to land in. */
const SEED_TILE: EpicNodeRef = {
  id: "seed-spec",
  instanceId: "seed-spec-instance",
  type: "spec",
  name: "Seed spec",
  hostId: HOST_ID,
};

const MONITOR: ManagedCommand = {
  id: COMMAND_ID,
  monitoring: true,
  description: "deploy watcher",
  command: COMMAND_LINE,
  cwd: "/work/repo",
  cadence: { debounceMs: 500, maxWaitMs: 15_000, throttleMs: 5_000 },
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

/** The start card: a correlated `traycer_run_shell` call. */
function startCard(): ReactNode {
  return (
    <ToolSegment
      id="tool-1"
      toolName="mcp__traycer_a2a__traycer_run_shell"
      inputSummary={COMMAND_LINE}
      inputDetail={{ kind: "command", command: COMMAND_LINE }}
      error={null}
      agentMessageSend={null}
      managedCommand={{
        event: "started",
        commandId: COMMAND_ID,
        description: "deploy watcher",
        monitoring: true,
        cwd: "/work/repo",
      }}
      isStreaming={false}
      endState={null}
      stopped={false}
      progress={null}
      backgroundOutput={null}
      backgroundTask={false}
      startedAt={10}
      durationMs={null}
      imageResults={[]}
      variant="card"
      headerFindUnitId={null}
    />
  );
}

/** The restart card: both cards share the same door component. */
function restartCard(): ReactNode {
  return (
    <ToolSegment
      id="tool-2"
      toolName="mcp__traycer_a2a__traycer_restart_shell"
      inputSummary={null}
      inputDetail={null}
      error={null}
      agentMessageSend={null}
      managedCommand={{
        event: "restarted",
        commandId: COMMAND_ID,
        description: "deploy watcher",
        monitoring: true,
        effectiveCommand: COMMAND_LINE,
        effectiveCwd: "/work/repo",
        commandChanged: false,
        cwdChanged: false,
        outcome: { state: "running", pid: 4410, startedAtMs: 10 },
      }}
      isStreaming={false}
      endState={null}
      stopped={false}
      progress={null}
      backgroundOutput={null}
      backgroundTask={false}
      startedAt={10}
      durationMs={null}
      imageResults={[]}
      variant="card"
      headerFindUnitId={null}
    />
  );
}

function Harness(props: {
  readonly paneId: string;
  /** `false` renders the card outside any `EpicViewTabContext`, the way a
   *  transcript rendered off-canvas would. */
  readonly withViewTab: boolean;
  readonly card: ReactNode;
}): ReactNode {
  const canvas = (
    <RootDndProvider>
      <div data-testid="drag-harness" />
      {props.card}
      <PaneDropZone paneId={props.paneId} viewTabId={TAB_ID} tabCount={1} />
    </RootDndProvider>
  );
  return (
    <ChatTranscriptProvider value={{ chatId: CHAT_ID, hostId: HOST_ID }}>
      <EpicSessionContext.Provider value={epicHandle}>
        <TabHostProvider hostId={HOST_ID}>
          <TooltipProvider>
            {props.withViewTab ? (
              <EpicViewTabContext.Provider value={TAB_ID}>
                {canvas}
              </EpicViewTabContext.Provider>
            ) : (
              canvas
            )}
          </TooltipProvider>
        </TabHostProvider>
      </EpicSessionContext.Provider>
    </ChatTranscriptProvider>
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

async function renderHarness(
  paneId: string,
  options: { readonly withViewTab: boolean; readonly card: ReactNode },
): Promise<void> {
  const rootRoute = createRootRoute({
    component: () => (
      <Harness
        paneId={paneId}
        withViewTab={options.withViewTab}
        card={options.card}
      />
    ),
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
function startDrag(node: HTMLElement): void {
  act(() => {
    fireEvent.pointerDown(node, {
      pointerId: 1,
      isPrimary: true,
      button: 0,
      clientX: 10,
      clientY: 10,
    });
  });
  act(() => {
    fireEvent.pointerMove(node, { pointerId: 1, clientX: 40, clientY: 10 });
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

function dragOntoPane(node: HTMLElement): void {
  startDrag(node);
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
    hostId: HOST_ID,
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

describe("dragging a shell's transcript door onto the canvas", () => {
  it("is a drag source on the menu/Background rows' own payload, and lands the shell's window", async () => {
    const paneId = seedCanvasPane();
    await renderHarness(paneId, { withViewTab: true, card: startCard() });
    act(() => {
      chatSession.setCommands([MONITOR]);
    });

    const door = screen.getByTestId(`managed-command-start-door-${COMMAND_ID}`);
    expect(door.getAttribute("data-draggable")).toBe("true");

    dragOntoPane(door);

    expect(findOpenArtifactInTab(TAB_ID, COMMAND_ID)).not.toBeNull();
  });

  it("still opens the window on a plain click, not just a drag (restart card)", async () => {
    const paneId = seedCanvasPane();
    await renderHarness(paneId, { withViewTab: true, card: restartCard() });
    act(() => {
      chatSession.setCommands([MONITOR]);
    });

    // dnd-kit's activation distance is what keeps these two gestures apart -
    // the door the card has always been has to survive becoming a drag handle.
    fireEvent.click(
      screen.getByTestId(`managed-command-restart-door-${COMMAND_ID}`),
    );

    expect(findOpenArtifactInTab(TAB_ID, COMMAND_ID)).not.toBeNull();
  });

  it("is not a drag source once the shell is deleted, and dragging it opens nothing", async () => {
    const paneId = seedCanvasPane();
    await renderHarness(paneId, { withViewTab: true, card: startCard() });
    act(() => {
      // Only the owning stream saying OPEN makes the absence below
      // authoritative - see managed-command-start-segment.test.tsx.
      chatSession.setConnectionStatus("open");
      chatSession.setCommands([]);
    });

    const door = screen.getByTestId(`managed-command-start-door-${COMMAND_ID}`);
    expect(door.getAttribute("aria-disabled")).toBe("true");
    // The deleted-shell door is a plain span with no dnd-kit wiring at all -
    // not merely a button with dragging turned off.
    expect(door.hasAttribute("data-draggable")).toBe(false);

    dragOntoPane(door);

    expect(findOpenArtifactInTab(TAB_ID, COMMAND_ID)).toBeNull();
  });

  it("renders a non-draggable door outside a canvas view, but a click still opens the window", async () => {
    const paneId = seedCanvasPane();
    await renderHarness(paneId, { withViewTab: false, card: startCard() });
    act(() => {
      chatSession.setCommands([MONITOR]);
    });

    // No `EpicViewTabContext` in scope - there is no view to scope a drag's
    // dnd id or its drop to, so the source has nothing to drag onto.
    const door = screen.getByTestId(`managed-command-start-door-${COMMAND_ID}`);
    expect(door.getAttribute("data-draggable")).toBe("false");

    fireEvent.click(door);

    expect(findOpenArtifactInTab(TAB_ID, COMMAND_ID)).not.toBeNull();
  });
});
