import "../../../../__tests__/test-browser-apis";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_WORKING_AWARENESS_FIELD } from "@traycer/protocol/host/epic/subscribe";
import { EpicNodeTabIcon } from "@/components/epic-canvas/epic-node-tab-icon";
import { NotificationIndicatorsProvider } from "@/components/notifications/notification-indicators-provider";
import { __getOpenEpicRegistryForTests } from "@/lib/registries/epic-session-registry";
import {
  createOpenEpicStore,
  type EpicStreamClientFactory,
  type OpenEpicStoreHandle,
} from "@/stores/epics/open-epic/store";
import {
  __resetAppLocalNotificationsStoreForTests,
  emitTerminalCrashedNotification,
  useAppLocalNotificationsStore,
} from "@/stores/notifications/app-local-notifications-store";
import type {
  EpicArtifactRef,
  EpicTerminalRef,
} from "@/stores/epics/canvas/types";

const TERMINAL_NODE: EpicTerminalRef = {
  id: "terminal-1",
  instanceId: "terminal-instance-1",
  type: "terminal",
  name: "Shell",
  titleSource: "default",
  hostId: "host-1",
  cwd: "/repo",
};

describe("<EpicNodeTabIcon /> terminal indicator", () => {
  afterEach(() => {
    cleanup();
    __resetAppLocalNotificationsStoreForTests();
  });

  it("shows and clears the app-local crash dot for the exact terminal tile", () => {
    useAppLocalNotificationsStore.getState().activateIdentity("user-1");
    emitTerminalCrashedNotification({
      instanceId: TERMINAL_NODE.instanceId,
      target: {
        kind: "terminal",
        epicId: "epic-1",
        terminalId: TERMINAL_NODE.id,
        tabId: "view-tab-1",
        paneId: "pane-1",
        tileInstanceId: TERMINAL_NODE.instanceId,
      },
      cause: "exit",
    });

    renderTerminalTabIcon();

    const indicator = screen.getByRole("status", {
      name: "Task needs attention",
    });
    expect(indicator.firstElementChild?.className).toContain(
      "text-destructive",
    );
    expect(indicator.textContent).toBe("⠿");

    act(() => {
      useAppLocalNotificationsStore
        .getState()
        .markEntityAsRead(
          { epicId: "epic-1", chatId: TERMINAL_NODE.id },
          Date.now(),
        );
    });

    expect(
      screen.queryByRole("status", { name: "Task needs attention" }),
    ).toBeNull();
  });
});

function renderTerminalTabIcon(): void {
  render(
    <NotificationIndicatorsProvider indicators={{ epics: {}, chats: {} }}>
      <EpicNodeTabIcon
        node={TERMINAL_NODE}
        epicId="epic-1"
        variant="live"
        className="size-3.5 shrink-0"
        defaultIcon={undefined}
      />
    </NotificationIndicatorsProvider>,
  );
}

const TUI_AGENT_NODE: EpicArtifactRef = {
  id: "agent-1",
  instanceId: "agent-instance-1",
  type: "terminal-agent",
  name: "Plan Critic",
  hostId: "host-1",
};

const SPINNER_LABEL = "Agent in progress";

describe("<EpicNodeTabIcon /> terminal-agent activity", () => {
  afterEach(() => {
    cleanup();
    __getOpenEpicRegistryForTests().disposeAll();
    __resetAppLocalNotificationsStoreForTests();
  });

  // Regression: the TUI-agent tab used to hardcode `running={false}`, so a
  // working agent spun in the sidebar but never in its own tab.
  it("swaps the idle icon for the spinner while the agent is working", () => {
    const handle = registerEpicSession("epic-1");

    renderTuiAgentTabIcon();

    expect(screen.queryByRole("status", { name: SPINNER_LABEL })).toBeNull();

    act(() => {
      handle.awareness.setLocalState({
        [AGENT_WORKING_AWARENESS_FIELD]: [TUI_AGENT_NODE.id],
      });
    });

    expect(screen.getByRole("status", { name: SPINNER_LABEL })).toBeTruthy();

    act(() => {
      handle.awareness.setLocalState({
        [AGENT_WORKING_AWARENESS_FIELD]: [],
      });
    });

    expect(screen.queryByRole("status", { name: SPINNER_LABEL })).toBeNull();
  });

  // The shared icon renders outside an open-epic session too (drag previews,
  // mount-lifecycle tests); an unregistered Epic must read as idle, not throw.
  it("renders the idle icon with no registered Epic session", () => {
    renderTuiAgentTabIcon();

    expect(screen.queryByRole("status", { name: SPINNER_LABEL })).toBeNull();
  });
});

function registerEpicSession(epicId: string): OpenEpicStoreHandle {
  return __getOpenEpicRegistryForTests().acquire(epicId, () =>
    createOpenEpicStore({
      epicId,
      userId: null,
      streamClientFactory: fakeStreamClientFactory,
      onAuthError: null,
    }),
  );
}

function renderTuiAgentTabIcon(): void {
  render(
    <NotificationIndicatorsProvider indicators={{ epics: {}, chats: {} }}>
      <EpicNodeTabIcon
        node={TUI_AGENT_NODE}
        epicId="epic-1"
        variant="live"
        className="size-3.5 shrink-0"
        defaultIcon={undefined}
      />
    </NotificationIndicatorsProvider>,
  );
}

const fakeStreamClientFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});
