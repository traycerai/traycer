import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  appLocalNotificationCompletionReceiptKey,
  appLocalNotificationCompletionReceiptPrefix,
  appLocalNotificationsKey,
} from "@/lib/persist";
import {
  hasAppLocalCompletionReceipt,
  recordAppLocalCompletionReceipt,
} from "@/lib/notifications/app-local-completion-receipts";
import {
  hasAppLocalDisplayReceipt,
  recordAppLocalDisplayReceipt,
} from "@/lib/notifications/app-local-display-receipts";
import {
  APP_LOCAL_OBSERVED_COMPLETION_CAP_PER_HOST,
  APP_LOCAL_OBSERVED_COMPLETION_GLOBAL_CAP,
  APP_LOCAL_NOTIFICATIONS_ROW_CAP,
  __resetAppLocalNotificationsStoreForTests,
  createAppLocalNotificationsStore,
  emitTerminalClosedNotification,
  emitTerminalCrashedNotification,
  emitChatStreamErrorNotification,
  migrateAppLocalNotificationsPersistedState,
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
    originHostId: "host-a",
    updatedAt,
    readAt,
    kind: "stream.transport.error",
    sourceRef: id,
    payload: { kind: "chat", epicId: "epic-1", chatId: "chat-1" },
    message: `Message ${id}`,
    detail: null,
    displayedUpdatedAt: null,
  };
}

describe("app-local notifications store", () => {
  beforeEach(() => {
    window.localStorage.clear();
    __resetAppLocalNotificationsStoreForTests();
  });

  it("removes retired worktree setup rows during the v2 migration", () => {
    expect(
      migrateAppLocalNotificationsPersistedState({
        byId: {
          retired: {
            ...entry("retired", 10, null),
            kind: "worktree.setup.failed",
          },
          retained: entry("retained", 20, null),
        },
        orderedIds: ["retained", "retired"],
        unreadCount: 2,
      }),
    ).toEqual({
      byId: { retained: entry("retained", 20, null) },
      orderedIds: ["retained"],
      unreadCount: 1,
    });
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

  it("discards malformed completion receipts instead of trusting them", () => {
    const receipt = {
      userId: "user-a",
      originHostId: "host-a",
      occurrenceKey: "done@1",
    };
    const key = appLocalNotificationCompletionReceiptKey(receipt);
    window.localStorage.setItem(key, "{truncated");

    expect(hasAppLocalCompletionReceipt(receipt)).toBe(false);
    expect(window.localStorage.getItem(key)).toBeNull();

    window.localStorage.setItem(key, JSON.stringify({ id: 1, observedAt: 10 }));
    expect(hasAppLocalCompletionReceipt(receipt)).toBe(false);
    expect(window.localStorage.getItem(key)).toBeNull();

    recordAppLocalCompletionReceipt({
      ...receipt,
      id: "done",
      observedAt: 10,
    });
    expect(hasAppLocalCompletionReceipt(receipt)).toBe(true);
  });

  it("persists display receipts independently from read state", () => {
    const key = appLocalNotificationsKey("user-a");
    const first = createAppLocalNotificationsStore(key);
    first.getState().activateIdentity("user-a");
    first.getState().upsert(entry("displayed", 10, null));

    first.getState().markAsDisplayed("displayed", 10);

    const second = createAppLocalNotificationsStore(key);
    expect(second.getState().byId.displayed.readAt).toBeNull();
    expect(second.getState().byId.displayed.displayedUpdatedAt).toBe(10);
  });

  it("keeps a newer row and its local display state when a stale foreground relay arrives", () => {
    const store = createAppLocalNotificationsStore(
      appLocalNotificationsKey("user-a"),
    );
    store.getState().activateIdentity("user-a");
    store.getState().upsert(entry("target", 20, null));
    store.getState().markAsRead("target", 30);
    store.getState().markAsDisplayed("target", 20);

    store.getState().mergeForegroundDisplayed(entry("target", 10, null));

    expect(store.getState().byId.target).toMatchObject({
      updatedAt: 20,
      readAt: 30,
      displayedUpdatedAt: 20,
    });
  });

  it("cannot lose the monotonic receipt when a stale window writes another row", () => {
    const key = appLocalNotificationsKey("user-a");
    const seed = createAppLocalNotificationsStore(key);
    seed.getState().activateIdentity("user-a");
    seed.getState().upsert(entry("target", 10, null));
    const firstWindow = createAppLocalNotificationsStore(key);
    const staleWindow = createAppLocalNotificationsStore(key);
    firstWindow.getState().activateIdentity("user-a");
    staleWindow.getState().activateIdentity("user-a");
    const version = {
      userId: "user-a",
      notificationId: "target",
      updatedAt: 10,
    };

    firstWindow.getState().markAsDisplayed("target", 10);
    recordAppLocalDisplayReceipt(version);
    staleWindow.getState().upsert(entry("unrelated", 20, null));

    const reloaded = createAppLocalNotificationsStore(key);
    expect(reloaded.getState().byId.target.displayedUpdatedAt).toBeNull();
    expect(hasAppLocalDisplayReceipt(version)).toBe(true);
  });

  it("treats legacy unread rows without a receipt as already displayed", () => {
    const key = appLocalNotificationsKey("user-a");
    const persisted = {
      ...entry("legacy-unread", 10, null),
      displayedUpdatedAt: undefined,
    };
    window.localStorage.setItem(
      key,
      JSON.stringify({
        state: {
          byId: { [persisted.id]: persisted },
          orderedIds: [persisted.id],
          unreadCount: 1,
        },
        version: 1,
      }),
    );

    const store = createAppLocalNotificationsStore(key);

    expect(store.getState().orderedIds).toEqual([persisted.id]);
    expect(store.getState().unreadCount).toBe(1);
    expect(
      store.getState().byId[persisted.id].displayedUpdatedAt,
    ).toBeUndefined();
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
      .markEntityAsRead("host-a", { epicId: "epic-1", chatId: "chat-1" }, 20);

    expect(store.getState().byId.match.readAt).toBe(20);
    expect(store.getState().byId.other.readAt).toBeNull();
  });

  it("keeps a same-entity failure from another host unread", () => {
    const store = createAppLocalNotificationsStore(
      appLocalNotificationsKey("user-a"),
    );
    store.getState().activateIdentity("user-a");
    store.getState().upsert(entry("host-a-failure", 10, null));
    store.getState().upsert({
      ...entry("host-b-failure", 11, null),
      originHostId: "host-b",
    });

    store
      .getState()
      .markEntityAsRead("host-a", { epicId: "epic-1", chatId: "chat-1" }, 20);

    expect(store.getState().byId["host-a-failure"].readAt).toBe(20);
    expect(store.getState().byId["host-b-failure"].readAt).toBeNull();
  });

  it("consumes only exact-entity failures older than a live completion", () => {
    const store = createAppLocalNotificationsStore(
      appLocalNotificationsKey("user-a"),
    );
    store.getState().activateIdentity("user-a");
    store.getState().upsert(entry("older-match", 10, null));
    store.getState().upsert(entry("tie-match", 20, null));
    store.getState().upsert(entry("newer-match", 30, null));
    store.getState().upsert({
      ...entry("other-host", 5, null),
      originHostId: "host-b",
    });

    store
      .getState()
      .markEntityAsReadBefore(
        "host-a",
        { epicId: "epic-1", chatId: "chat-1" },
        40,
        20,
      );

    expect(store.getState().byId["older-match"].readAt).toBe(40);
    expect(store.getState().byId["tie-match"].readAt).toBeNull();
    expect(store.getState().byId["newer-match"].readAt).toBeNull();
    expect(store.getState().byId["other-host"].readAt).toBeNull();
  });

  it("consumes failures already observed for the exact completed entity", () => {
    const store = createAppLocalNotificationsStore(
      appLocalNotificationsKey("user-a"),
    );
    store.getState().activateIdentity("user-a");
    store.getState().upsert(entry("older-match", 10, null));
    store.getState().upsert({
      ...entry("older-sibling", 5, null),
      payload: { kind: "chat", epicId: "epic-1", chatId: "chat-2" },
    });

    store
      .getState()
      .observeCompletion(
        "host-a",
        { id: "completion-1", occurrenceKey: "completion-1@10" },
        { epicId: "epic-1", chatId: "chat-1" },
        20,
      );
    store.getState().upsert(entry("later-match", 1, null));

    expect(store.getState().byId["older-match"].readAt).toBe(20);
    expect(store.getState().byId["later-match"].readAt).toBeNull();
    expect(store.getState().byId["older-sibling"].readAt).toBeNull();
  });

  it("does not consume an exact-entity failure from another host", () => {
    const store = createAppLocalNotificationsStore(
      appLocalNotificationsKey("user-a"),
    );
    store.getState().activateIdentity("user-a");
    store.getState().upsert(entry("host-a-failure", 10, null));

    store
      .getState()
      .observeCompletion(
        "host-b",
        { id: "host-b-completion", occurrenceKey: "host-b-completion@20" },
        { epicId: "epic-1", chatId: "chat-1" },
        20,
      );

    expect(store.getState().byId["host-a-failure"].readAt).toBeNull();

    store
      .getState()
      .observeCompletion(
        "host-a",
        { id: "host-a-completion", occurrenceKey: "host-a-completion@30" },
        { epicId: "epic-1", chatId: "chat-1" },
        30,
      );

    expect(store.getState().byId["host-a-failure"].readAt).toBe(30);
  });

  it("persists completion observations so a remount cannot replay one over a later failure", () => {
    const key = appLocalNotificationsKey("user-a");
    const first = createAppLocalNotificationsStore(key);
    first.getState().activateIdentity("user-a");
    first
      .getState()
      .observeCompletion(
        "host-a",
        { id: "completion-1", occurrenceKey: "completion-1@10" },
        { epicId: "epic-1", chatId: "chat-1" },
        20,
      );
    first.getState().upsert(entry("later-failure", 30, null));

    const remounted = createAppLocalNotificationsStore(key);
    remounted.getState().activateIdentity("user-a");
    remounted
      .getState()
      .seedCompletion(
        "host-a",
        { id: "completion-1", occurrenceKey: "completion-1@10" },
        35,
      );
    remounted
      .getState()
      .observeCompletion(
        "host-a",
        { id: "completion-1", occurrenceKey: "completion-1@10" },
        { epicId: "epic-1", chatId: "chat-1" },
        40,
      );

    expect(remounted.getState().byId["later-failure"].readAt).toBeNull();
  });

  it("applies one shared completion independently in every renderer", () => {
    const key = appLocalNotificationsKey("user-a");
    const firstWindow = createAppLocalNotificationsStore(key);
    const secondWindow = createAppLocalNotificationsStore(key);
    firstWindow.getState().activateIdentity("user-a");
    secondWindow.getState().activateIdentity("user-a");
    firstWindow.getState().upsert(entry("first-window-failure", 10, null));
    secondWindow.getState().upsert(entry("second-window-failure", 10, null));
    const completion = {
      id: "completion-1",
      occurrenceKey: "completion-1@20",
    };
    const entity = { epicId: "epic-1", chatId: "chat-1" };

    firstWindow.getState().observeCompletion("host-a", completion, entity, 20);
    secondWindow.getState().observeCompletion("host-a", completion, entity, 21);
    secondWindow.getState().upsert(entry("later-failure", 30, null));
    secondWindow.getState().observeCompletion("host-a", completion, entity, 40);

    expect(firstWindow.getState().byId["first-window-failure"].readAt).toBe(20);
    expect(secondWindow.getState().byId["second-window-failure"].readAt).toBe(
      21,
    );
    expect(secondWindow.getState().byId["later-failure"].readAt).toBeNull();
  });

  it("keeps reconciling a completion batch when one receipt write fails", () => {
    const store = createAppLocalNotificationsStore(
      appLocalNotificationsKey("user-a"),
    );
    store.getState().activateIdentity("user-a");
    store.getState().upsert(entry("failure", 10, null));
    const failedReceipt = {
      userId: "user-a",
      originHostId: "host-a",
      occurrenceKey: "failed@20",
    };
    const originalSetItem = Storage.prototype.setItem.bind(window.localStorage);
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation((key, value) => {
        if (key === appLocalNotificationCompletionReceiptKey(failedReceipt)) {
          throw new DOMException(
            "Storage quota exceeded",
            "QuotaExceededError",
          );
        }
        originalSetItem(key, value);
      });

    try {
      store.getState().recordCompletions([
        {
          originHostId: "host-a",
          completion: { id: "failed", occurrenceKey: "failed@20" },
          entity: { epicId: "epic-1", chatId: "chat-1" },
          observedAt: 20,
        },
        {
          originHostId: "host-a",
          completion: { id: "stored", occurrenceKey: "stored@21" },
          entity: null,
          observedAt: 21,
        },
      ]);
    } finally {
      setItem.mockRestore();
    }

    expect(store.getState().byId.failure.readAt).toBe(20);
    expect(store.getState().observedCompletionsByHost["host-a"]).toHaveLength(
      2,
    );
    expect(
      hasAppLocalCompletionReceipt({
        userId: "user-a",
        originHostId: "host-a",
        occurrenceKey: "stored@21",
      }),
    ).toBe(true);
  });

  it("bounds and prunes persisted completion observations", () => {
    const store = createAppLocalNotificationsStore(
      appLocalNotificationsKey("user-a"),
    );
    store.getState().activateIdentity("user-a");
    for (
      let index = 0;
      index < APP_LOCAL_OBSERVED_COMPLETION_CAP_PER_HOST + 1;
      index++
    ) {
      store.getState().observeCompletion(
        "host-a",
        {
          id: `completion-${index}`,
          occurrenceKey: `completion-${index}@${index}`,
        },
        { epicId: "epic-1", chatId: `chat-${index}` },
        index,
      );
    }

    expect(store.getState().observedCompletionsByHost["host-a"]).toHaveLength(
      APP_LOCAL_OBSERVED_COMPLETION_CAP_PER_HOST,
    );
    expect(
      store.getState().observedCompletionsByHost["host-a"],
    ).not.toContainEqual({
      id: "completion-0",
      occurrenceKey: "completion-0@0",
      observedAt: 0,
    });

    store.getState().removeObservedCompletions("host-a", ["completion-1"]);
    expect(
      store.getState().observedCompletionsByHost["host-a"],
    ).not.toContainEqual({
      id: "completion-1",
      occurrenceKey: "completion-1@1",
      observedAt: 1,
    });
  });

  it("bounds completion receipts across host churn", () => {
    const store = createAppLocalNotificationsStore(
      appLocalNotificationsKey("user-a"),
    );
    store.getState().activateIdentity("user-a");
    for (
      let index = 0;
      index < APP_LOCAL_OBSERVED_COMPLETION_GLOBAL_CAP + 1;
      index++
    ) {
      store
        .getState()
        .seedCompletion(
          `host-${index}`,
          { id: `completion-${index}`, occurrenceKey: `completion@${index}` },
          index,
        );
    }

    expect(
      Object.values(store.getState().observedCompletionsByHost).flat(),
    ).toHaveLength(APP_LOCAL_OBSERVED_COMPLETION_GLOBAL_CAP);
    expect(
      storageKeys().filter((storageKey) =>
        storageKey.startsWith(
          `${appLocalNotificationCompletionReceiptPrefix("user-a")}:`,
        ),
      ),
    ).toHaveLength(APP_LOCAL_OBSERVED_COMPLETION_GLOBAL_CAP);
  });

  it("seeds a baseline completion without consuming a persisted failure", () => {
    const store = createAppLocalNotificationsStore(
      appLocalNotificationsKey("user-a"),
    );
    store.getState().activateIdentity("user-a");
    store.getState().upsert(entry("persisted-failure", 20, null));

    store
      .getState()
      .seedCompletion(
        "host-a",
        { id: "agent.stopped:chat-1", occurrenceKey: "stopped@10" },
        30,
      );
    store
      .getState()
      .observeCompletion(
        "host-a",
        { id: "agent.stopped:chat-1", occurrenceKey: "stopped@10" },
        { epicId: "epic-1", chatId: "chat-1" },
        40,
      );

    expect(store.getState().byId["persisted-failure"].readAt).toBeNull();
  });

  it("keeps a receipt when a stale renderer overwrites the Zustand blob", () => {
    const key = appLocalNotificationsKey("user-a");
    const firstWindow = createAppLocalNotificationsStore(key);
    const staleWindow = createAppLocalNotificationsStore(key);
    firstWindow.getState().activateIdentity("user-a");
    staleWindow.getState().activateIdentity("user-a");
    firstWindow
      .getState()
      .observeCompletion(
        "host-a",
        { id: "agent.stopped:chat-1", occurrenceKey: "stopped@10" },
        { epicId: "epic-1", chatId: "chat-1" },
        10,
      );
    staleWindow.getState().upsert(entry("unrelated", 20, null));

    const reloaded = createAppLocalNotificationsStore(key);
    reloaded.getState().activateIdentity("user-a");
    reloaded
      .getState()
      .seedCompletion(
        "host-a",
        { id: "agent.stopped:chat-1", occurrenceKey: "stopped@10" },
        25,
      );
    reloaded.getState().upsert(entry("later-failure", 30, null));
    reloaded
      .getState()
      .observeCompletion(
        "host-a",
        { id: "agent.stopped:chat-1", occurrenceKey: "stopped@10" },
        { epicId: "epic-1", chatId: "chat-1" },
        40,
      );

    expect(reloaded.getState().byId["later-failure"].readAt).toBeNull();
    expect(
      storageKeys().filter((storageKey) =>
        storageKey.startsWith(
          `${appLocalNotificationCompletionReceiptPrefix("user-a")}:`,
        ),
      ),
    ).toHaveLength(1);
  });

  it("consumes a later occurrence that reuses a semantic completion id", () => {
    const store = createAppLocalNotificationsStore(
      appLocalNotificationsKey("user-a"),
    );
    store.getState().activateIdentity("user-a");
    store
      .getState()
      .observeCompletion(
        "host-a",
        { id: "agent.stopped:chat-1", occurrenceKey: "stopped@10" },
        { epicId: "epic-1", chatId: "chat-1" },
        20,
      );
    store.getState().upsert(entry("between-runs", 30, null));

    store
      .getState()
      .observeCompletion(
        "host-a",
        { id: "agent.stopped:chat-1", occurrenceKey: "stopped@40" },
        { epicId: "epic-1", chatId: "chat-1" },
        50,
      );

    expect(store.getState().byId["between-runs"].readAt).toBe(50);
  });

  it("resurfaces a same-code chat disconnect after completion", () => {
    useAppLocalNotificationsStore.getState().activateIdentity("user-a");
    const details = {
      code: "CONNECTION_LOST",
      reason: "Connection lost",
      incompatibleMethods: null,
      upgradeGuidance: null,
    };
    emitChatStreamErrorNotification({
      hostId: "host-a",
      epicId: "epic-1",
      chatId: "chat-1",
      details,
    });
    const notificationId =
      "stream.transport.error:host-a:chat-1:CONNECTION_LOST";
    useAppLocalNotificationsStore
      .getState()
      .observeCompletion(
        "host-a",
        { id: "completion-1", occurrenceKey: "completion-1@10" },
        { epicId: "epic-1", chatId: "chat-1" },
        20,
      );
    emitChatStreamErrorNotification({
      hostId: "host-a",
      epicId: "epic-1",
      chatId: "chat-1",
      details,
    });

    const state = useAppLocalNotificationsStore.getState();
    expect(state.orderedIds).toEqual([notificationId]);
    expect(state.byId[notificationId].readAt).toBeNull();
    expect(state.unreadCount).toBe(1);
  });

  it("keeps same-code chat disconnects from different hosts independent", () => {
    useAppLocalNotificationsStore.getState().activateIdentity("user-a");
    const details = {
      code: "CONNECTION_LOST",
      reason: "Connection lost",
      incompatibleMethods: null,
      upgradeGuidance: null,
    };

    emitChatStreamErrorNotification({
      hostId: "host-a",
      epicId: "epic-1",
      chatId: "chat-1",
      details,
    });
    emitChatStreamErrorNotification({
      hostId: "host-b",
      epicId: "epic-1",
      chatId: "chat-1",
      details,
    });

    const state = useAppLocalNotificationsStore.getState();
    expect(state.orderedIds).toEqual([
      "stream.transport.error:host-b:chat-1:CONNECTION_LOST",
      "stream.transport.error:host-a:chat-1:CONNECTION_LOST",
    ]);
    expect(
      state.byId["stream.transport.error:host-a:chat-1:CONNECTION_LOST"]
        .originHostId,
    ).toBe("host-a");
    expect(
      state.byId["stream.transport.error:host-b:chat-1:CONNECTION_LOST"]
        .originHostId,
    ).toBe("host-b");
    expect(state.unreadCount).toBe(2);
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

    store.getState().markEntityAsRead("host-a", { epicId: "epic-1" }, 20);

    expect(store.getState().byId.epic.readAt).toBe(20);
    expect(store.getState().byId.chat.readAt).toBeNull();
  });

  it("consumes matching epic rows across hosts for a hostless presence", () => {
    const store = createAppLocalNotificationsStore(
      appLocalNotificationsKey("user-a"),
    );
    store.getState().activateIdentity("user-a");
    store.getState().upsert({
      ...entry("host-a-epic", 10, null),
      payload: { kind: "epic", epicId: "epic-1" },
    });
    store.getState().upsert({
      ...entry("host-b-epic", 11, null),
      originHostId: "host-b",
      payload: { kind: "epic", epicId: "epic-1" },
    });

    store.getState().markEntityAsRead(null, { epicId: "epic-1" }, 20);

    expect(store.getState().byId["host-a-epic"].readAt).toBe(20);
    expect(store.getState().byId["host-b-epic"].readAt).toBe(20);
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
      hostId: "host-a",
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
      hostId: "host-a",
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
    const firstUpdatedAt =
      useAppLocalNotificationsStore.getState().byId[
        "terminal.closed:terminal-instance"
      ].updatedAt;
    useAppLocalNotificationsStore
      .getState()
      .markAsDisplayed("terminal.closed:terminal-instance", firstUpdatedAt);
    const now = vi.spyOn(Date, "now").mockReturnValue(firstUpdatedAt + 1);

    emitTerminalClosedNotification({
      instanceId: "terminal-instance",
      hostId: "host-a",
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
    now.mockRestore();

    expect(
      useAppLocalNotificationsStore.getState().byId[
        "terminal.closed:terminal-instance"
      ],
    ).toMatchObject({
      updatedAt: firstUpdatedAt + 1,
      readAt: 123,
      displayedUpdatedAt: firstUpdatedAt,
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
      hostId: "host-a",
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
      hostId: "host-a",
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

function storageKeys(): ReadonlyArray<string> {
  const keys: string[] = [];
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (key !== null) keys.push(key);
  }
  return keys;
}
