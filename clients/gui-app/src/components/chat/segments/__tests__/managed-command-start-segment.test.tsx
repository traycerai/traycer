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

/**
 * Every provider a card needs EXCEPT the chat transcript identity - kept
 * apart so the "owner unknown" test can render without it, the way a
 * transcript with no bound host does.
 */
function treeWithoutTranscript(node: ReactNode): ReactNode {
  return (
    <EpicSessionContext.Provider value={epicHandle}>
      <TabHostProvider hostId="host-1">
        <TooltipProvider>{node}</TooltipProvider>
      </TabHostProvider>
    </EpicSessionContext.Provider>
  );
}

function tree(node: ReactNode): ReactNode {
  return (
    <ChatTranscriptProvider value={{ chatId: CHAT_ID, hostId: "host-1" }}>
      {treeWithoutTranscript(node)}
    </ChatTranscriptProvider>
  );
}

function startCallElement(input: {
  readonly variant: "card" | "row";
  readonly correlated: boolean;
}): ReactNode {
  return (
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
              event: "started",
              commandId: COMMAND_ID,
              description: "deploy watcher",
              monitoring: true,
              cwd: "/work/repo",
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
    />
  );
}

function renderCall(input: {
  readonly variant: "card" | "row";
  readonly correlated: boolean;
}): void {
  render(tree(startCallElement(input)));
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
  // Module-level and keyed by block id, which every case here reuses: without
  // this a test that expands the body leaves the next one already open.
  useToolOpenStore.setState(useToolOpenStore.getInitialState(), true);
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

    // Expand the body and read what actually rendered, rather than merely
    // asserting the live re-spec's absence: the persisted call command has to
    // be the thing shown, not just "nothing else is".
    fireEvent.click(screen.getByText("Monitor · deploy watcher"));

    expect(screen.getByText(COMMAND_LINE)).toBeTruthy();
    expect(screen.queryByText(/--since 1h/)).toBeNull();
  });

  it("keeps its identity and disables the door once the shell is deleted", () => {
    renderCall({ variant: "card", correlated: true });
    act(() => {
      session.setConnectionStatus("open");
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
    // The disabled door still carries its reason in its own name, for a reader
    // who cannot hover a tooltip.
    const door = screen.getByRole("button", {
      name: "Open in tab - this shell was deleted",
    });
    expect(door.getAttribute("aria-disabled")).toBe("true");
  });

  it("keeps the door open before the owning chat's set has arrived", () => {
    // Pre-hydration: a session is installed (beforeEach) but its stream is
    // still "connecting" and has sent no commands. Absence proves nothing
    // until the owning stream is open, so the door must stay a live button -
    // never the aria-disabled "deleted" marker.
    renderCall({ variant: "card", correlated: true });

    const door = screen.getByRole("button", { name: "Open in tab" });
    expect(door.getAttribute("aria-disabled")).toBeNull();

    fireEvent.focus(door);
    expect(screen.queryByText("This shell was deleted")).toBeNull();
  });

  it("disables the door with the exact deletion tooltip once the owning stream confirms absence", () => {
    renderCall({ variant: "card", correlated: true });
    act(() => {
      session.setConnectionStatus("open");
      session.setCommands([]);
    });

    const door = screen.getByRole("button", {
      name: "Open in tab - this shell was deleted",
    });
    expect(door.getAttribute("aria-disabled")).toBe("true");
    // Focus, not hover: Radix honours it immediately, where pointer-enter
    // sits behind the provider's open delay (see tooltip-hit-testing.test.tsx).
    fireEvent.focus(door);
    expect(screen.getByRole("tooltip").textContent).toBe(
      "This shell was deleted",
    );
  });

  it("shows live status and keeps the door open once the owning stream confirms the shell", () => {
    renderCall({ variant: "card", correlated: true });
    act(() => {
      session.setConnectionStatus("open");
      session.setCommands([shell({})]);
    });

    expect(screen.getByText("Running")).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "Open in tab" })
        .getAttribute("aria-disabled"),
    ).toBeNull();
  });

  it("claims no deletion while the stream is open but the snapshot has not landed", () => {
    // The narrow window the connection status alone cannot see: subscribe is
    // acknowledged (status "open") and change frames can already arrive, while
    // the authoritative set is still in flight. An empty set here is the
    // session's initial value, not the host's answer.
    renderCall({ variant: "card", correlated: true });
    act(() => {
      session.setConnectionStatus("open");
      session.setCommandsWithoutSnapshot([]);
    });

    expect(
      screen
        .getByRole("button", { name: "Open in tab" })
        .getAttribute("aria-disabled"),
    ).toBeNull();

    // ...and the moment the snapshot does land without it, the verdict flips.
    act(() => {
      session.setCommands([]);
    });
    expect(
      screen
        .getByRole("button", {
          name: "Open in tab - this shell was deleted",
        })
        .getAttribute("aria-disabled"),
    ).toBe("true");
  });

  it("keeps a proven deletion disabled across a reconnect blip", () => {
    // The host has already said the shell is gone; a dropped socket does not
    // un-delete it. Re-arming the door mid-reconnect would offer a tile onto a
    // log that no longer exists.
    renderCall({ variant: "card", correlated: true });
    act(() => {
      session.setConnectionStatus("open");
      session.setCommands([]);
    });
    const deletedName = "Open in tab - this shell was deleted";
    expect(screen.getByRole("button", { name: deletedName })).toBeTruthy();

    act(() => {
      session.setConnectionStatus("reconnecting");
    });

    expect(screen.getByRole("button", { name: deletedName })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open in tab" })).toBeNull();
  });

  it("keeps the deleted door focusable and says why in its own name", () => {
    // The tooltip is the explanation, and hover is not a way everyone can ask
    // for it: the control stays in the tab order and names its own state.
    renderCall({ variant: "card", correlated: true });
    act(() => {
      session.setConnectionStatus("open");
      session.setCommands([]);
    });

    const door = screen.getByRole("button", {
      name: "Open in tab - this shell was deleted",
    });
    door.focus();
    expect(document.activeElement).toBe(door);
  });

  it("reads presence from the owning host's session, never another host's", () => {
    // A clone carries the source transcript's blocks. The source chat may be
    // warm in the same epic with the shell very much alive - but it belongs to
    // the source host, and this card is bound to the clone's. An epic-wide
    // scan would let the clone claim a shell whose output it cannot open.
    const sourceSession = installManagedCommandChatSession({
      epicId: EPIC_ID,
      chatId: "chat-source",
      hostId: "host-source",
    });
    renderCall({ variant: "card", correlated: true });
    act(() => {
      sourceSession.setConnectionStatus("open");
      sourceSession.setCommands([shell({ chatId: "chat-source" })]);
      session.setConnectionStatus("open");
      session.setCommands([]);
    });

    expect(screen.queryByText("Running")).toBeNull();
    expect(
      screen
        .getByRole("button", {
          name: "Open in tab - this shell was deleted",
        })
        .getAttribute("aria-disabled"),
    ).toBe("true");
  });

  it("claims no deletion when there is no chat transcript identity to attribute absence to", () => {
    // The stream is open and the shell is absent - but with no chat identity
    // in scope there is no OWNER for that absence to be authoritative for, so
    // the card must not claim a deletion it cannot honestly attribute.
    render(
      treeWithoutTranscript(
        startCallElement({ variant: "card", correlated: true }),
      ),
    );
    act(() => {
      session.setConnectionStatus("open");
      session.setCommands([]);
    });

    expect(
      screen
        .getByRole("button", { name: "Open in tab" })
        .getAttribute("aria-disabled"),
    ).toBeNull();
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

  it("never surfaces the call's cwd on the card, though the payload carries it", () => {
    // Product decision: the directory is a host-disk detail that reads as
    // noise on a card about what the agent ran; the output window's details
    // popover has the effective cwd. The block still stamps it so a later
    // restart card can say "cwd changed".
    renderCall({ variant: "card", correlated: true });
    act(() => {
      session.setCommands([shell({})]);
    });

    fireEvent.focus(screen.getByText("Monitor · deploy watcher"));
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(screen.queryByText(/\/work\/repo/)).toBeNull();
  });
});
