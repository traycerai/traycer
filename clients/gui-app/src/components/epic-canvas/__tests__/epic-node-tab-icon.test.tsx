import "../../../../__tests__/test-browser-apis";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { EpicNodeTabIcon } from "@/components/epic-canvas/epic-node-tab-icon";
import { NotificationIndicatorsProvider } from "@/components/notifications/notification-indicators-provider";
import {
  __resetAppLocalNotificationsStoreForTests,
  emitTerminalCrashedNotification,
  useAppLocalNotificationsStore,
} from "@/stores/notifications/app-local-notifications-store";
import type { EpicTerminalRef } from "@/stores/epics/canvas/types";

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
