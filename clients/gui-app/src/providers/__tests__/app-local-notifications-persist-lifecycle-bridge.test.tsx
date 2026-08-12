import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { AppLocalNotificationsPersistLifecycleBridge } from "@/providers/app-local-notifications-persist-lifecycle-bridge";
import { appLocalNotificationsKey } from "@/lib/persist";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  __resetAppLocalNotificationsStoreForTests,
  useAppLocalNotificationsStore,
  type AppLocalNotificationEntry,
} from "@/stores/notifications/app-local-notifications-store";
import {
  hasAppLocalDisplayReceipt,
  recordAppLocalDisplayReceipt,
} from "@/lib/notifications/app-local-display-receipts";
import {
  hasAppLocalCompletionReceipt,
  recordAppLocalCompletionReceipt,
} from "@/lib/notifications/app-local-completion-receipts";

function entry(id: string): AppLocalNotificationEntry {
  return {
    id,
    originHostId: "host-a",
    updatedAt: 1,
    readAt: null,
    kind: "stream.transport.error",
    sourceRef: id,
    payload: { kind: "chat", epicId: "epic-1", chatId: id },
    message: id,
    detail: null,
    displayedUpdatedAt: null,
  };
}

function persistSnapshot(
  userId: string,
  entries: ReadonlyArray<AppLocalNotificationEntry>,
): void {
  window.localStorage.setItem(
    appLocalNotificationsKey(userId),
    JSON.stringify({
      state: {
        byId: Object.fromEntries(entries.map((item) => [item.id, item])),
        orderedIds: entries.map((item) => item.id),
        unreadCount: entries.filter((item) => item.readAt === null).length,
      },
      version: 1,
    }),
  );
}

function resetAuthSignedOut(): void {
  useAuthStore.setState({
    status: "signed-out",
    profile: null,
    contextMetadata: null,
    shareableTeams: [],
  });
}

function resetAuthSignedIn(userId: string, email: string): void {
  useAuthStore.setState({
    status: "signed-in",
    profile: { userId, userName: userId, email },
    contextMetadata: { userId, username: userId },
    shareableTeams: [],
  });
}

describe("<AppLocalNotificationsPersistLifecycleBridge />", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetAuthSignedOut();
    __resetAppLocalNotificationsStoreForTests();
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    resetAuthSignedOut();
    __resetAppLocalNotificationsStoreForTests();
  });

  it("retargets buckets by stable userId, not email", async () => {
    persistSnapshot("user-a", [entry("alice")]);
    persistSnapshot("user-b", [entry("bob")]);

    render(
      <AppLocalNotificationsPersistLifecycleBridge>
        <div />
      </AppLocalNotificationsPersistLifecycleBridge>,
    );

    act(() => {
      resetAuthSignedIn("user-a", "shared@example.com");
    });

    await waitFor(() => {
      expect(useAppLocalNotificationsStore.persist.getOptions().name).toBe(
        appLocalNotificationsKey("user-a"),
      );
      expect(useAppLocalNotificationsStore.getState().orderedIds).toEqual([
        "alice",
      ]);
    });

    act(() => {
      resetAuthSignedIn("user-b", "shared@example.com");
    });

    await waitFor(() => {
      expect(useAppLocalNotificationsStore.persist.getOptions().name).toBe(
        appLocalNotificationsKey("user-b"),
      );
      expect(useAppLocalNotificationsStore.getState().orderedIds).toEqual([
        "bob",
      ]);
      expect(
        useAppLocalNotificationsStore.getState().byId.alice,
      ).toBeUndefined();
    });
  });

  it("resets renderer completion observations on a direct user switch", async () => {
    persistSnapshot("user-a", []);
    persistSnapshot("user-b", [entry("shared-chat")]);

    render(
      <AppLocalNotificationsPersistLifecycleBridge>
        <div />
      </AppLocalNotificationsPersistLifecycleBridge>,
    );

    act(() => {
      resetAuthSignedIn("user-a", "alice@example.com");
    });
    await waitFor(() => {
      expect(useAppLocalNotificationsStore.getState().activeUserId).toBe(
        "user-a",
      );
    });
    act(() => {
      useAppLocalNotificationsStore
        .getState()
        .seedCompletion("host-a", { id: "done", occurrenceKey: "done@1" }, 1);
    });
    expect(
      useAppLocalNotificationsStore.getState().observedCompletionsByHost[
        "host-a"
      ],
    ).toHaveLength(1);

    act(() => {
      resetAuthSignedIn("user-b", "bob@example.com");
    });
    await waitFor(() => {
      expect(useAppLocalNotificationsStore.getState()).toMatchObject({
        activeUserId: "user-b",
        orderedIds: ["shared-chat"],
        observedCompletionsByHost: {},
      });
    });

    act(() => {
      useAppLocalNotificationsStore
        .getState()
        .observeCompletion(
          "host-a",
          { id: "done", occurrenceKey: "done@1" },
          { epicId: "epic-1", chatId: "shared-chat" },
          2,
        );
    });

    expect(
      useAppLocalNotificationsStore.getState().byId["shared-chat"].readAt,
    ).toBe(2);
  });

  it("clears the current user bucket on sign-out and deactivates writes", async () => {
    persistSnapshot("user-a", [entry("alice")]);
    const receipt = {
      userId: "user-a",
      notificationId: "alice",
      updatedAt: 1,
    };
    const completionReceipt = {
      userId: "user-a",
      originHostId: "host-a",
      id: "done-alice",
      occurrenceKey: "done-alice@1",
      observedAt: 1,
    };
    const otherUserCompletionReceipt = {
      ...completionReceipt,
      userId: "user-b",
      id: "done-bob",
      occurrenceKey: "done-bob@1",
    };
    recordAppLocalDisplayReceipt(receipt);
    recordAppLocalCompletionReceipt(completionReceipt);
    recordAppLocalCompletionReceipt(otherUserCompletionReceipt);

    render(
      <AppLocalNotificationsPersistLifecycleBridge>
        <div />
      </AppLocalNotificationsPersistLifecycleBridge>,
    );

    act(() => {
      resetAuthSignedIn("user-a", "alice@example.com");
    });

    await waitFor(() => {
      expect(useAppLocalNotificationsStore.getState().orderedIds).toEqual([
        "alice",
      ]);
    });

    act(() => {
      resetAuthSignedOut();
    });

    await waitFor(() => {
      expect(
        window.localStorage.getItem(appLocalNotificationsKey("user-a")),
      ).toBe(null);
      expect(useAppLocalNotificationsStore.getState().activeUserId).toBeNull();
      expect(useAppLocalNotificationsStore.getState().orderedIds).toEqual([]);
      expect(hasAppLocalDisplayReceipt(receipt)).toBe(false);
      expect(hasAppLocalCompletionReceipt(completionReceipt)).toBe(false);
      expect(hasAppLocalCompletionReceipt(otherUserCompletionReceipt)).toBe(
        true,
      );
    });

    useAppLocalNotificationsStore.getState().upsert(entry("ignored"));

    expect(useAppLocalNotificationsStore.getState().orderedIds).toEqual([]);
  });
});
