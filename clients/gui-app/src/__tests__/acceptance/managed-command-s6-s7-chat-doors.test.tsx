/**
 * Independent acceptance suite — seams S6 and S7: the chat-side surfaces.
 *
 * S6 is the running-work strip: a client-side join of the epic list stream
 * against the open chat (`UI.md` §5, §9a) — running commands owned by THIS
 * chat appear as rows, leave on terminal status frames, and click through to
 * the output window. S7 is the doors: the queued-delivery chip and the resume
 * divider open or focus the command's output window, the divider's terminal
 * copy is kind-explicit per the REAL kind (`UI.md` §3, §8), and one command
 * never has two windows (`UI.md` §9).
 *
 * Expected behavior derives from the records only. Real stores, registry,
 * stream mount and canvas store; frames and triggers are authored through the
 * wire/persistence schemas so every fixture is one a host could have sent.
 */
import "../../../__tests__/test-browser-apis";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ManagedCommandStripRows } from "@/components/chat/managed-command-strip-rows";
import { ManagedCommandBadge } from "@/components/chat/queued-message-surface";
import { AutonomousResumeSegment } from "@/components/chat/segments/autonomous-resume-segment";
import { TabHostContext } from "@/components/epic-canvas/hooks/use-tab-host-id";
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
import type { ManagedCommandListStreamCallbacks } from "@traycer-clients/shared/host-transport/managed-command-list-stream-client";
import { managedCommandSubscribeListServerFrameSchema } from "@traycer/protocol/host/managed-command/subscribe";
import { managedCommandSchema } from "@traycer/protocol/host/managed-command/unary-schemas";
import type { ManagedCommand } from "@traycer/protocol/host/managed-command/unary-schemas";
import { autonomousResumeTriggerSchema } from "@traycer/protocol/persistence/epic/content-blocks";
import type { AutonomousResumeTrigger } from "@traycer/protocol/persistence/epic/content-blocks";

const mocks = vi.hoisted(() => ({
  methodSupport: { value: "supported" },
}));

// The strip's rows carry the same lifecycle actions the sidebar rows do, so
// this suite fakes the same boundary the sidebar suite fakes: the RPCs behind
// them. What the rows render and where they lead is still real.
vi.mock(
  "@/hooks/managed-command/use-managed-command-lifecycle-mutations",
  () => ({
    useManagedCommandStart: () => ({ mutate: vi.fn(), isPending: false }),
    useManagedCommandStop: () => ({ mutate: vi.fn(), isPending: false }),
    useManagedCommandDelete: () => ({ mutate: vi.fn(), isPending: false }),
  }),
);

vi.mock("@/lib/host/stream-runtime-context", () => ({
  useWsStreamClient: () => null,
  useStreamMethodSupport: () => mocks.methodSupport.value,
  useStreamMethodSchemaVersion: () => null,
}));

const EPIC_ID = "epic-s6";
const TAB_ID = "tab-s6";
const HOST_ID = "host-1";
const CHAT_A = "chat-a";
const CHAT_B = "chat-b";
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
    chatId: CHAT_A,
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

/**
 * Triggers are persisted chat state: authoring them through the persistence
 * schema means each fixture is exactly what a chat replay would hand the
 * renderer — including the defaulted keys an old host would have stripped.
 */
function makeTrigger(
  over: Partial<AutonomousResumeTrigger>,
): AutonomousResumeTrigger {
  return autonomousResumeTriggerSchema.parse({
    kind: "monitor",
    title: "deploy watcher",
    status: "completed",
    summary: "",
    blockId: "blk-1",
    ...over,
  });
}

function renderInChatContext(children: React.ReactNode): void {
  epicHandle = createOpenEpicStore({
    epicId: EPIC_ID,
    streamClientFactory: noopEpicStreamClientFactory,
    userId: null,
    onAuthError: null,
  });
  render(
    <TabHostContext.Provider value={HOST_ID}>
      <EpicSessionContext.Provider value={epicHandle}>
        <TooltipProvider>{children}</TooltipProvider>
      </EpicSessionContext.Provider>
    </TabHostContext.Provider>,
  );
}

/** Panes across the whole canvas currently holding this command's window. */
function openWindowCountFor(commandId: string): number {
  const canvasByTabId = useEpicCanvasStore.getState().canvasByTabId;
  return Object.values(canvasByTabId).reduce((count, canvas) => {
    const tiles = Object.values(canvas?.tilesByInstanceId ?? {});
    return (
      count +
      tiles.filter((ref) => ref !== undefined && ref.id === commandId).length
    );
  }, 0);
}

beforeEach(() => {
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useEpicCanvasStore.setState({
    tabsById: { [TAB_ID]: { tabId: TAB_ID, epicId: EPIC_ID, name: "Epic" } },
    openTabOrder: [TAB_ID],
    activeTabId: TAB_ID,
  });
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

describe("S6 · running-work strip", () => {
  it("S6a: shows only THIS chat's running commands, kind-explicit, and none of another chat's or terminal ones", () => {
    renderInChatContext(
      <>
        <ManagedCommandListStreamMount epicId={EPIC_ID} />
        <ManagedCommandStripRows epicId={EPIC_ID} chatId={CHAT_A} />
      </>,
    );
    emitSnapshot([
      makeCommand({ id: "cmd-mine-running", description: "deploy watcher" }),
      makeCommand({
        id: "cmd-theirs-running",
        chatId: CHAT_B,
        description: "other watcher",
      }),
      makeCommand({
        id: "cmd-mine-done",
        kind: "shell",
        description: "db migration",
        status: { state: "exited", exitCode: 0, signal: null, exitedAtMs: T0 },
      }),
    ]);

    const mine = screen.getByTestId(
      "managed-command-strip-row-cmd-mine-running",
    );
    expect(mine.textContent).toContain("Monitor · deploy watcher");
    expect(
      screen.queryByTestId("managed-command-strip-row-cmd-theirs-running"),
    ).toBeNull();
    expect(
      screen.queryByTestId("managed-command-strip-row-cmd-mine-done"),
    ).toBeNull();
  });

  it("S6b: rows appear and disappear on status frames — removed the moment the command reaches a terminal state", () => {
    renderInChatContext(
      <>
        <ManagedCommandListStreamMount epicId={EPIC_ID} />
        <ManagedCommandStripRows epicId={EPIC_ID} chatId={CHAT_A} />
      </>,
    );
    emitSnapshot([]);
    expect(
      screen.queryByTestId("managed-command-strip-row-cmd-live"),
    ).toBeNull();

    emitChanged(makeCommand({ id: "cmd-live", description: "fresh watcher" }));
    expect(
      screen.getByTestId("managed-command-strip-row-cmd-live"),
    ).toBeTruthy();

    emitChanged(
      makeCommand({
        id: "cmd-live",
        description: "fresh watcher",
        status: {
          state: "exited",
          exitCode: 1,
          signal: null,
          exitedAtMs: T0 + 1,
        },
        updatedAtMs: T0 + 1,
      }),
    );
    expect(
      screen.queryByTestId("managed-command-strip-row-cmd-live"),
    ).toBeNull();
  });

  it("S6c: clicking a strip row opens the command's output window", () => {
    renderInChatContext(
      <>
        <ManagedCommandListStreamMount epicId={EPIC_ID} />
        <ManagedCommandStripRows epicId={EPIC_ID} chatId={CHAT_A} />
      </>,
    );
    emitSnapshot([makeCommand({ id: "cmd-door" })]);

    fireEvent.click(screen.getByTestId("managed-command-strip-row-cmd-door"));
    expect(findOpenArtifactInTab(TAB_ID, "cmd-door")).not.toBeNull();
  });
});

describe("S7 · doors", () => {
  it("S7a: the queued-delivery chip is kind-explicit and opens the output window", () => {
    renderInChatContext(
      <ManagedCommandBadge commandId="cmd-chip" commandKind="shell" />,
    );
    const badge = screen.getByTestId("queued-managed-command-badge");
    expect(badge.textContent).toContain("Shell output");

    fireEvent.click(badge);
    expect(findOpenArtifactInTab(TAB_ID, "cmd-chip")).not.toBeNull();
  });

  it("S7b: a chip from a host that reported no kind stays kind-free rather than guessing", () => {
    renderInChatContext(
      <ManagedCommandBadge commandId="cmd-old" commandKind={null} />,
    );
    const badge = screen.getByTestId("queued-managed-command-badge");
    expect(badge.textContent).toContain("Command output");
    expect(badge.textContent).not.toMatch(/monitor|shell/i);
  });

  it("S7c: the divider names the REAL kind — a completed shell reads 'Shell completed', never 'Monitor completed'", () => {
    // The persisted trigger kind is frozen at "monitor" for a Shell too; the
    // structured managedCommand key carries the truth (UI.md §8 as-built).
    renderInChatContext(
      <AutonomousResumeSegment
        triggers={[
          makeTrigger({
            blockId: "blk-shell",
            title: "db migration",
            status: "completed",
            managedCommand: { commandId: "cmd-shell", kind: "shell" },
          }),
          makeTrigger({
            blockId: "blk-monitor",
            title: "deploy watcher",
            status: "failed",
            managedCommand: { commandId: "cmd-monitor", kind: "monitor" },
          }),
        ]}
      />,
    );
    expect(screen.getByText("Shell completed")).toBeTruthy();
    expect(screen.getByText("Monitor failed")).toBeTruthy();
    expect(screen.queryByText("Monitor completed")).toBeNull();
  });

  it("S7d: the divider is a door — 'View output' opens the named command's window", () => {
    renderInChatContext(
      <AutonomousResumeSegment
        triggers={[
          makeTrigger({
            blockId: "blk-door",
            managedCommand: { commandId: "cmd-divider", kind: "monitor" },
          }),
        ]}
      />,
    );
    fireEvent.click(screen.getByTestId("resume-managed-command-door-blk-door"));
    expect(findOpenArtifactInTab(TAB_ID, "cmd-divider")).not.toBeNull();
  });

  it("S7e: a legacy trigger without a command identity gets generic copy and no dead door", () => {
    renderInChatContext(
      <AutonomousResumeSegment
        triggers={[
          makeTrigger({ blockId: "blk-legacy", managedCommand: null }),
        ]}
      />,
    );
    // Falls back to the frozen persisted kind's presentation.
    expect(screen.getByText("Monitor completed")).toBeTruthy();
    expect(
      screen.queryByTestId("resume-managed-command-door-blk-legacy"),
    ).toBeNull();
  });

  it("S7f: a still-running producer's divider says so instead of inventing a terminal outcome", () => {
    renderInChatContext(
      <AutonomousResumeSegment
        triggers={[
          makeTrigger({
            blockId: "blk-live",
            live: true,
            managedCommand: { commandId: "cmd-live", kind: "monitor" },
          }),
        ]}
      />,
    );
    // Kind-explicit, like every other state: the trigger names a monitor, so
    // the divider says Monitor. Only a legacy trigger with no `managedCommand`
    // at all falls back to the generic "Command still running".
    expect(screen.getByText("Monitor still running")).toBeTruthy();
    expect(screen.queryByText(/completed|failed|stopped/)).toBeNull();
  });

  it("S7g: one window per command — every door and a second press converge on a single pane", () => {
    renderInChatContext(
      <>
        <ManagedCommandListStreamMount epicId={EPIC_ID} />
        <ManagedCommandStripRows epicId={EPIC_ID} chatId={CHAT_A} />
        <ManagedCommandBadge commandId="cmd-one" commandKind="monitor" />
      </>,
    );
    emitSnapshot([makeCommand({ id: "cmd-one", description: "solo watcher" })]);

    fireEvent.click(screen.getByTestId("queued-managed-command-badge"));
    expect(openWindowCountFor("cmd-one")).toBe(1);

    // A different door for the same command focuses the existing window.
    fireEvent.click(screen.getByTestId("managed-command-strip-row-cmd-one"));
    expect(openWindowCountFor("cmd-one")).toBe(1);

    // And the same door twice does not stack a second pane either.
    fireEvent.click(screen.getByTestId("queued-managed-command-badge"));
    expect(openWindowCountFor("cmd-one")).toBe(1);
  });
});
