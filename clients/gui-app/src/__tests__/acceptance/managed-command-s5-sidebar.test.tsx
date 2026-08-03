/**
 * Independent acceptance suite — seam S5: the "Monitors & Shells" sidebar.
 *
 * Expected behavior comes from the records (`traycer-host/src/domain/
 * managed-command/UI.md` §§1-3, 9 and root `CONTEXT.md`), never from the
 * component code. The panel, the list store, its registry and the stream
 * mount are all real; frames enter through the production factory override
 * and every one is parsed through the wire contract's server-frame schema
 * first, so each fixture is a frame a host could actually have sent.
 */
import "../../../__tests__/test-browser-apis";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ManagedCommandsPanelBody } from "@/components/epic-canvas/sidebar/managed-command-sidebar";
import { LEFT_PANEL_DEFINITIONS } from "@/components/epic-canvas/sidebar/left-panel-registry";
import { ADDABLE_TYPES } from "@/components/epic-canvas/add-node-options";
import { EpicSessionContext } from "@/lib/registries/epic-session-registry";
import {
  createOpenEpicStore,
  type EpicStreamClientFactory,
  type OpenEpicStoreHandle,
} from "@/stores/epics/open-epic/store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { findOpenArtifactInTab } from "@/stores/epics/canvas/canvas-selectors";
import { ManagedCommandListStreamMount } from "@/providers/managed-command-list-stream-mount";
import { __setManagedCommandListStreamClientFactoryForTests } from "@/providers/managed-command-list-stream-factory-override";
import { managedCommandListRegistry } from "@/stores/managed-commands/managed-command-list-registry";
import { useSettingsStore } from "@/stores/settings/settings-store";
import type { ManagedCommandListStreamCallbacks } from "@traycer-clients/shared/host-transport/managed-command-list-stream-client";
import { managedCommandSubscribeListServerFrameSchema } from "@traycer/protocol/host/managed-command/subscribe";
import type { ManagedCommand } from "@traycer/protocol/host/managed-command/unary-schemas";
import { managedCommandSchema } from "@traycer/protocol/host/managed-command/unary-schemas";

const mocks = vi.hoisted(() => ({
  methodSupport: { value: "supported" },
  startMutate: vi.fn(),
  stopMutate: vi.fn(),
  deleteMutate: vi.fn(),
}));

vi.mock("@/lib/host/stream-runtime-context", () => ({
  useWsStreamClient: () => null,
  useStreamMethodSupport: () => mocks.methodSupport.value,
  useStreamMethodSchemaVersion: () => null,
}));

vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => "host-1",
}));

vi.mock(
  "@/hooks/managed-command/use-managed-command-lifecycle-mutations",
  () => ({
    useManagedCommandStart: () => ({
      mutate: mocks.startMutate,
      isPending: false,
    }),
    useManagedCommandStop: () => ({
      mutate: mocks.stopMutate,
      isPending: false,
    }),
    useManagedCommandDelete: () => ({
      mutate: mocks.deleteMutate,
      isPending: false,
    }),
  }),
);

const EPIC_ID = "epic-s5";
const TAB_ID = "tab-s5";
const HOST_ID = "host-1";
const T0 = 1_722_000_000_000;

const noopEpicStreamClientFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});

let wire: ManagedCommandListStreamCallbacks | null = null;
let epicHandle: OpenEpicStoreHandle | null = null;

function connectedWire(): ManagedCommandListStreamCallbacks {
  if (wire === null) {
    throw new Error("acceptance: the list stream was never opened");
  }
  return wire;
}

function makeCommand(over: Partial<ManagedCommand>): ManagedCommand {
  return managedCommandSchema.parse({
    id: "cmd-default",
    kind: "monitor",
    description: "deploy watcher",
    status: { state: "running", pid: 4410, startedAtMs: T0 },
    chatId: "chat-owner",
    createdAtMs: T0,
    updatedAtMs: T0,
    ...over,
  });
}

function emitSnapshot(commands: readonly ManagedCommand[]): void {
  const frame = managedCommandSubscribeListServerFrameSchema.parse({
    kind: "snapshot",
    hasBinaryPayload: false,
    commands,
  });
  if (frame.kind !== "snapshot") throw new Error("unreachable");
  act(() => {
    connectedWire().onSnapshot(frame.commands);
  });
}

function emitChanged(command: ManagedCommand): void {
  const frame = managedCommandSubscribeListServerFrameSchema.parse({
    kind: "changed",
    hasBinaryPayload: false,
    command,
  });
  if (frame.kind !== "changed") throw new Error("unreachable");
  act(() => {
    connectedWire().onChanged(frame.command);
  });
}

function emitRemoved(commandId: string): void {
  const frame = managedCommandSubscribeListServerFrameSchema.parse({
    kind: "removed",
    hasBinaryPayload: false,
    commandId,
  });
  if (frame.kind !== "removed") throw new Error("unreachable");
  act(() => {
    connectedWire().onRemoved(frame.commandId);
  });
}

function emitConnectionStatus(
  status: "connecting" | "open" | "reconnecting" | "closed",
): void {
  act(() => {
    connectedWire().onConnectionStatus(status, null);
  });
}

function renderSidebar(): void {
  epicHandle = createOpenEpicStore({
    epicId: EPIC_ID,
    streamClientFactory: noopEpicStreamClientFactory,
    userId: null,
    onAuthError: null,
  });
  // The backlink target: a chat this epic's projection knows about. Seeded on
  // the projected slice directly - the Yjs projector itself is not this seam.
  epicHandle.store.setState({
    chats: {
      byId: {
        "chat-owner": {
          id: "chat-owner",
          title: "Deploy chat",
          parentId: null,
          createdAt: T0,
          updatedAt: T0,
          userId: null,
          hostId: HOST_ID,
          isTitleEditedByUser: false,
          settings: null,
          archivedAt: null,
        },
      },
      allIds: ["chat-owner"],
    },
  });
  render(
    <EpicSessionContext.Provider value={epicHandle}>
      <TooltipProvider>
        <ManagedCommandListStreamMount epicId={EPIC_ID} />
        <ManagedCommandsPanelBody epicId={EPIC_ID} tabId={TAB_ID} />
      </TooltipProvider>
    </EpicSessionContext.Provider>,
  );
}

function rowTitlesInOrder(): (string | null)[] {
  const list = screen.getByTestId("managed-command-sidebar-list");
  return Array.from(
    list.querySelectorAll<HTMLElement>(
      '[data-testid^="managed-command-row-title-"]',
    ),
  ).map((title) => title.textContent);
}

beforeEach(() => {
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useEpicCanvasStore.setState({
    tabsById: { [TAB_ID]: { tabId: TAB_ID, epicId: EPIC_ID, name: "Epic" } },
    openTabOrder: [TAB_ID],
    activeTabId: TAB_ID,
  });
  // Resource readouts are seam S9; keep them out of this suite's rows.
  useSettingsStore.setState({ showNavigatorResourceStats: false });
  mocks.methodSupport.value = "supported";
  __setManagedCommandListStreamClientFactoryForTests((_epicId, callbacks) => {
    wire = callbacks;
    return { close: () => undefined };
  });
});

afterEach(() => {
  cleanup();
  __setManagedCommandListStreamClientFactoryForTests(null);
  managedCommandListRegistry.disposeAll();
  epicHandle?.dispose();
  epicHandle = null;
  wire = null;
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  vi.clearAllMocks();
});

describe("S5 · Monitors & Shells sidebar", () => {
  it("S5a: renders kind-explicit rows with status dots, ordered running-first then by most recent activity", () => {
    renderSidebar();
    emitConnectionStatus("open");
    emitSnapshot([
      makeCommand({
        id: "cmd-shell",
        kind: "shell",
        description: "db migration",
        status: {
          state: "exited",
          exitCode: 0,
          signal: null,
          exitedAtMs: T0 + 5_000,
        },
        updatedAtMs: T0 + 5_000,
      }),
      makeCommand({
        id: "cmd-run",
        kind: "monitor",
        description: "deploy watcher",
        status: { state: "running", pid: 4410, startedAtMs: T0 },
        updatedAtMs: T0 + 1_000,
      }),
      makeCommand({
        id: "cmd-stopped",
        kind: "monitor",
        description: "old poller",
        status: { state: "stopped", stoppedAtMs: T0 + 9_000 },
        updatedAtMs: T0 + 9_000,
      }),
    ]);

    // Running first, then most recent activity (UI.md §9) — hand-derived from
    // the authored timestamps: running watcher, then poller (T0+9s), then
    // migration (T0+5s). Kind-explicit copy per UI.md §3.
    expect(rowTitlesInOrder()).toEqual([
      "Monitor · deploy watcher",
      "Monitor · old poller",
      "Shell · db migration",
    ]);

    // Every row carries a status dot and a status line.
    for (const id of ["cmd-run", "cmd-stopped", "cmd-shell"]) {
      const row = screen.getByTestId(`managed-command-row-${id}`);
      expect(within(row).getByRole("img")).toBeTruthy();
    }
    expect(
      screen.getByTestId("managed-command-status-cmd-run").textContent,
    ).toMatch(/running/i);
    expect(
      screen.getByTestId("managed-command-status-cmd-stopped").textContent,
    ).toMatch(/stopped/i);
    expect(
      screen.getByTestId("managed-command-status-cmd-shell").textContent,
    ).toMatch(/exited/i);
  });

  it("S5b: change frames reorder the live list and removed frames drop the row", () => {
    renderSidebar();
    emitConnectionStatus("open");
    emitSnapshot([
      makeCommand({
        id: "cmd-run",
        description: "deploy watcher",
        updatedAtMs: T0 + 1_000,
      }),
      makeCommand({
        id: "cmd-shell",
        kind: "shell",
        description: "db migration",
        status: { state: "exited", exitCode: 0, signal: null, exitedAtMs: T0 },
        updatedAtMs: T0,
      }),
    ]);
    expect(rowTitlesInOrder()).toEqual([
      "Monitor · deploy watcher",
      "Shell · db migration",
    ]);

    // The shell starts again: running commands lead regardless of recency.
    emitChanged(
      makeCommand({
        id: "cmd-shell",
        kind: "shell",
        description: "db migration",
        status: { state: "running", pid: 5000, startedAtMs: T0 + 2_000 },
        updatedAtMs: T0 + 2_000,
      }),
    );
    expect(rowTitlesInOrder()).toEqual([
      "Shell · db migration",
      "Monitor · deploy watcher",
    ]);

    // A command created after subscribe arrives as a change frame and slots in.
    emitChanged(
      makeCommand({
        id: "cmd-new",
        description: "late watcher",
        status: { state: "running", pid: 6000, startedAtMs: T0 + 3_000 },
        updatedAtMs: T0 + 3_000,
      }),
    );
    expect(rowTitlesInOrder()).toEqual([
      "Monitor · late watcher",
      "Shell · db migration",
      "Monitor · deploy watcher",
    ]);

    emitRemoved("cmd-shell");
    expect(rowTitlesInOrder()).toEqual([
      "Monitor · late watcher",
      "Monitor · deploy watcher",
    ]);
    expect(screen.queryByTestId("managed-command-row-cmd-shell")).toBeNull();
  });

  it("S5c: every row links back to the creating chat; a chat outside the projection gets no dead button", () => {
    renderSidebar();
    emitConnectionStatus("open");
    emitSnapshot([
      makeCommand({ id: "cmd-linked", chatId: "chat-owner" }),
      makeCommand({
        id: "cmd-orphan",
        description: "orphan watcher",
        chatId: "chat-unknown",
      }),
    ]);

    const backlink = screen.getByTestId("managed-command-backlink-cmd-linked");
    expect(backlink.textContent).toContain("Deploy chat");
    // No chat to open ⇒ no backlink rendered at all, not a dead control.
    expect(
      screen.queryByTestId("managed-command-backlink-cmd-orphan"),
    ).toBeNull();

    // Clicking the backlink opens (or focuses) the creating chat on the canvas.
    fireEvent.click(backlink);
    expect(findOpenArtifactInTab(TAB_ID, "chat-owner")).not.toBeNull();
  });

  it("S5d: clicking a row opens the command's output window on the canvas", () => {
    renderSidebar();
    emitConnectionStatus("open");
    emitSnapshot([makeCommand({ id: "cmd-door" })]);

    fireEvent.click(screen.getByTestId("managed-command-row-cmd-door"));
    expect(findOpenArtifactInTab(TAB_ID, "cmd-door")).not.toBeNull();
  });

  it("S5e: losing the stream marks the list stale without emptying it; reconnect copy differs from first connect", () => {
    renderSidebar();
    emitConnectionStatus("open");
    emitSnapshot([makeCommand({ id: "cmd-keep" })]);
    expect(
      screen.queryByTestId("managed-command-sidebar-disconnected"),
    ).toBeNull();

    emitConnectionStatus("reconnecting");
    const notice = screen.getByTestId("managed-command-sidebar-disconnected");
    expect(notice.textContent).toMatch(/reconnecting/i);
    // The rows a viewer was reading stay put.
    expect(screen.getByTestId("managed-command-row-cmd-keep")).toBeTruthy();

    emitConnectionStatus("open");
    expect(
      screen.queryByTestId("managed-command-sidebar-disconnected"),
    ).toBeNull();
  });

  it("S5f: start shows only on non-running rows, stop only on running ones, and both carry the pressed command", () => {
    renderSidebar();
    emitConnectionStatus("open");
    emitSnapshot([
      makeCommand({ id: "cmd-live" }),
      makeCommand({
        id: "cmd-idle",
        description: "old poller",
        status: { state: "stopped", stoppedAtMs: T0 },
        updatedAtMs: T0,
      }),
    ]);

    expect(screen.getByTestId("managed-command-stop-cmd-live")).toBeTruthy();
    expect(screen.queryByTestId("managed-command-start-cmd-live")).toBeNull();
    expect(screen.getByTestId("managed-command-start-cmd-idle")).toBeTruthy();
    expect(screen.queryByTestId("managed-command-stop-cmd-idle")).toBeNull();

    fireEvent.click(screen.getByTestId("managed-command-start-cmd-idle"));
    expect(mocks.startMutate).toHaveBeenCalledWith({
      hostId: HOST_ID,
      epicId: EPIC_ID,
      commandId: "cmd-idle",
    });
    fireEvent.click(screen.getByTestId("managed-command-stop-cmd-live"));
    expect(mocks.stopMutate).toHaveBeenCalledWith({
      hostId: HOST_ID,
      epicId: EPIC_ID,
      commandId: "cmd-live",
    });
    // A lifecycle press is not a row press: no output window opened.
    expect(findOpenArtifactInTab(TAB_ID, "cmd-idle")).toBeNull();
    expect(findOpenArtifactInTab(TAB_ID, "cmd-live")).toBeNull();
  });

  it("S5g: delete sits behind a confirmation that names the output history it destroys", () => {
    renderSidebar();
    emitConnectionStatus("open");
    emitSnapshot([makeCommand({ id: "cmd-doomed" })]);

    fireEvent.click(screen.getByTestId("managed-command-delete-cmd-doomed"));
    expect(mocks.deleteMutate).not.toHaveBeenCalled();

    // The confirmation names what dies with the command (UI.md §2): its
    // entire output history — and names the command kind-explicitly.
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toMatch(/output history/i);
    expect(dialog.textContent).toContain("Monitor · deploy watcher");

    fireEvent.click(within(dialog).getByRole("button", { name: /delete/i }));
    expect(mocks.deleteMutate).toHaveBeenCalledWith({
      hostId: HOST_ID,
      epicId: EPIC_ID,
      commandId: "cmd-doomed",
    });
  });

  it("S5h: empty epics say so; a host without the stream says the surface is unavailable, not empty", () => {
    renderSidebar();
    emitConnectionStatus("open");
    emitSnapshot([]);
    expect(screen.getByTestId("managed-command-sidebar-empty")).toBeTruthy();

    cleanup();
    managedCommandListRegistry.disposeAll();
    wire = null;
    mocks.methodSupport.value = "unsupported";
    renderSidebar();
    expect(
      screen.getByTestId("managed-command-sidebar-unavailable"),
    ).toBeTruthy();
    expect(screen.queryByTestId("managed-command-sidebar-empty")).toBeNull();
    // The mount stays inert on an old host: no stream is ever opened.
    expect(wire).toBeNull();
  });

  it("S5i: the section header names both kinds — and the canvas add menu offers no command entry", () => {
    const section = LEFT_PANEL_DEFINITIONS.find(
      (definition) => definition.id === "managed-commands",
    );
    // The one surface naming both kinds (UI.md §3).
    expect(section?.title).toBe("Monitors & Shells");

    // No create from the UI (UI.md §2): the canvas add menu must not offer
    // monitors, shells, or any "command" entry.
    for (const type of ADDABLE_TYPES) {
      expect(type).not.toMatch(/monitor|shell|command/i);
    }
  });
});
