import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  type RenderResult,
} from "@testing-library/react";
import type { ReactNode } from "react";
import type { BackgroundItem } from "@traycer/protocol/host/agent/gui/subscribe";
import type { AutonomousResumeTrigger } from "@traycer/protocol/persistence/epic/content-blocks";
import type {
  HeldManagedCommandUpdate,
  ManagedCommand,
} from "@traycer/protocol/host/managed-command/unary-schemas";
import { TooltipProvider } from "@/components/ui/tooltip";

/**
 * The chat's own managed-command surfaces: the chip and the resume divider are
 * doors into the output window, both naming the Shell entity, and the
 * Background panel lists what this chat has running right now. (The Shells
 * menu that used to sit beside the composer is gone - the transcript's start
 * cards and the output window carry what it did.)
 */

const streamSupport = vi.hoisted<{ value: string }>(() => ({
  value: "supported",
}));

vi.mock("@/lib/host/stream-runtime-context", () => ({
  useWsStreamClient: () => null,
  useStreamMethodSupport: () => streamSupport.value,
  useStreamMethodSchemaVersion: () => null,
}));

// The one faked boundary: the lifecycle RPCs behind a managed row's hover
// actions. Everything the surfaces do with them - which rows offer them, what
// they are called with - is real. The aggregated stop-all has its own suite
// over a real host client.
const stopMutate = vi.fn();
const stopAllMutate = vi.fn();
const deliverHeldMutate = vi.fn();
/**
 * The two pending reads are separate flags on purpose, and driving them from
 * one was a hole rather than a shortcut.
 *
 * A mutation result's `isPending` is PER-OBSERVER, so the same chat open in two
 * tiles leaves the second tile's button live while the first tile's call is in
 * flight - which for a null-ids Deliver is not a narrower duplicate but the
 * identical whole-chat action re-sent. The shared `useIsMutating` read is what
 * closes that, and it is the only one a panel may consult. While one flag drove
 * both, a component that switched to the local `isPending` - the exact
 * regression the shared hook exists to prevent - kept every test green.
 *
 * The `*OwnFlight` flags therefore stay false in the gate tests below: a panel
 * that reads them fails, which is the point. (In production the shared read is
 * a superset - `useIsMutating` counts this observer's own mutation too - so
 * own-true/shared-false is a state only a test can produce.)
 */
const stopAllOwnFlight = { isPending: false };
const stopAllSharedFlight = { isPending: false };
const deliverHeldOwnFlight = { isPending: false };
const deliverHeldSharedFlight = { isPending: false };
vi.mock(
  "@/hooks/managed-command/use-managed-command-lifecycle-mutations",
  () => ({
    useManagedCommandStart: () => ({ mutate: vi.fn(), isPending: false }),
    useManagedCommandStop: () => ({ mutate: stopMutate, isPending: false }),
    useManagedCommandStopAll: () => ({
      mutate: stopAllMutate,
      isPending: stopAllOwnFlight.isPending,
    }),
    useManagedCommandStopAllIsPending: () => stopAllSharedFlight.isPending,
    useManagedCommandDelete: () => ({ mutate: vi.fn(), isPending: false }),
    useManagedCommandDeliverHeld: () => ({
      mutate: deliverHeldMutate,
      isPending: deliverHeldOwnFlight.isPending,
    }),
    useManagedCommandDeliverHeldIsPending: () =>
      deliverHeldSharedFlight.isPending,
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
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { findOpenArtifactInTab } from "@/stores/epics/canvas/canvas-selectors";
import { ManagedCommandBadge } from "@/components/chat/queued-message-surface";
import { AutonomousResumeSegment } from "@/components/chat/segments/autonomous-resume-segment";
import { BackgroundItemsPanel } from "@/components/chat/chat-background-items-panel";

const EPIC_ID = "epic-1";
const TAB_ID = "tab-1";
const CHAT_ID = "chat-1";

/** One harness-owned background row, so the panel is never managed-only. */
const HARNESS_ITEM: BackgroundItem = {
  taskId: "harness-task",
  kind: "command",
  title: "bun run compile",
  blockId: "harness-task-tool",
  parentTaskId: null,
  scheduledFor: null,
};

function command(over: Partial<ManagedCommand>): ManagedCommand {
  return {
    id: "cmd-1",
    monitoring: true,
    description: "deploy watcher",
    command: "tail -f deploy.log",
    cwd: "/work/repo",
    cadence: { debounceMs: 500, maxWaitMs: 15_000, throttleMs: 5_000 },
    status: { state: "running", pid: 4410, startedAtMs: 10 },
    chatId: CHAT_ID,
    createdAtMs: 10,
    updatedAtMs: 10,
    ...over,
  };
}

function held(
  over: Partial<HeldManagedCommandUpdate>,
): HeldManagedCommandUpdate {
  return {
    commandId: "cmd-1",
    description: "deploy watcher",
    heldAtMs: 10,
    ...over,
  };
}

function trigger(
  over: Partial<AutonomousResumeTrigger>,
): AutonomousResumeTrigger {
  return {
    kind: "monitor",
    blockId: "block-1",
    title: "deploy watcher",
    status: "completed",
    summary: "",
    live: false,
    outputFile: null,
    mcp: null,
    managedCommand: null,
    ...over,
  };
}

/**
 * The commands ride each chat's own stream now, so a suite that needs two
 * chats' menus needs two sessions. Created on first use so a test that never
 * mentions a chat leaves it without one - which is also the "no session yet"
 * state the surfaces must survive.
 */
const chatSessions = new Map<string, ManagedCommandChatSessionStub>();

function chatSession(chatId: string): ManagedCommandChatSessionStub {
  const existing = chatSessions.get(chatId);
  if (existing !== undefined) return existing;
  const created = installManagedCommandChatSession({
    epicId: EPIC_ID,
    chatId,
    // The same host the surfaces below are wrapped in via `TabHostProvider` -
    // chat sessions are keyed by (epic, chat, host).
    hostId: "host-1",
  });
  chatSessions.set(chatId, created);
  return created;
}

/** This chat's whole set, the way the host sends it - never a delta. */
function setCommands(
  commands: readonly ManagedCommand[],
  chatId: string,
): void {
  chatSession(chatId).setCommands(commands);
}

/** This chat's whole set of held updates, the way the host sends it. */
function setHeldUpdates(
  heldUpdates: readonly HeldManagedCommandUpdate[],
  chatId: string,
): void {
  chatSession(chatId).setHeldUpdates(heldUpdates);
}

function chatTileTree(node: ReactNode): ReactNode {
  return (
    <EpicSessionContext.Provider value={epicHandle}>
      <TabHostProvider hostId="host-1">
        <TooltipProvider>{node}</TooltipProvider>
      </TabHostProvider>
    </EpicSessionContext.Provider>
  );
}

function renderInChatTile(node: ReactNode): RenderResult {
  return render(chatTileTree(node));
}

const noopStreamClientFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});

let epicHandle: OpenEpicStoreHandle;

beforeEach(() => {
  stopMutate.mockClear();
  stopAllMutate.mockClear();
  stopAllOwnFlight.isPending = false;
  stopAllSharedFlight.isPending = false;
  deliverHeldMutate.mockClear();
  deliverHeldOwnFlight.isPending = false;
  deliverHeldSharedFlight.isPending = false;
  streamSupport.value = "supported";
  epicHandle = createOpenEpicStore({
    epicId: EPIC_ID,
    streamClientFactory: noopStreamClientFactory,
    userId: null,
    onAuthError: null,
  });
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useEpicCanvasStore.setState({
    tabsById: { [TAB_ID]: { tabId: TAB_ID, epicId: EPIC_ID, name: "Epic 1" } },
    openTabOrder: [TAB_ID],
    activeTabId: TAB_ID,
  });
});

afterEach(() => {
  cleanup();
  epicHandle.dispose();
  chatSessions.clear();
  disposeManagedCommandChatSessions();
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
});

describe("queued-delivery chip", () => {
  it("names the shell whose output is waiting, monitoring or not", () => {
    renderInChatTile(
      <ManagedCommandBadge commandId="cmd-1" monitoring={false} />,
    );

    expect(screen.getByTestId("queued-managed-command-badge").textContent).toBe(
      "Shell output",
    );
  });

  it("still names the shell when the item predates the monitor flag", () => {
    // The entity is known even when the flag is not, so only the glyph falls
    // back - the label never says "command".
    renderInChatTile(
      <ManagedCommandBadge commandId="cmd-1" monitoring={null} />,
    );

    const badge = screen.getByTestId("queued-managed-command-badge");
    expect(badge.textContent).toBe("Shell output");
    expect(badge.querySelector("[data-monitor-icon]")).toBeNull();
  });

  it("shows the monitor glyph rather than a terminal one", () => {
    renderInChatTile(
      <ManagedCommandBadge commandId="cmd-1" monitoring={false} />,
    );

    const badge = screen.getByTestId("queued-managed-command-badge");
    expect(badge.querySelector("[data-monitor-icon='off']")).not.toBeNull();
  });

  it("describes what is waiting in shell words, not 'background command'", () => {
    renderInChatTile(<ManagedCommandBadge commandId="cmd-1" monitoring />);

    fireEvent.focus(screen.getByTestId("queued-managed-command-badge"));

    const tip = screen.getAllByRole("tooltip")[0];
    expect(tip.textContent).toContain("shell");
    expect(tip.textContent).not.toContain("background command");
  });

  it("is a door into the shell's output window", () => {
    renderInChatTile(<ManagedCommandBadge commandId="cmd-1" monitoring />);

    fireEvent.click(screen.getByTestId("queued-managed-command-badge"));

    expect(findOpenArtifactInTab(TAB_ID, "cmd-1")).not.toBeNull();
  });
});

describe("resume divider", () => {
  it("names the shell, not a generic Command, for a shell's mid-run output", () => {
    renderInChatTile(
      <AutonomousResumeSegment
        triggers={[
          trigger({
            blockId: "block-live-shell",
            live: true,
            managedCommand: { commandId: "cmd-2", monitoring: true },
          }),
        ]}
      />,
    );

    expect(screen.getByText("Monitor still running")).not.toBeNull();
  });

  it("keeps the generic copy for a legacy trigger that names no shell", () => {
    // Written before the trigger carried `managedCommand`, so the divider has
    // nothing to be specific about and must not guess.
    renderInChatTile(
      <AutonomousResumeSegment
        triggers={[
          trigger({
            blockId: "block-live-legacy",
            live: true,
            managedCommand: null,
          }),
        ]}
      />,
    );

    expect(screen.getByText("Command still running")).not.toBeNull();
  });

  it("names the shell in its terminal copy, by whether it was watching", () => {
    renderInChatTile(
      <AutonomousResumeSegment
        triggers={[
          trigger({
            blockId: "block-quiet",
            status: "completed",
            managedCommand: { commandId: "cmd-1", monitoring: false },
          }),
          trigger({
            blockId: "block-watcher",
            status: "failed",
            managedCommand: { commandId: "cmd-2", monitoring: true },
          }),
        ]}
      />,
    );

    expect(screen.getByText("Shell completed")).not.toBeNull();
    expect(screen.getByText("Monitor failed")).not.toBeNull();
  });

  it("keeps the harness Monitor name for a kind-only trigger, and offers it no door", () => {
    // No `managedCommand` block means this is not a Traycer shell - kind-only
    // "monitor" triggers are produced live by Claude Code's own Monitor tool,
    // which keeps its real name.
    renderInChatTile(
      <AutonomousResumeSegment
        triggers={[trigger({ status: "failed", managedCommand: null })]}
      />,
    );

    expect(screen.getByText("Monitor failed")).not.toBeNull();
    expect(
      screen.queryByTestId("resume-managed-command-door-block-1"),
    ).toBeNull();
  });

  it("opens the shell's output window when it carries one", () => {
    renderInChatTile(
      <AutonomousResumeSegment
        triggers={[
          trigger({
            managedCommand: { commandId: "cmd-1", monitoring: true },
          }),
        ]}
      />,
    );

    fireEvent.click(screen.getByTestId("resume-managed-command-door-block-1"));

    expect(findOpenArtifactInTab(TAB_ID, "cmd-1")).not.toBeNull();
  });
});

describe("running commands in the Background panel", () => {
  function renderPanel(items: ReadonlyArray<BackgroundItem>): {
    onStopAll: Mock<() => string | null>;
  } {
    return renderPanelWith(items, true);
  }

  /** `canAct` is "this chat's stream is open" - a harness-side capability. */
  function renderPanelWith(
    items: ReadonlyArray<BackgroundItem>,
    canAct: boolean,
  ): {
    onStopAll: Mock<() => string | null>;
  } {
    const onStopAll: Mock<() => string | null> = vi.fn(() => null);
    renderInChatTile(
      <BackgroundItemsPanel
        items={items}
        epicId={EPIC_ID}
        chatId={CHAT_ID}
        viewTabId={TAB_ID}
        canAct={canAct}
        readOnly={false}
        pendingStopTaskIds={new Set()}
        stopAllPending={false}
        scrollRegionMaxHeightClass="max-h-96"
        separated={false}
        onItemClick={() => undefined}
        onStopItem={() => null}
        onStopAll={onStopAll}
      />,
    );
    return { onStopAll };
  }

  function expandPanel(): void {
    fireEvent.click(screen.getByRole("button", { name: /Background/ }));
  }

  it("lists only this chat's running shells, entity-named", () => {
    renderPanel([]);
    act(() => {
      setCommands(
        [
          command({ id: "mine-running" }),
          command({
            id: "mine-exited",
            status: {
              state: "exited",
              exitCode: 0,
              signal: null,
              exitedAtMs: 5,
            },
          }),
        ],
        CHAT_ID,
      );
      // Another chat's shell rides another chat's stream, so this panel can
      // never see it however busy that chat is.
      setCommands([command({ id: "other-chat", chatId: "chat-2" })], "chat-2");
    });
    expandPanel();

    const rows = screen.getAllByTestId(/^managed-command-background-row-/);
    expect(rows.map((row) => row.getAttribute("data-testid"))).toEqual([
      "managed-command-background-row-mine-running",
    ]);
    expect(rows[0].textContent).toContain("Monitor · deploy watcher");
  });

  it("drops a row the moment its command reaches a terminal state", () => {
    renderPanel([]);
    act(() => {
      setCommands([command({ id: "mine-running" })], CHAT_ID);
    });
    expandPanel();

    act(() => {
      setCommands(
        [
          command({
            id: "mine-running",
            status: {
              state: "exited",
              exitCode: 0,
              signal: null,
              exitedAtMs: 5,
            },
          }),
        ],
        CHAT_ID,
      );
    });

    expect(
      screen.queryByTestId("managed-command-background-row-mine-running"),
    ).toBeNull();
  });

  it("opens the output window from a row", () => {
    renderPanel([]);
    act(() => {
      setCommands([command({ id: "mine-running" })], CHAT_ID);
    });
    expandPanel();

    fireEvent.click(
      screen.getByTestId("managed-command-background-row-mine-running"),
    );

    expect(findOpenArtifactInTab(TAB_ID, "mine-running")).not.toBeNull();
  });

  it("reads in the panel's own row grammar: glyph, elapsed, hover stop", () => {
    renderPanel([]);
    act(() => {
      setCommands(
        [
          command({
            id: "mine-running",
            monitoring: false,
            status: {
              state: "running",
              pid: 4410,
              startedAtMs: Date.now() - 65_000,
            },
          }),
        ],
        CHAT_ID,
      );
    });
    expandPanel();

    const row = screen.getByTestId(
      "managed-command-background-row-mine-running",
    );
    // The glyph is what keeps a supervised shell apart from the harness's own
    // background kinds; the title names the entity by its monitor state.
    expect(row.querySelector("[data-monitor-icon='off']")).not.toBeNull();
    expect(row.textContent).toContain("Shell · deploy watcher");
    // The pill slot is EMPTY on a shell row, whatever the flag says: the
    // title's own noun is what carries it, so a pill would be a second fact
    // and is none.
    expect(within(row).queryByText("Shell")).toBeNull();
    expect(within(row).queryByText("Monitoring")).toBeNull();
    // ...and the glyph doesn't announce it either, or the row would read the
    // same state out twice.
    expect(row.querySelector("[aria-label='Not monitoring']")).toBeNull();
    // Same clock format the harness rows use, so two rows side by side read
    // as one list rather than two conventions.
    expect(row.textContent).toContain("1m 5s");

    fireEvent.click(screen.getByTestId("managed-command-stop-mine-running"));
    expect(stopMutate).toHaveBeenCalledWith({
      hostId: "host-1",
      epicId: EPIC_ID,
      commandId: "mine-running",
    });
  });

  it("says a watching shell is a Monitor in the title, and pins no pill beside it", () => {
    renderPanel([]);
    act(() => {
      setCommands([command({ id: "mine-running", monitoring: true })], CHAT_ID);
    });
    expandPanel();

    const row = screen.getByTestId(
      "managed-command-background-row-mine-running",
    );
    expect(row.textContent).toContain("Monitor · deploy watcher");
    expect(within(row).queryByText("Monitoring")).toBeNull();
    expect(row.querySelector("[data-monitor-icon='on']")).not.toBeNull();
    expect(row.querySelector("[aria-label='Monitoring']")).toBeNull();
  });

  it("renames a live row when the agent turns its monitor flag off", () => {
    renderPanel([]);
    act(() => {
      setCommands([command({ id: "mine-running", monitoring: true })], CHAT_ID);
    });
    expandPanel();

    const row = () =>
      screen.getByTestId("managed-command-background-row-mine-running");
    expect(row().textContent).toContain("Monitor · deploy watcher");

    // Muting is applied live by the host - no restart, same record - so the
    // row stays put and its NAME reports that it stopped being a watcher.
    act(() => {
      setCommands(
        [command({ id: "mine-running", monitoring: false, updatedAtMs: 40 })],
        CHAT_ID,
      );
    });

    expect(row().textContent).toContain("Shell · deploy watcher");
    expect(row().textContent).not.toContain("Monitor");
  });

  it("offers stop and nothing destructive: this is a status, not the object", () => {
    renderPanel([]);
    act(() => {
      setCommands([command({ id: "mine-running" })], CHAT_ID);
    });
    expandPanel();

    expect(
      screen.getByTestId("managed-command-stop-mine-running"),
    ).not.toBeNull();
    // Delete destroys the shell's whole output history. It belongs to the
    // chat's Shells menu and the output window, where a shell is a durable
    // object - not to a row that exists only while the process does.
    expect(
      screen.queryByTestId("managed-command-delete-mine-running"),
    ).toBeNull();
    expect(
      screen.queryByTestId("managed-command-start-mine-running"),
    ).toBeNull();
  });

  it("counts managed commands into the one running total the button can keep", () => {
    renderPanel([HARNESS_ITEM]);
    act(() => {
      setCommands(
        [
          command({ id: "m1" }),
          command({ id: "m2" }),
          command({ id: "s1", monitoring: false }),
        ],
        CHAT_ID,
      );
    });

    // One press of Stop all now reaches all four, so one summed total is a
    // promise the button keeps.
    expect(screen.getByTestId("background-header-summary").textContent).toBe(
      "4 running",
    );
  });

  it("keeps the plain summary when the chat has no managed commands", () => {
    renderPanel([HARNESS_ITEM]);
    act(() => {
      setCommands([], CHAT_ID);
    });

    expect(screen.getByTestId("background-header-summary").textContent).toBe(
      "1 running",
    );
  });

  it("stops the managed rows too when Stop all is pressed, as one action", () => {
    const panel = renderPanel([HARNESS_ITEM]);
    act(() => {
      setCommands(
        [command({ id: "m1" }), command({ id: "m2", monitoring: false })],
        CHAT_ID,
      );
    });
    expandPanel();

    fireEvent.click(screen.getByTestId("background-stop-all"));

    // The harness stop-all cannot reach host-supervised commands, so those go
    // through their own stop alongside it - one button, two mechanisms. The
    // managed half is ONE call over the whole set, not one per row: a host
    // that has gone away fails them all for the same reason, and per-row
    // mutations reported that reason once per row.
    expect(panel.onStopAll).toHaveBeenCalledTimes(1);
    expect(stopAllMutate).toHaveBeenCalledTimes(1);
    expect(stopAllMutate).toHaveBeenCalledWith({
      hostId: "host-1",
      epicId: EPIC_ID,
      commandIds: ["m1", "m2"],
    });
    expect(stopMutate).not.toHaveBeenCalled();
  });

  it("stays dead while anything it started is still in flight", () => {
    stopAllSharedFlight.isPending = true;
    const panel = renderPanel([HARNESS_ITEM]);
    act(() => {
      setCommands([command({ id: "m1" })], CHAT_ID);
    });
    expandPanel();

    // Re-enabling as soon as one half finished let a second press resubmit
    // the finished half while the other was still running - one button, one
    // in-flight state.
    const stopAllButton = screen.getByRole<HTMLButtonElement>("button", {
      name: "Stop all",
    });
    expect(stopAllButton.disabled).toBe(true);
    fireEvent.click(stopAllButton);
    expect(panel.onStopAll).not.toHaveBeenCalled();
    expect(stopAllMutate).not.toHaveBeenCalled();
  });

  it("disables Stop all only when neither half can act", () => {
    stopAllSharedFlight.isPending = true;
    const panel = renderPanelWith([HARNESS_ITEM], false);
    act(() => {
      setCommands([command({ id: "m1" })], CHAT_ID);
    });

    // Harness half gated by the closed stream, managed half in flight: with
    // nothing left for a press to do, the button finally disables.
    const stopAllButton = screen.getByRole<HTMLButtonElement>("button", {
      name: "Stop all",
    });
    expect(stopAllButton.disabled).toBe(true);
    fireEvent.click(stopAllButton);
    expect(panel.onStopAll).not.toHaveBeenCalled();
  });

  it("keeps a managed row stoppable while the chat stream is reconnecting", () => {
    const panel = renderPanelWith([HARNESS_ITEM], false);
    act(() => {
      setCommands([command({ id: "m1" })], CHAT_ID);
    });
    expandPanel();

    // Stopping a managed command is an RPC to its host; the chat's own stream
    // has no part in it. Gating it on `canAct` left a reconnecting chat with
    // no way to stop a runaway monitor from anywhere in the panel.
    expect(screen.getByTestId("managed-command-stop-m1")).not.toBeNull();
    // The harness row's stop DOES ride the chat stream, so it stays gated.
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Stop Command" })
        .disabled,
    ).toBe(true);

    // And the aggregate follows the same split: the button stays live for the
    // managed half, and a press skips the unreachable harness half rather
    // than dying with it - a reconnect is exactly when a runaway shell
    // needs the one-click stop.
    const stopAllButton = screen.getByRole<HTMLButtonElement>("button", {
      name: "Stop all",
    });
    expect(stopAllButton.disabled).toBe(false);
    fireEvent.click(stopAllButton);
    expect(panel.onStopAll).not.toHaveBeenCalled();
    expect(stopAllMutate).toHaveBeenCalledTimes(1);
    expect(stopAllMutate).toHaveBeenCalledWith({
      hostId: "host-1",
      epicId: EPIC_ID,
      commandIds: ["m1"],
    });
  });

  it("no longer disclaims a subset Stop all cannot reach", () => {
    renderPanel([HARNESS_ITEM]);
    act(() => {
      setCommands([command({ id: "m1" })], CHAT_ID);
    });
    expandPanel();

    expect(screen.queryByText("Not stopped by Stop all")).toBeNull();
    expect(screen.queryByText("Shells")).toBeNull();
  });
});

describe("held shells in the Background panel", () => {
  function renderPanel(): void {
    renderPanelAs(false);
  }

  /** `readOnly` is the viewer's own permission - the one gate a host RPC from
   *  this panel still answers to, since the chat stream's state does not. */
  function renderPanelAs(readOnly: boolean): void {
    renderInChatTile(
      <BackgroundItemsPanel
        items={[]}
        epicId={EPIC_ID}
        chatId={CHAT_ID}
        viewTabId={TAB_ID}
        canAct
        readOnly={readOnly}
        pendingStopTaskIds={new Set()}
        stopAllPending={false}
        scrollRegionMaxHeightClass="max-h-96"
        separated={false}
        onItemClick={() => undefined}
        onStopItem={() => null}
        onStopAll={() => null}
      />,
    );
  }

  function expandPanel(): void {
    fireEvent.click(screen.getByRole("button", { name: /Background/ }));
  }

  it("shows no Deliver button when this chat holds nothing", () => {
    renderPanel();

    expect(screen.queryByTestId("background-deliver-held")).toBeNull();
  });

  it("appears the moment this chat has a held shell, named by count", () => {
    renderPanel();
    act(() => {
      setHeldUpdates([held({ commandId: "cmd-1" })], CHAT_ID);
    });

    expect(screen.getByTestId("background-deliver-held").textContent).toBe(
      "Deliver",
    );

    act(() => {
      setHeldUpdates(
        [held({ commandId: "cmd-1" }), held({ commandId: "cmd-2" })],
        CHAT_ID,
      );
    });

    expect(screen.getByTestId("background-deliver-held").textContent).toBe(
      "Deliver 2",
    );
  });

  it("sends commandIds: null, not the rendered ids", () => {
    renderPanel();
    act(() => {
      setHeldUpdates(
        [held({ commandId: "cmd-1" }), held({ commandId: "cmd-2" })],
        CHAT_ID,
      );
    });

    fireEvent.click(screen.getByTestId("background-deliver-held"));

    // A hold installed between render and click must not be silently
    // skipped - Deliver means "everything you are holding for me", not "the
    // ids this panel happened to show".
    expect(deliverHeldMutate).toHaveBeenCalledTimes(1);
    expect(deliverHeldMutate).toHaveBeenCalledWith({
      hostId: "host-1",
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      commandIds: null,
    });
  });

  it("disables the Deliver button while a Deliver is already in flight", () => {
    deliverHeldSharedFlight.isPending = true;
    renderPanel();
    act(() => {
      setHeldUpdates([held({ commandId: "cmd-1" })], CHAT_ID);
    });

    const deliverButton = screen.getByTestId<HTMLButtonElement>(
      "background-deliver-held",
    );
    expect(deliverButton.disabled).toBe(true);
    fireEvent.click(deliverButton);
    expect(deliverHeldMutate).not.toHaveBeenCalled();
  });

  it("renders held rows above running rows", () => {
    renderPanel();
    act(() => {
      setCommands([command({ id: "running-1" })], CHAT_ID);
      setHeldUpdates([held({ commandId: "held-1" })], CHAT_ID);
    });
    expandPanel();

    const heldRow = screen.getByTestId("held-managed-command-row-held-1");
    const runningRow = screen.getByTestId(
      "managed-command-background-row-running-1",
    );
    expect(
      heldRow.compareDocumentPosition(runningRow) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  // The host filters holds by no status, and a running shell keeps its hold
  // until it next prints - so a watcher that went quiet before the Stop is in
  // BOTH lists. Rendered whole, it appeared twice: a "Held" row and a live row
  // with a running timer, under a header that called it one running shell.
  it("renders a held-and-running shell once, as held", () => {
    renderPanel();
    act(() => {
      setCommands(
        [command({ id: "quiet-watcher" }), command({ id: "busy-shell" })],
        CHAT_ID,
      );
      setHeldUpdates([held({ commandId: "quiet-watcher" })], CHAT_ID);
    });
    expandPanel();

    expect(
      screen.getByTestId("held-managed-command-row-quiet-watcher"),
    ).not.toBeNull();
    expect(
      screen.queryByTestId("managed-command-background-row-quiet-watcher"),
    ).toBeNull();
    // The shell that is only running keeps its ordinary row.
    expect(
      screen.getByTestId("managed-command-background-row-busy-shell"),
    ).not.toBeNull();
  });

  it("keeps the header count agreeing with the rows on screen", () => {
    renderPanel();
    act(() => {
      setCommands(
        [command({ id: "quiet-watcher" }), command({ id: "busy-shell" })],
        CHAT_ID,
      );
      setHeldUpdates([held({ commandId: "quiet-watcher" })], CHAT_ID);
    });

    // Two running commands, but one of them renders as held - so "2 running"
    // would name a row that is not there. Every number counts rows you can see.
    expect(screen.getByTestId("background-header-summary").textContent).toBe(
      "1 running · 1 held",
    );
  });

  it("still offers Stop on a held row whose shell has not finished", () => {
    renderPanel();
    act(() => {
      setCommands([command({ id: "quiet-watcher" })], CHAT_ID);
      setHeldUpdates([held({ commandId: "quiet-watcher" })], CHAT_ID);
    });
    expandPanel();

    // Held does not imply finished, and this row is the only place the shell
    // appears - dropping the stop here would be the panel's one lost
    // capability for a process that is still burning cycles.
    fireEvent.click(screen.getByTestId("managed-command-stop-quiet-watcher"));
    expect(stopMutate).toHaveBeenCalledWith({
      hostId: "host-1",
      epicId: EPIC_ID,
      commandId: "quiet-watcher",
    });
  });

  it("offers no Stop on a held row whose shell has finished", () => {
    renderPanel();
    act(() => {
      // The ordinary hold: the Stop caught this shell's FINAL batch, so it is
      // absent from the running set and there is nothing left to stop.
      setCommands([], CHAT_ID);
      setHeldUpdates([held({ commandId: "finished-shell" })], CHAT_ID);
    });
    expandPanel();

    expect(
      screen.getByTestId("held-managed-command-row-finished-shell"),
    ).not.toBeNull();
    expect(
      screen.queryByTestId("managed-command-stop-finished-shell"),
    ).toBeNull();
    expect(screen.getByTestId("background-header-summary").textContent).toBe(
      "1 held",
    );
  });

  it("does not offer Deliver to a viewer", () => {
    renderPanelAs(true);
    act(() => {
      setHeldUpdates([held({ commandId: "cmd-1" })], CHAT_ID);
    });

    // The host refuses a viewer's Deliver, so a live button here could only
    // ever produce an error toast - the same rule the managed rows' Stop
    // already follows.
    const deliverButton = screen.getByTestId<HTMLButtonElement>(
      "background-deliver-held",
    );
    expect(deliverButton.disabled).toBe(true);
    fireEvent.click(deliverButton);
    expect(deliverHeldMutate).not.toHaveBeenCalled();
  });
});
