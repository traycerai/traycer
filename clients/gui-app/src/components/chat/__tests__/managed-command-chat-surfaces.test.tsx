import "../../../../__tests__/test-browser-apis";
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
} from "@testing-library/react";
import type { ReactNode } from "react";
import type { AutonomousResumeTrigger } from "@traycer/protocol/persistence/epic/content-blocks";
import type { ManagedCommand } from "@traycer/protocol/host/managed-command/unary-schemas";
import type { ManagedCommandListStreamCallbacks } from "@traycer-clients/shared/host-transport/managed-command-list-stream-client";
import { TooltipProvider } from "@/components/ui/tooltip";

/**
 * The chat's own managed-command surfaces (`UI.md` §3, §5): the chip and the
 * resume divider are doors into the output window, both kind-explicit; the
 * running-work strip lists the commands this chat has running right now.
 */

vi.mock("@/lib/host/stream-runtime-context", () => ({
  useWsStreamClient: () => null,
  useStreamMethodSupport: () => "supported",
  useStreamMethodSchemaVersion: () => null,
}));

// The one faked boundary: the lifecycle RPCs behind a managed row's hover
// actions. Everything the strip does with them - which rows offer them, what
// they are called - is real.
const stopMutate = vi.fn();
vi.mock(
  "@/hooks/managed-command/use-managed-command-lifecycle-mutations",
  () => ({
    useManagedCommandStart: () => ({ mutate: vi.fn(), isPending: false }),
    useManagedCommandStop: () => ({ mutate: stopMutate, isPending: false }),
    useManagedCommandDelete: () => ({ mutate: vi.fn(), isPending: false }),
  }),
);

import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";
import { EpicSessionContext } from "@/lib/registries/epic-session-registry";
import {
  createOpenEpicStore,
  type EpicStreamClientFactory,
  type OpenEpicStoreHandle,
} from "@/stores/epics/open-epic/store";
import { ManagedCommandListStreamMount } from "@/providers/managed-command-list-stream-mount";
import { __setManagedCommandListStreamClientFactoryForTests } from "@/providers/managed-command-list-stream-factory-override";
import { managedCommandListRegistry } from "@/stores/managed-commands/managed-command-list-registry";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { findOpenArtifactInTab } from "@/stores/epics/canvas/canvas-selectors";
import { ManagedCommandBadge } from "@/components/chat/queued-message-surface";
import { AutonomousResumeSegment } from "@/components/chat/segments/autonomous-resume-segment";
import { ManagedCommandStripRows } from "@/components/chat/managed-command-strip-rows";
import { BackgroundItemsPanel } from "@/components/chat/chat-background-items-panel";

const EPIC_ID = "epic-1";
const TAB_ID = "tab-1";
const CHAT_ID = "chat-1";

function command(over: Partial<ManagedCommand>): ManagedCommand {
  return {
    id: "cmd-1",
    kind: "monitor",
    description: "deploy watcher",
    status: { state: "running", pid: 4410, startedAtMs: 10 },
    chatId: CHAT_ID,
    createdAtMs: 10,
    updatedAtMs: 10,
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

function installListStub(): { emit: () => ManagedCommandListStreamCallbacks } {
  let captured: ManagedCommandListStreamCallbacks | null = null;
  __setManagedCommandListStreamClientFactoryForTests((_epicId, callbacks) => {
    captured = callbacks;
    return { close: () => undefined };
  });
  return {
    emit: () => {
      if (captured === null) throw new Error("list callbacks not wired");
      return captured;
    },
  };
}

function renderInChatTile(node: ReactNode): void {
  render(
    <EpicSessionContext.Provider value={epicHandle}>
      <TabHostProvider hostId="host-1">
        <TooltipProvider>{node}</TooltipProvider>
      </TabHostProvider>
    </EpicSessionContext.Provider>,
  );
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
  __setManagedCommandListStreamClientFactoryForTests(null);
  managedCommandListRegistry.disposeAll();
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
});

describe("queued-delivery chip", () => {
  it("names the kind of command whose output is waiting", () => {
    renderInChatTile(
      <ManagedCommandBadge commandId="cmd-1" commandKind="shell" />,
    );

    expect(screen.getByTestId("queued-managed-command-badge").textContent).toBe(
      "Shell output",
    );
  });

  it("falls back to a kind-free label when the host did not say", () => {
    renderInChatTile(
      <ManagedCommandBadge commandId="cmd-1" commandKind={null} />,
    );

    expect(screen.getByTestId("queued-managed-command-badge").textContent).toBe(
      "Command output",
    );
  });

  it("shows the kind's own glyph rather than a terminal one", () => {
    renderInChatTile(
      <ManagedCommandBadge commandId="cmd-1" commandKind="shell" />,
    );

    const badge = screen.getByTestId("queued-managed-command-badge");
    expect(badge.querySelector("[data-kind-icon='shell']")).not.toBeNull();
  });

  it("describes what is waiting in monitor/shell words, not 'background command'", () => {
    renderInChatTile(
      <ManagedCommandBadge commandId="cmd-1" commandKind="monitor" />,
    );

    fireEvent.focus(screen.getByTestId("queued-managed-command-badge"));

    const tip = screen.getAllByRole("tooltip")[0];
    expect(tip.textContent).toContain("monitor");
    expect(tip.textContent).not.toContain("background command");
  });

  it("is a door into the command's output window", () => {
    renderInChatTile(
      <ManagedCommandBadge commandId="cmd-1" commandKind="monitor" />,
    );

    fireEvent.click(screen.getByTestId("queued-managed-command-badge"));

    expect(findOpenArtifactInTab(TAB_ID, "cmd-1")).not.toBeNull();
  });
});

describe("resume divider", () => {
  it("names the real kind while the command is still running", () => {
    renderInChatTile(
      <AutonomousResumeSegment
        triggers={[
          trigger({
            blockId: "block-live-monitor",
            live: true,
            managedCommand: { commandId: "cmd-1", kind: "monitor" },
          }),
        ]}
      />,
    );

    expect(screen.getByText("Monitor still running")).not.toBeNull();
  });

  it("says Shell, not Command, for a backgrounded shell's mid-run output", () => {
    renderInChatTile(
      <AutonomousResumeSegment
        triggers={[
          trigger({
            blockId: "block-live-shell",
            live: true,
            managedCommand: { commandId: "cmd-2", kind: "shell" },
          }),
        ]}
      />,
    );

    expect(screen.getByText("Shell still running")).not.toBeNull();
  });

  it("keeps the kind-free copy for a legacy trigger that names no kind", () => {
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

  it("names the real kind in its terminal copy", () => {
    renderInChatTile(
      <AutonomousResumeSegment
        triggers={[
          trigger({
            status: "completed",
            managedCommand: { commandId: "cmd-1", kind: "shell" },
          }),
        ]}
      />,
    );

    // The persisted trigger kind is frozen at "monitor" for both; the real
    // kind rides `trigger.managedCommand`.
    expect(screen.getByText("Shell completed")).not.toBeNull();
  });

  it("keeps the generic copy and offers no door for an old trigger", () => {
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

  it("opens the command's output window when it carries one", () => {
    renderInChatTile(
      <AutonomousResumeSegment
        triggers={[
          trigger({
            managedCommand: { commandId: "cmd-1", kind: "monitor" },
          }),
        ]}
      />,
    );

    fireEvent.click(screen.getByTestId("resume-managed-command-door-block-1"));

    expect(findOpenArtifactInTab(TAB_ID, "cmd-1")).not.toBeNull();
  });
});

describe("running-work strip rows", () => {
  function renderStrip(): { emit: () => ManagedCommandListStreamCallbacks } {
    const stub = installListStub();
    renderInChatTile(
      <>
        <ManagedCommandListStreamMount epicId={EPIC_ID} />
        <ManagedCommandStripRows epicId={EPIC_ID} chatId={CHAT_ID} />
      </>,
    );
    return stub;
  }

  it("lists only this chat's running commands, kind-explicit", () => {
    const stub = renderStrip();

    act(() => {
      stub.emit().onSnapshot([
        command({ id: "mine-running" }),
        command({
          id: "mine-exited",
          status: { state: "exited", exitCode: 0, signal: null, exitedAtMs: 5 },
        }),
        command({ id: "other-chat", chatId: "chat-2" }),
      ]);
    });

    const rows = screen.getAllByTestId(/^managed-command-strip-row-/);
    expect(rows.map((row) => row.getAttribute("data-testid"))).toEqual([
      "managed-command-strip-row-mine-running",
    ]);
    expect(rows[0].textContent).toContain("Monitor · deploy watcher");
  });

  it("drops a row the moment its command reaches a terminal state", () => {
    const stub = renderStrip();
    act(() => {
      stub.emit().onSnapshot([command({ id: "mine-running" })]);
    });

    act(() => {
      stub.emit().onChanged(
        command({
          id: "mine-running",
          status: { state: "exited", exitCode: 0, signal: null, exitedAtMs: 5 },
        }),
      );
    });

    expect(
      screen.queryByTestId("managed-command-strip-row-mine-running"),
    ).toBeNull();
  });

  it("opens the output window from a strip row", () => {
    const stub = renderStrip();
    act(() => {
      stub.emit().onSnapshot([command({ id: "mine-running" })]);
    });

    fireEvent.click(
      screen.getByTestId("managed-command-strip-row-mine-running"),
    );

    expect(findOpenArtifactInTab(TAB_ID, "mine-running")).not.toBeNull();
  });

  it("reads like a harness row: kind glyph, elapsed time and its own stop", () => {
    const stub = renderStrip();
    act(() => {
      stub.emit().onSnapshot([
        command({
          id: "mine-running",
          kind: "shell",
          status: {
            state: "running",
            pid: 4410,
            startedAtMs: Date.now() - 65_000,
          },
        }),
      ]);
    });

    const row = screen.getByTestId("managed-command-strip-row-mine-running");
    expect(row.querySelector("[data-kind-icon='shell']")).not.toBeNull();
    // Same clock format the harness rows use, so two rows side by side read
    // as one list rather than two conventions.
    expect(row.textContent).toContain("1m 5s");

    // "Stop all" never touches these, so the row has to carry its own.
    fireEvent.click(screen.getByTestId("managed-command-stop-mine-running"));
    expect(stopMutate).toHaveBeenCalledWith({
      hostId: "host-1",
      epicId: EPIC_ID,
      commandId: "mine-running",
    });
  });

  it("offers stop and nothing destructive: this is a status, not the object", () => {
    const stub = renderStrip();
    act(() => {
      stub.emit().onSnapshot([command({ id: "mine-running" })]);
    });

    expect(
      screen.getByTestId("managed-command-stop-mine-running"),
    ).not.toBeNull();
    // Delete destroys the command's whole output history. It belongs to the
    // sidebar and the output window, where a command is a durable object - not
    // to a row that exists only while the process does.
    expect(
      screen.queryByTestId("managed-command-delete-mine-running"),
    ).toBeNull();
    expect(
      screen.queryByTestId("managed-command-start-mine-running"),
    ).toBeNull();
  });
});

describe("background strip honesty", () => {
  function renderPanelWithStrip(): {
    emit: () => ManagedCommandListStreamCallbacks;
    onStopAll: Mock<() => string | null>;
  } {
    const stub = installListStub();
    const onStopAll: Mock<() => string | null> = vi.fn(() => null);
    renderInChatTile(
      <>
        <ManagedCommandListStreamMount epicId={EPIC_ID} />
        <BackgroundItemsPanel
          items={[
            {
              taskId: "harness-task",
              kind: "command",
              title: "bun run compile",
              blockId: "harness-task-tool",
              parentTaskId: null,
              scheduledFor: null,
            },
          ]}
          epicId={EPIC_ID}
          chatId={CHAT_ID}
          canAct
          readOnly={false}
          pendingStopTaskIds={new Set()}
          stopAllPending={false}
          scrollRegionMaxHeightClass="max-h-96"
          separated={false}
          onItemClick={() => undefined}
          onStopItem={() => null}
          onStopAll={onStopAll}
        />
      </>,
    );
    return { emit: stub.emit, onStopAll };
  }

  it("counts managed commands separately, because Stop all cannot reach them", () => {
    const stub = renderPanelWithStrip();
    act(() => {
      stub
        .emit()
        .onSnapshot([
          command({ id: "m1", kind: "monitor" }),
          command({ id: "m2", kind: "monitor" }),
          command({ id: "s1", kind: "shell" }),
        ]);
    });

    // NOT "4 running": one press of Stop all leaves three of those four alive,
    // so folding them into one total is a promise the button does not keep.
    expect(screen.getByTestId("background-header-summary").textContent).toBe(
      "1 running · 2 monitors · 1 shell",
    );
  });

  it("keeps the plain summary when the chat has no managed commands", () => {
    const stub = renderPanelWithStrip();
    act(() => {
      stub.emit().onSnapshot([]);
    });

    expect(screen.getByTestId("background-header-summary").textContent).toBe(
      "1 running",
    );
  });

  it("declares the managed subset with its own heading inside the panel", () => {
    const stub = renderPanelWithStrip();
    act(() => {
      stub.emit().onSnapshot([command({ id: "m1" })]);
    });

    fireEvent.click(screen.getByRole("button", { name: /Background/ }));

    expect(screen.getByText("Monitors and shells")).not.toBeNull();
    expect(screen.getByText("Not stopped by Stop all")).not.toBeNull();
  });

  it("leaves managed rows running when Stop all is pressed", () => {
    const stub = renderPanelWithStrip();
    act(() => {
      stub.emit().onSnapshot([command({ id: "m1" })]);
    });

    fireEvent.click(screen.getByRole("button", { name: /Background/ }));
    fireEvent.click(screen.getByTestId("background-stop-all"));

    expect(stub.onStopAll).toHaveBeenCalledTimes(1);
    expect(stopMutate).not.toHaveBeenCalled();
    expect(screen.getByTestId("managed-command-strip-row-m1")).not.toBeNull();
  });
});
