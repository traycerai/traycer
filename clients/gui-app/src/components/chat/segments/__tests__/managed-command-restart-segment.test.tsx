import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { ReactNode } from "react";
import type { ManagedCommand } from "@traycer/protocol/host/managed-command/unary-schemas";
import type {
  ToolCallManagedCommand,
  ToolCallManagedCommandRestarted,
} from "@traycer/protocol/persistence/epic/content-blocks";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";
import { EpicSessionContext } from "@/lib/registries/epic-session-registry";
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
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useToolOpenStore } from "@/stores/chats/tool-open-store";
import { ToolSegment } from "../tool-segment";

/**
 * One successful `traycer_restart_shell`, rendered as the immutable event it
 * was - never a second live card, never a mutation of the start card.
 *
 * Unlike the start card (whose status rides the chat's live set forever), this
 * card's whole point is that it does NOT: outcome is a snapshot from the
 * result that produced it, frozen at render, and the only live thing about it
 * is whether the door still has a shell to open. Both halves are proven here
 * through the real projection - reached via `ToolSegment`, since which calls
 * route to this card is itself the behaviour.
 */

vi.mock("@/lib/host/stream-runtime-context", () => ({
  useWsStreamClient: () => null,
  useStreamMethodSupport: () => "supported",
  useStreamMethodSchemaVersion: () => null,
}));

const EPIC_ID = "epic-1";
const TAB_ID = "tab-1";
const CHAT_ID = "chat-1";
const COMMAND_ID = "cmd-1";
const COMMAND_LINE = "tail -f deploy.log";

let epicHandle: OpenEpicStoreHandle;
let session: ManagedCommandChatSessionStub;

const noopStreamClientFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});

function shell(over: Partial<ManagedCommand>): ManagedCommand {
  return {
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
    ...over,
  };
}

function restartPayload(
  over: Partial<ToolCallManagedCommandRestarted>,
): ToolCallManagedCommandRestarted {
  return {
    event: "restarted",
    commandId: COMMAND_ID,
    description: "deploy watcher",
    monitoring: true,
    effectiveCommand: "tail -f deploy.log --since 1h",
    effectiveCwd: "/work/repo",
    commandChanged: true,
    cwdChanged: false,
    outcome: { state: "running", pid: 4410, startedAtMs: 10 },
    ...over,
  };
}

function tree(node: ReactNode): ReactNode {
  return (
    <ChatTranscriptProvider value={{ chatId: CHAT_ID, hostId: "host-1" }}>
      <EpicSessionContext.Provider value={epicHandle}>
        <TabHostProvider hostId="host-1">
          <TooltipProvider>{node}</TooltipProvider>
        </TabHostProvider>
      </EpicSessionContext.Provider>
    </ChatTranscriptProvider>
  );
}

function renderCall(input: {
  readonly variant: "card" | "row";
  readonly managedCommand: ToolCallManagedCommand | null;
  readonly id: string;
  readonly headerFindUnitId: string | null;
}) {
  return render(
    tree(
      <ToolSegment
        id={input.id}
        toolName="mcp__traycer_a2a__traycer_restart_shell"
        inputSummary={null}
        inputDetail={null}
        error={null}
        agentMessageSend={null}
        managedCommand={input.managedCommand}
        isStreaming={false}
        endState={null}
        stopped={false}
        progress={null}
        backgroundOutput={null}
        backgroundTask={false}
        startedAt={10}
        durationMs={null}
        imageResults={[]}
        variant={input.variant}
        headerFindUnitId={input.headerFindUnitId}
      />,
    ),
  );
}

beforeEach(() => {
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
  session = installManagedCommandChatSession({
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    hostId: "host-1",
  });
});

afterEach(() => {
  cleanup();
  epicHandle.dispose();
  disposeManagedCommandChatSessions();
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useToolOpenStore.getState().reset("default");
});

describe("the restart shell card", () => {
  it("titles a watching shell's restart Monitor and reports no change", () => {
    renderCall({
      variant: "card",
      managedCommand: restartPayload({
        monitoring: true,
        description: "deploy watcher",
        commandChanged: false,
        cwdChanged: false,
      }),
      id: "tool-1",
      headerFindUnitId: null,
    });

    expect(screen.getByText("Restarted Monitor · deploy watcher")).toBeTruthy();
    expect(
      screen.getByTestId(`managed-command-restart-delta-${COMMAND_ID}`)
        .textContent,
    ).toBe("same command and cwd");
  });

  it("reports 'command changed' when only the command differs from the prior spec", () => {
    renderCall({
      variant: "card",
      managedCommand: restartPayload({
        commandChanged: true,
        cwdChanged: false,
      }),
      id: "tool-1",
      headerFindUnitId: null,
    });

    expect(
      screen.getByTestId(`managed-command-restart-delta-${COMMAND_ID}`)
        .textContent,
    ).toBe("command changed");
  });

  it("reports 'cwd changed' when only the directory differs from the prior spec", () => {
    renderCall({
      variant: "card",
      managedCommand: restartPayload({
        commandChanged: false,
        cwdChanged: true,
      }),
      id: "tool-1",
      headerFindUnitId: null,
    });

    expect(
      screen.getByTestId(`managed-command-restart-delta-${COMMAND_ID}`)
        .textContent,
    ).toBe("cwd changed");
  });

  it("titles a quiet shell's restart Shell and reports both changed", () => {
    renderCall({
      variant: "card",
      managedCommand: restartPayload({
        monitoring: false,
        description: "db migration",
        commandChanged: true,
        cwdChanged: true,
      }),
      id: "tool-1",
      headerFindUnitId: null,
    });

    expect(screen.getByText("Restarted Shell · db migration")).toBeTruthy();
    expect(
      screen.getByTestId(`managed-command-restart-delta-${COMMAND_ID}`)
        .textContent,
    ).toBe("command and cwd changed");
  });

  it("shows no outcome for a restart that came up running, and never follows a later live status change", () => {
    renderCall({
      variant: "card",
      managedCommand: restartPayload({
        outcome: { state: "running", pid: 4410, startedAtMs: 10 },
      }),
      id: "tool-1",
      headerFindUnitId: null,
    });

    // Coming up running is the normal case and says nothing - and a frozen
    // "● Running" would read as a live claim beside the start card's real one.
    expect(
      screen.queryByTestId(`managed-command-restart-outcome-${COMMAND_ID}`),
    ).toBeNull();
    expect(screen.queryByText("Running")).toBeNull();

    // The start card would follow this into the SAME shell's live record;
    // this card is history and must not grow a status now either.
    act(() => {
      session.setCommands([
        shell({
          status: {
            state: "exited",
            exitCode: 1,
            signal: null,
            exitedAtMs: 90,
          },
        }),
      ]);
    });

    expect(
      screen.queryByTestId(`managed-command-restart-outcome-${COMMAND_ID}`),
    ).toBeNull();
    expect(screen.queryByText(/Exited/)).toBeNull();
    // No live cluster at all on this card - no pulse, no ticking elapsed.
    expect(screen.queryByLabelText("Shell running")).toBeNull();
    expect(screen.queryByText(/^\d+s$/)).toBeNull();
  });

  it("reads a spawn failure (exited, no code, no signal) as 'Failed to start', never destructive", () => {
    const { container } = renderCall({
      variant: "card",
      managedCommand: restartPayload({
        outcome: {
          state: "exited",
          exitCode: null,
          signal: null,
          exitedAtMs: 20,
        },
      }),
      id: "tool-1",
      headerFindUnitId: "restart-spawn-failure",
    });

    // The one outcome worth a word: nothing ran, so not "Exited".
    expect(
      screen.getByTestId(`managed-command-restart-outcome-${COMMAND_ID}`)
        .textContent,
    ).toBe("Failed to start");
    // A spawn failure is routine for a shell the agent restarted on purpose -
    // the red status DOT beside the label is the whole signal, per the start
    // card's own demotion decision (checked above via textContent). The
    // CARD's own tone is a separate thing and never switches to destructive
    // the way the generic tool row would for a real error.
    const trigger = container.querySelector(
      '[data-chat-find-unit="restart-spawn-failure"]',
    );
    if (trigger === null) {
      throw new Error("Expected the card's header trigger");
    }
    const card = trigger.closest(".rounded-md.border");
    if (card === null) {
      throw new Error("Expected the card's bordered container");
    }
    expect(card.className).not.toContain("destructive");
  });

  it("keeps the door open before the owning chat's set has arrived", () => {
    // Pre-hydration: a session is installed (beforeEach) but its stream is
    // still "connecting" and has sent no commands. Absence proves nothing
    // until the owning stream is open, so the door must stay a live button.
    renderCall({
      variant: "card",
      managedCommand: restartPayload({}),
      id: "tool-1",
      headerFindUnitId: null,
    });

    const door = screen.getByTestId(
      `managed-command-restart-door-${COMMAND_ID}`,
    );
    expect(door).toBe(screen.getByRole("button", { name: "Open in tab" }));
    expect(door.getAttribute("aria-disabled")).toBeNull();

    fireEvent.focus(door);
    expect(screen.queryByText("This shell was deleted")).toBeNull();
  });

  it("keeps its title and delta after the shell is deleted, disables the door, and still expands", () => {
    const restart = restartPayload({});
    const { container } = renderCall({
      variant: "card",
      managedCommand: restart,
      id: "tool-1",
      headerFindUnitId: "restart-deleted",
    });
    act(() => {
      // Only the owning stream saying OPEN makes the absence below
      // authoritative - a still-connecting stream would leave the door open.
      session.setConnectionStatus("open");
      session.setCommands([]);
    });

    expect(screen.getByText("Restarted Monitor · deploy watcher")).toBeTruthy();
    expect(
      screen.getByTestId(`managed-command-restart-delta-${COMMAND_ID}`)
        .textContent,
    ).toBe("command changed");
    // A restart that came up running shows no outcome - deleted or not.
    expect(
      screen.queryByTestId(`managed-command-restart-outcome-${COMMAND_ID}`),
    ).toBeNull();

    const door = screen.getByTestId(
      `managed-command-restart-door-${COMMAND_ID}`,
    );
    expect(door.getAttribute("aria-disabled")).toBe("true");
    // Focus, not hover: Radix honours it immediately, where pointer-enter
    // sits behind the provider's open delay (see tooltip-hit-testing.test.tsx).
    fireEvent.focus(door);
    expect(screen.getByRole("tooltip").textContent).toBe(
      "This shell was deleted",
    );

    const trigger = container.querySelector(
      '[data-chat-find-unit="restart-deleted"]',
    );
    if (trigger === null) {
      throw new Error("Expected the card's header trigger");
    }
    fireEvent.click(trigger);

    // The effective command is persisted with the block, deleted shell or not.
    expect(screen.getByText(restart.effectiveCommand)).toBeTruthy();
  });

  it("stays a generic tool row when the call carries no correlation payload", () => {
    // Legacy/uncorrelated: an older host, or a call the host never stamped.
    // The tool name alone must not conjure a restart card with a dead door.
    renderCall({
      variant: "card",
      managedCommand: null,
      id: "tool-1",
      headerFindUnitId: null,
    });

    expect(
      screen.getByText("mcp__traycer_a2a__traycer_restart_shell"),
    ).toBeTruthy();
    expect(screen.queryByText(/^Restarted /)).toBeNull();
    expect(
      screen.queryByTestId(`managed-command-restart-outcome-${COMMAND_ID}`),
    ).toBeNull();
    expect(
      screen.queryByTestId(`managed-command-restart-door-${COMMAND_ID}`),
    ).toBeNull();
  });

  it("reads only the payload: the call's own inputSummary/inputDetail never leak into the card", () => {
    // ToolSegment does not even forward inputSummary/inputDetail to the
    // restart card - this proves the observable consequence of that, the way
    // a caller of the card actually would.
    const restart = restartPayload({});
    const { container } = render(
      tree(
        <ToolSegment
          id="tool-1"
          toolName="mcp__traycer_a2a__traycer_restart_shell"
          inputSummary="raw-call-summary-should-not-render"
          inputDetail={{
            kind: "command",
            command: "raw-call-command-should-not-render",
          }}
          error={null}
          agentMessageSend={null}
          managedCommand={restart}
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
          headerFindUnitId="restart-only-payload"
        />,
      ),
    );

    const trigger = container.querySelector(
      '[data-chat-find-unit="restart-only-payload"]',
    );
    if (trigger === null) {
      throw new Error("Expected the card's header trigger");
    }
    fireEvent.click(trigger);

    expect(screen.queryByText("raw-call-summary-should-not-render")).toBeNull();
    expect(screen.queryByText("raw-call-command-should-not-render")).toBeNull();
    expect(screen.getByText(restart.effectiveCommand)).toBeTruthy();
  });

  it("renders a start card followed by two restarts as an ordered history, each independently expandable", () => {
    const restart1 = restartPayload({
      effectiveCommand: "tail -f deploy.log --v2",
      commandChanged: true,
      cwdChanged: false,
    });
    const restart2 = restartPayload({
      effectiveCommand: "tail -f deploy.log --v3",
      commandChanged: true,
      cwdChanged: false,
    });

    const { container } = render(
      tree(
        <>
          <ToolSegment
            id="start-1"
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
            headerFindUnitId="find-start"
          />
          <ToolSegment
            id="restart-1"
            toolName="mcp__traycer_a2a__traycer_restart_shell"
            inputSummary={null}
            inputDetail={null}
            error={null}
            agentMessageSend={null}
            managedCommand={restart1}
            isStreaming={false}
            endState={null}
            stopped={false}
            progress={null}
            backgroundOutput={null}
            backgroundTask={false}
            startedAt={20}
            durationMs={null}
            imageResults={[]}
            variant="card"
            headerFindUnitId="find-restart-1"
          />
          <ToolSegment
            id="restart-2"
            toolName="mcp__traycer_a2a__traycer_restart_shell"
            inputSummary={null}
            inputDetail={null}
            error={null}
            agentMessageSend={null}
            managedCommand={restart2}
            isStreaming={false}
            endState={null}
            stopped={false}
            progress={null}
            backgroundOutput={null}
            backgroundTask={false}
            startedAt={30}
            durationMs={null}
            imageResults={[]}
            variant="card"
            headerFindUnitId="find-restart-2"
          />
        </>,
      ),
    );

    const findUnits = Array.from(
      container.querySelectorAll("[data-chat-find-unit]"),
    ).map((element) => element.getAttribute("data-chat-find-unit"));
    expect(findUnits).toEqual([
      "find-start",
      "find-restart-1",
      "find-restart-2",
    ]);

    const trigger1 = container.querySelector(
      '[data-chat-find-unit="find-restart-1"]',
    );
    if (trigger1 === null) throw new Error("Expected restart-1's trigger");
    fireEvent.click(trigger1);

    // Its own command shows; the sibling restart's body stays closed - each
    // card's open state is scoped by its own block id.
    expect(screen.getByText(restart1.effectiveCommand)).toBeTruthy();
    expect(screen.queryByText(restart2.effectiveCommand)).toBeNull();

    const trigger2 = container.querySelector(
      '[data-chat-find-unit="find-restart-2"]',
    );
    if (trigger2 === null) throw new Error("Expected restart-2's trigger");
    fireEvent.click(trigger2);

    // Opening the second does not close the first.
    expect(screen.getByText(restart1.effectiveCommand)).toBeTruthy();
    expect(screen.getByText(restart2.effectiveCommand)).toBeTruthy();
  });

  it("expands to a copyable command panel and the effective cwd line", () => {
    const restart = restartPayload({});
    const { container } = renderCall({
      variant: "card",
      managedCommand: restart,
      id: "tool-1",
      headerFindUnitId: "restart-body",
    });

    const trigger = container.querySelector(
      '[data-chat-find-unit="restart-body"]',
    );
    if (trigger === null) {
      throw new Error("Expected the card's header trigger");
    }
    fireEvent.click(trigger);

    expect(screen.getByText("Command")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy command" })).toBeTruthy();
    expect(screen.getByText(restart.effectiveCommand)).toBeTruthy();
    // The directory is deliberately NOT on the card: the delta phrase says
    // "cwd changed" when that is what happened, and the output window's
    // details popover carries the effective cwd.
    expect(screen.queryByText(restart.effectiveCwd)).toBeNull();
    expect(screen.queryByText(/^in /)).toBeNull();
  });

  it("renders the header and door in the row variant too", () => {
    renderCall({
      variant: "row",
      managedCommand: restartPayload({}),
      id: "tool-1",
      headerFindUnitId: null,
    });

    expect(screen.getByText("Restarted Monitor · deploy watcher")).toBeTruthy();
    expect(
      screen.getByTestId(`managed-command-restart-door-${COMMAND_ID}`),
    ).toBeTruthy();
  });

  it("claims no deletion and renders no door outside an epic session", () => {
    // Absence only proves the shell is gone if we actually searched. Rendered
    // outside an epic session there is nowhere to search, so the card must
    // not claim a deletion it cannot see - and the door itself renders
    // nothing rather than a button that would open nothing.
    render(
      <TooltipProvider>
        <ToolSegment
          id="tool-1"
          toolName="mcp__traycer_a2a__traycer_restart_shell"
          inputSummary={null}
          inputDetail={null}
          error={null}
          agentMessageSend={null}
          managedCommand={restartPayload({})}
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
      </TooltipProvider>,
    );

    expect(screen.getByText("Restarted Monitor · deploy watcher")).toBeTruthy();
    expect(
      screen.queryByTestId(`managed-command-restart-door-${COMMAND_ID}`),
    ).toBeNull();
  });
});
