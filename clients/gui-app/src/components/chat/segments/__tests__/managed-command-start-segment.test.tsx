import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import type { ManagedCommand } from "@traycer/protocol/host/managed-command/unary-schemas";
import { TooltipProvider } from "@/components/ui/tooltip";
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
import { ToolSegment } from "../tool-segment";

/**
 * The `traycer_run_shell` call as a shell rather than a wrench row.
 *
 * The point of the correlation payload is that ONE card tracks the shell for
 * as long as it exists: status arrives live off the chat's set, and the card
 * still says something honest after the record dies. Both halves are proven
 * here through the real projection - the segment is reached via `ToolSegment`,
 * because which calls route to this card is itself the behaviour.
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

function tree(node: ReactNode): ReactNode {
  return (
    <EpicSessionContext.Provider value={epicHandle}>
      <TabHostProvider hostId="host-1">
        <TooltipProvider>{node}</TooltipProvider>
      </TabHostProvider>
    </EpicSessionContext.Provider>
  );
}

function renderCall(input: {
  readonly variant: "card" | "row";
  readonly correlated: boolean;
}): void {
  render(
    tree(
      <ToolSegment
        id="tool-1"
        toolName="mcp__traycer_a2a__traycer_run_shell"
        inputSummary={COMMAND_LINE}
        inputDetail={{ kind: "command", command: COMMAND_LINE }}
        error={null}
        agentMessageSend={null}
        managedCommand={
          input.correlated
            ? {
                commandId: COMMAND_ID,
                description: "deploy watcher",
                monitoring: true,
              }
            : null
        }
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
        headerFindUnitId={null}
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
});

describe("the run_shell start card", () => {
  it("names the shell and reads its status live, updating the SAME card in place", () => {
    renderCall({ variant: "card", correlated: true });
    act(() => {
      session.setCommands([shell({})]);
    });

    expect(screen.getByText("Monitor · deploy watcher")).toBeTruthy();
    expect(screen.getByText("Running")).toBeTruthy();

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

    // One card, later. Not a second entry in the feed.
    expect(screen.getByText("Exited · code 1")).toBeTruthy();
    expect(screen.queryByText("Running")).toBeNull();
    expect(screen.getAllByText("Monitor · deploy watcher")).toHaveLength(1);
  });

  it("follows a rename and a monitor flip, because the record is the source", () => {
    renderCall({ variant: "card", correlated: true });
    act(() => {
      session.setCommands([
        shell({ monitoring: false, description: "db migration" }),
      ]);
    });

    expect(screen.getByText("Shell · db migration")).toBeTruthy();
  });

  it("keeps the command the CALL asked for, not the shell's current spec", () => {
    // A restart can re-spec a shell. This card is the record of one call, so
    // its command body is frozen; the output window's details popover is where
    // the effective spec is reported.
    renderCall({ variant: "card", correlated: true });
    act(() => {
      session.setCommands([
        shell({ command: "tail -f deploy.log --since 1h" }),
      ]);
    });

    expect(screen.queryByText(/--since 1h/)).toBeNull();
  });

  it("keeps its identity and disables the door once the shell is deleted", () => {
    renderCall({ variant: "card", correlated: true });
    act(() => {
      session.setCommands([shell({})]);
    });
    expect(screen.getByText("Running")).toBeTruthy();

    act(() => {
      session.setCommands([]);
    });

    // Persisted identity survives the record...
    expect(screen.getByText("Monitor · deploy watcher")).toBeTruthy();
    // ...and the status segment goes entirely: a frozen "Running" would be the
    // card claiming to know something it does not.
    expect(screen.queryByText("Running")).toBeNull();
    // Deleting a shell destroys its log, so the tab would open onto a banner.
    const door = screen.getByTestId(`managed-command-start-door-${COMMAND_ID}`);
    expect(door.getAttribute("aria-disabled")).toBe("true");
  });

  it("stays a generic tool row when the host never correlated the call", () => {
    // An older host stamps no payload, so there is no shell to point at. The
    // tool name alone must not conjure a card with a dead door.
    renderCall({ variant: "card", correlated: false });
    act(() => {
      session.setCommands([shell({})]);
    });

    expect(screen.queryByText("Monitor · deploy watcher")).toBeNull();
    expect(
      screen.queryByTestId(`managed-command-start-door-${COMMAND_ID}`),
    ).toBeNull();
  });

  it("claims no deletion when there is no epic session to have looked in", () => {
    // Absence only proves the shell is gone if we actually searched. Rendered
    // outside an epic session there is nowhere to search, so the card must not
    // put up "This shell was deleted" over a shell that may be perfectly alive.
    render(
      <TooltipProvider>
        <ToolSegment
          id="tool-1"
          toolName="mcp__traycer_a2a__traycer_run_shell"
          inputSummary={COMMAND_LINE}
          inputDetail={{ kind: "command", command: COMMAND_LINE }}
          error={null}
          agentMessageSend={null}
          managedCommand={{
            commandId: COMMAND_ID,
            description: "deploy watcher",
            monitoring: true,
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
      </TooltipProvider>,
    );

    expect(screen.getByText("Monitor · deploy watcher")).toBeTruthy();
    const door = screen.queryByTestId(
      `managed-command-start-door-${COMMAND_ID}`,
    );
    expect(door?.getAttribute("aria-disabled") ?? null).toBeNull();
  });

  it("renders as a row inside an activity group too", () => {
    renderCall({ variant: "row", correlated: true });
    act(() => {
      session.setCommands([shell({})]);
    });

    expect(screen.getByText("Monitor · deploy watcher")).toBeTruthy();
    expect(screen.getByText("Running")).toBeTruthy();
  });
});
