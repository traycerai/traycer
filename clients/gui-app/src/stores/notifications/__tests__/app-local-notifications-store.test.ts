import "../../../../__tests__/test-browser-apis";
import { beforeEach, describe, expect, it } from "vitest";
import { appLocalNotificationsKey } from "@/lib/persist";
import {
  APP_LOCAL_NOTIFICATIONS_ROW_CAP,
  __resetAppLocalNotificationsStoreForTests,
  createAppLocalNotificationsStore,
  emitTerminalClosedNotification,
  emitTerminalCrashedNotification,
  type AppLocalNotificationEntry,
  useAppLocalNotificationsStore,
} from "@/stores/notifications/app-local-notifications-store";

function entry(
  id: string,
  updatedAt: number,
  readAt: number | null,
): AppLocalNotificationEntry {
  return {
    id,
    updatedAt,
    readAt,
    kind: "worktree.setup.failed",
    sourceRef: id,
    payload: { kind: "chat", epicId: "epic-1", chatId: "chat-1" },
    message: `Message ${id}`,
    detail: null,
  };
}

describe("app-local notifications store", () => {
  beforeEach(() => {
    window.localStorage.clear();
    __resetAppLocalNotificationsStoreForTests();
  });

  it("persists entries across store re-create", () => {
    const key = appLocalNotificationsKey("user-a");
    const first = createAppLocalNotificationsStore(key);

    first.getState().activateIdentity("user-a");
    first.getState().upsert(entry("persisted", 10, null));

    const second = createAppLocalNotificationsStore(key);
    second.getState().activateIdentity("user-a");

    expect(second.getState().orderedIds).toEqual(["persisted"]);
    expect(second.getState().byId.persisted.message).toBe("Message persisted");
    expect(second.getState().unreadCount).toBe(1);
  });

  it("does not write entries before an identity is active", () => {
    const store = createAppLocalNotificationsStore(
      appLocalNotificationsKey("user-a"),
    );

    store.getState().upsert(entry("ignored", 10, null));

    expect(store.getState().orderedIds).toEqual([]);
    expect(
      window.localStorage.getItem(appLocalNotificationsKey("user-a")),
    ).toBe(null);
  });

  it("keeps the newest rows under the row cap", () => {
    const store = createAppLocalNotificationsStore(
      appLocalNotificationsKey("user-a"),
    );
    store.getState().activateIdentity("user-a");

    for (let index = 0; index < APP_LOCAL_NOTIFICATIONS_ROW_CAP + 5; index++) {
      store.getState().upsert(entry(`entry-${index}`, index, null));
    }

    expect(store.getState().orderedIds).toHaveLength(
      APP_LOCAL_NOTIFICATIONS_ROW_CAP,
    );
    expect(store.getState().byId["entry-0"]).toBeUndefined();
    expect(store.getState().orderedIds[0]).toBe(
      `entry-${APP_LOCAL_NOTIFICATIONS_ROW_CAP + 4}`,
    );
    expect(store.getState().unreadCount).toBe(APP_LOCAL_NOTIFICATIONS_ROW_CAP);
  });

  it("owns app-local read state", () => {
    const store = createAppLocalNotificationsStore(
      appLocalNotificationsKey("user-a"),
    );
    store.getState().activateIdentity("user-a");
    store.getState().upsert(entry("target", 10, null));

    store.getState().markAsRead("target", 20);

    expect(store.getState().byId.target.readAt).toBe(20);
    expect(store.getState().unreadCount).toBe(0);
  });

  it("consumes only app-local rows in the viewed entity", () => {
    const store = createAppLocalNotificationsStore(
      appLocalNotificationsKey("user-a"),
    );
    store.getState().activateIdentity("user-a");
    store.getState().upsert(entry("match", 10, null));
    store.getState().upsert({
      ...entry("other", 11, null),
      payload: { kind: "chat", epicId: "epic-1", chatId: "chat-2" },
    });

    store
      .getState()
      .markEntityAsRead({ epicId: "epic-1", chatId: "chat-1" }, 20);

    expect(store.getState().byId.match.readAt).toBe(20);
    expect(store.getState().byId.other.readAt).toBeNull();
  });

  it("consumes only epic-level rows for an epic-only presence", () => {
    const store = createAppLocalNotificationsStore(
      appLocalNotificationsKey("user-a"),
    );
    store.getState().activateIdentity("user-a");
    store.getState().upsert({
      ...entry("epic", 10, null),
      payload: { kind: "epic", epicId: "epic-1" },
    });
    store.getState().upsert(entry("chat", 11, null));

    store.getState().markEntityAsRead({ epicId: "epic-1" }, 20);

    expect(store.getState().byId.epic.readAt).toBe(20);
    expect(store.getState().byId.chat.readAt).toBeNull();
  });

  it("does not resurface an existing client-error row when the producer repeats", () => {
    const store = createAppLocalNotificationsStore(
      appLocalNotificationsKey("user-a"),
    );
    store.getState().activateIdentity("user-a");
    store.getState().upsert(entry("older", 5, null));
    store.getState().upsert(entry("target", 10, null));
    store.getState().markAsRead("target", 20);

    store.getState().upsert(entry("target", 30, null));

    expect(store.getState().orderedIds).toEqual(["target", "older"]);
    expect(store.getState().byId.target.updatedAt).toBe(10);
    expect(store.getState().byId.target.readAt).toBe(20);
    expect(store.getState().unreadCount).toBe(1);
  });

  it("addresses terminal closed entries to their exact canvas tile", () => {
    useAppLocalNotificationsStore.getState().activateIdentity("user-a");

    emitTerminalClosedNotification({
      instanceId: "terminal-instance",
      hostLabel: "MacBook",
      target: {
        kind: "terminal",
        epicId: "epic-1",
        terminalId: "terminal-tile-1",
        tabId: "view-tab-1",
        paneId: "pane-1",
        tileInstanceId: "terminal-instance",
      },
    });

    expect(
      useAppLocalNotificationsStore.getState().byId[
        "terminal.closed:terminal-instance"
      ].payload,
    ).toEqual({
      kind: "terminal",
      epicId: "epic-1",
      terminalId: "terminal-tile-1",
      tabId: "view-tab-1",
      paneId: "pane-1",
      tileInstanceId: "terminal-instance",
    });
  });

  it("refreshes a terminal-closed entry's target after the terminal moves", () => {
    useAppLocalNotificationsStore.getState().activateIdentity("user-a");

    emitTerminalClosedNotification({
      instanceId: "terminal-instance",
      hostLabel: "MacBook",
      target: {
        kind: "terminal",
        epicId: "epic-1",
        terminalId: "terminal-tile-1",
        tabId: "view-tab-1",
        paneId: "pane-1",
        tileInstanceId: "terminal-instance",
      },
    });
    useAppLocalNotificationsStore
      .getState()
      .markAsRead("terminal.closed:terminal-instance", 123);

    emitTerminalClosedNotification({
      instanceId: "terminal-instance",
      hostLabel: "MacBook",
      target: {
        kind: "terminal",
        epicId: "epic-1",
        terminalId: "terminal-tile-1",
        tabId: "view-tab-2",
        paneId: "pane-2",
        tileInstanceId: "terminal-instance",
      },
    });

    expect(
      useAppLocalNotificationsStore.getState().byId[
        "terminal.closed:terminal-instance"
      ],
    ).toMatchObject({
      readAt: 123,
      payload: {
        kind: "terminal",
        tabId: "view-tab-2",
        paneId: "pane-2",
      },
    });
  });

  it("keeps successive terminal deaths as distinct entity-addressable rows", () => {
    useAppLocalNotificationsStore.getState().activateIdentity("user-a");

    emitTerminalCrashedNotification({
      instanceId: "terminal-instance",
      target: {
        kind: "terminal",
        epicId: "epic-1",
        terminalId: "terminal-tile-1",
        tabId: "view-tab-1",
        paneId: "pane-1",
        tileInstanceId: "terminal-instance",
      },
      cause: "exit",
    });
    emitTerminalCrashedNotification({
      instanceId: "terminal-instance",
      target: {
        kind: "terminal",
        epicId: "epic-1",
        terminalId: "terminal-tile-1",
        tabId: "view-tab-1",
        paneId: "pane-1",
        tileInstanceId: "terminal-instance",
      },
      cause: "recovery-exhausted",
    });

    const entries = Object.values(
      useAppLocalNotificationsStore.getState().byId,
    );
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.kind)).toEqual([
      "terminal.crashed",
      "terminal.crashed",
    ]);
    expect(entries.map((entry) => entry.payload)).toEqual([
      {
        kind: "terminal",
        epicId: "epic-1",
        terminalId: "terminal-tile-1",
        tabId: "view-tab-1",
        paneId: "pane-1",
        tileInstanceId: "terminal-instance",
      },
      {
        kind: "terminal",
        epicId: "epic-1",
        terminalId: "terminal-tile-1",
        tabId: "view-tab-1",
        paneId: "pane-1",
        tileInstanceId: "terminal-instance",
      },
    ]);
  });
});
