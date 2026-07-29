import "../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  it("is a door into the command's output window", () => {
    renderInChatTile(
      <ManagedCommandBadge commandId="cmd-1" commandKind="monitor" />,
    );

    fireEvent.click(screen.getByTestId("queued-managed-command-badge"));

    expect(findOpenArtifactInTab(TAB_ID, "cmd-1")).not.toBeNull();
  });
});

describe("resume divider", () => {
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
});
