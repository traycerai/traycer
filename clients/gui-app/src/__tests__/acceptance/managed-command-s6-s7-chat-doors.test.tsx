/**
 * Independent acceptance suite — seams S6 and S7: the chat-side surfaces.
 *
 * S6 is the chat's running work: the running subset of the set the chat's own
 * stream carries (`UI.md` §5, §9a) — running commands owned by THIS chat
 * appear as rows of the chat's Background panel, leave as soon as a later set
 * stops naming them as running, and click through to the output window. S7 is
 * the doors: the
 * queued-delivery chip and the resume divider open or focus the command's
 * output window, the divider's terminal copy is kind-explicit per the REAL
 * kind (`UI.md` §3, §8), and one command never has two windows (`UI.md` §9).
 *
 * Expected behavior derives from the records only. Real stores, registry,
 * stream mount and canvas store; frames and triggers are authored through the
 * wire/persistence schemas so every fixture is one a host could have sent.
 */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { BackgroundItemsPanel } from "@/components/chat/chat-background-items-panel";
import { ManagedCommandBadge } from "@/components/chat/queued-message-surface";
import { AutonomousResumeSegment } from "@/components/chat/segments/autonomous-resume-segment";
import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";
import { EpicSessionContext } from "@/lib/registries/epic-session-registry";
import {
  createOpenEpicStore,
  type EpicStreamClientFactory,
  type OpenEpicStoreHandle,
} from "@/stores/epics/open-epic/store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { findOpenArtifactInTab } from "@/stores/epics/canvas/canvas-selectors";
import {
  disposeManagedCommandChatSessions,
  installManagedCommandChatSession,
  type ManagedCommandChatSessionStub,
} from "@/stores/managed-commands/test-support/managed-command-chat-session";
import { chatSubscribeServerFrameSchema } from "@traycer/protocol/host/agent/gui/subscribe";
import { managedCommandSchema } from "@traycer/protocol/host/managed-command/unary-schemas";
import type { ManagedCommand } from "@traycer/protocol/host/managed-command/unary-schemas";
import { autonomousResumeTriggerSchema } from "@traycer/protocol/persistence/epic/content-blocks";
import type { AutonomousResumeTrigger } from "@traycer/protocol/persistence/epic/content-blocks";

const mocks = vi.hoisted(() => ({
  methodSupport: { value: "supported" },
}));

// The Background panel's managed rows carry the same lifecycle actions the
// chat's monitors menu does, so this suite fakes the one boundary behind them:
// the RPCs. What the rows render and where they lead is still real.
vi.mock(
  "@/hooks/managed-command/use-managed-command-lifecycle-mutations",
  () => ({
    useManagedCommandStart: () => ({ mutate: vi.fn(), isPending: false }),
    useManagedCommandStop: () => ({ mutate: vi.fn(), isPending: false }),
    useManagedCommandStopAll: () => ({ mutate: vi.fn(), isPending: false }),
    useManagedCommandStopAllIsPending: () => false,
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

let epicHandle: OpenEpicStoreHandle | null = null;

/**
 * One live chat session per chat under test: the commands ride each chat's own
 * `chat.subscribe` stream now, so "another chat's monitor" is a fact about a
 * different stream rather than a field this one filters on.
 */
const chatSessions = new Map<string, ManagedCommandChatSessionStub>();

function chatSession(chatId: string): ManagedCommandChatSessionStub {
  const existing = chatSessions.get(chatId);
  if (existing !== undefined) return existing;
  const created = installManagedCommandChatSession({ epicId: EPIC_ID, chatId });
  chatSessions.set(chatId, created);
  return created;
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

/**
 * A chat's whole set, authored through the wire schema so each fixture is
 * exactly what the host would deliver. There is no per-command delta on this
 * stream: every change re-sends the set.
 */
function emitCommands(
  commands: readonly ManagedCommand[],
  chatId: string,
): void {
  const frame = chatSubscribeServerFrameSchema.parse({
    kind: "managedCommandsChanged",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId,
    managedCommands: commands,
  });
  if (frame.kind !== "managedCommandsChanged") {
    throw new Error("unreachable");
  }
  act(() => {
    chatSession(chatId).setCommands(frame.managedCommands);
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
    <TabHostProvider hostId={HOST_ID}>
      <EpicSessionContext.Provider value={epicHandle}>
        <TooltipProvider>{children}</TooltipProvider>
      </EpicSessionContext.Provider>
    </TabHostProvider>,
  );
}

/**
 * The chat's Background panel, which is where a running monitor or shell shows
 * up now. It is a drawer that starts closed, so opening it is part of reaching
 * the rows under test; `items` stays empty because every S6 assertion is about
 * the managed rows the panel joins in, not the harness work beside them.
 */
function renderBackgroundPanelInChat(alongside: React.ReactNode): void {
  renderInChatContext(
    <>
      <BackgroundItemsPanel
        items={[]}
        epicId={EPIC_ID}
        chatId={CHAT_A}
        canAct
        readOnly={false}
        pendingStopTaskIds={new Set()}
        stopAllPending={false}
        scrollRegionMaxHeightClass="max-h-96"
        separated={false}
        onItemClick={() => undefined}
        onStopItem={() => null}
        onStopAll={() => null}
      />
      {alongside}
    </>,
  );
  fireEvent.click(screen.getByRole("button", { name: /Background/ }));
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
});

afterEach(() => {
  cleanup();
  chatSessions.clear();
  disposeManagedCommandChatSessions();
  epicHandle?.dispose();
  epicHandle = null;
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  vi.clearAllMocks();
});

describe("S6 · running work in the chat's Background panel", () => {
  it("S6a: shows only THIS chat's running commands, kind-explicit, and none of another chat's or terminal ones", () => {
    renderBackgroundPanelInChat(null);
    emitCommands(
      [
        makeCommand({ id: "cmd-mine-running", description: "deploy watcher" }),
        makeCommand({
          id: "cmd-mine-done",
          kind: "shell",
          description: "db migration",
          status: {
            state: "exited",
            exitCode: 0,
            signal: null,
            exitedAtMs: T0,
          },
        }),
      ],
      CHAT_A,
    );
    emitCommands(
      [
        makeCommand({
          id: "cmd-theirs-running",
          chatId: CHAT_B,
          description: "other watcher",
        }),
      ],
      CHAT_B,
    );

    const mine = screen.getByTestId(
      "managed-command-background-row-cmd-mine-running",
    );
    expect(mine.textContent).toContain("Monitor · deploy watcher");
    expect(
      screen.queryByTestId("managed-command-background-row-cmd-theirs-running"),
    ).toBeNull();
    expect(
      screen.queryByTestId("managed-command-background-row-cmd-mine-done"),
    ).toBeNull();
  });

  it("S6b: rows appear and disappear as the set is re-sent — removed the moment the command reaches a terminal state", () => {
    renderBackgroundPanelInChat(null);
    emitCommands([], CHAT_A);
    expect(
      screen.queryByTestId("managed-command-background-row-cmd-live"),
    ).toBeNull();

    emitCommands(
      [makeCommand({ id: "cmd-live", description: "fresh watcher" })],
      CHAT_A,
    );
    expect(
      screen.getByTestId("managed-command-background-row-cmd-live"),
    ).toBeTruthy();

    emitCommands(
      [
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
      ],
      CHAT_A,
    );
    expect(
      screen.queryByTestId("managed-command-background-row-cmd-live"),
    ).toBeNull();
  });

  it("S6c: clicking a background row opens the command's output window", () => {
    renderBackgroundPanelInChat(null);
    emitCommands([makeCommand({ id: "cmd-door" })], CHAT_A);

    fireEvent.click(
      screen.getByTestId("managed-command-background-row-cmd-door"),
    );
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
    renderBackgroundPanelInChat(
      <ManagedCommandBadge commandId="cmd-one" commandKind="monitor" />,
    );
    emitCommands(
      [makeCommand({ id: "cmd-one", description: "solo watcher" })],
      CHAT_A,
    );

    fireEvent.click(screen.getByTestId("queued-managed-command-badge"));
    expect(openWindowCountFor("cmd-one")).toBe(1);

    // A different door for the same command focuses the existing window.
    fireEvent.click(
      screen.getByTestId("managed-command-background-row-cmd-one"),
    );
    expect(openWindowCountFor("cmd-one")).toBe(1);

    // And the same door twice does not stack a second pane either.
    fireEvent.click(screen.getByTestId("queued-managed-command-badge"));
    expect(openWindowCountFor("cmd-one")).toBe(1);
  });
});
