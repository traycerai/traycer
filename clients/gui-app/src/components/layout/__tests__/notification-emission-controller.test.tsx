import "../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { NotificationEmissionController } from "@/components/layout/bridges/notification-emission-controller";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { AppLocalNotificationsPersistLifecycleBridge } from "@/providers/app-local-notifications-persist-lifecycle-bridge";
import {
  __resetHostNotificationsStoreForTests,
  useHostNotificationsStore,
} from "@/stores/notifications/host-notifications-store";
import {
  useAppLocalNotificationsStore,
  type AppLocalNotificationEntry,
} from "@/stores/notifications/app-local-notifications-store";
import type { HostNotificationEntry } from "@traycer/protocol/host/notifications/contracts";
import { useAuthStore } from "@/stores/auth/auth-store";
import { appLocalNotificationsKey } from "@/lib/persist";
import {
  hasAppLocalDisplayReceipt,
  recordAppLocalDisplayReceipt,
} from "@/lib/notifications/app-local-display-receipts";

const activate = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/notifications/use-notification-activation", () => ({
  useNotificationActivation: () => ({ activate, isPending: false }),
}));

function createRunnerHost(): MockRunnerHost {
  return new MockRunnerHost({
    signInUrl: "https://example.com",
    authnBaseUrl: "https://auth.example.com",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
}

function hostEntry(input: {
  readonly id: string;
  readonly updatedAt: number;
  readonly readAt: number | null;
  readonly kind: HostNotificationEntry["kind"];
}): HostNotificationEntry {
  if (input.kind === "agent.stopped") {
    return {
      id: input.id,
      updatedAt: input.updatedAt,
      readAt: input.readAt,
      kind: "agent.stopped",
      sourceRef: input.id,
      severity: "done",
      outcome: "completed",
      epicId: "epic-1",
      chatId: "chat-1",
      payload: {
        epicId: "epic-1",
        chatId: "chat-1",
        chatTitle: "Chat",
        agentName: "Agent",
        outcome: "completed",
      },
    };
  }
  if (input.kind === "agent.stalled") {
    return {
      id: input.id,
      updatedAt: input.updatedAt,
      readAt: input.readAt,
      kind: "agent.stalled",
      sourceRef: input.id,
      severity: "failure",
      outcome: "errored",
      epicId: "epic-1",
      chatId: "chat-1",
      payload: {
        epicId: "epic-1",
        chatId: "chat-1",
        chatTitle: "Chat",
        agentName: "Agent",
      },
    };
  }
  if (input.kind === "approval.requested") {
    return {
      id: input.id,
      updatedAt: input.updatedAt,
      readAt: input.readAt,
      kind: "approval.requested",
      sourceRef: input.id,
      severity: "needs_action",
      outcome: null,
      resolvedAt: null,
      epicId: "epic-1",
      chatId: "chat-1",
      payload: {
        epicId: "epic-1",
        chatId: "chat-1",
        chatTitle: "Chat",
        agentName: "Agent",
      },
    };
  }
  return {
    id: input.id,
    updatedAt: input.updatedAt,
    readAt: input.readAt,
    kind: "interview.requested",
    sourceRef: input.id,
    severity: "needs_action",
    outcome: null,
    resolvedAt: null,
    epicId: "epic-1",
    chatId: "chat-1",
    payload: {
      epicId: "epic-1",
      chatId: "chat-1",
      chatTitle: "Chat",
      agentName: "Agent",
    },
  };
}

function renderController(runnerHost: MockRunnerHost): void {
  render(
    <RunnerHostProvider runnerHost={runnerHost}>
      <NotificationEmissionController />
    </RunnerHostProvider>,
  );
}

function renderLifecycleController(runnerHost: MockRunnerHost): void {
  render(
    <AppLocalNotificationsPersistLifecycleBridge>
      <RunnerHostProvider runnerHost={runnerHost}>
        <NotificationEmissionController />
      </RunnerHostProvider>
    </AppLocalNotificationsPersistLifecycleBridge>,
  );
}

function resetAuthSignedIn(userId: string, email: string): void {
  useAuthStore.setState({
    status: "signed-in",
    profile: {
      userId,
      userName: userId,
      email,
    },
    contextMetadata: { userId, username: userId },
    shareableTeams: [],
  });
}

function resetAuthSignedOut(): void {
  useAuthStore.setState({
    status: "signed-out",
    profile: null,
    contextMetadata: null,
    shareableTeams: [],
  });
}

function persistEntries(
  userId: string,
  entries: ReadonlyArray<AppLocalNotificationEntry>,
): void {
  window.localStorage.setItem(
    appLocalNotificationsKey(userId),
    JSON.stringify({
      state: {
        byId: Object.fromEntries(entries.map((entry) => [entry.id, entry])),
        orderedIds: entries.map((entry) => entry.id),
        unreadCount: entries.filter((entry) => entry.readAt === null).length,
      },
      version: 1,
    }),
  );
}

function persistedAppLocalEntry(
  displayedUpdatedAt: number | null | undefined,
): AppLocalNotificationEntry {
  return {
    id: "host.error:persisted",
    updatedAt: 40,
    readAt: null,
    kind: "host.error" as const,
    sourceRef: "persisted",
    payload: null,
    message: "Persisted host error",
    detail: "Persisted details",
    displayedUpdatedAt,
  };
}

function renderPersistedController(
  entries: ReadonlyArray<AppLocalNotificationEntry>,
): MockRunnerHost {
  persistEntries("user-1", entries);
  useAppLocalNotificationsStore.persist.setOptions({
    name: appLocalNotificationsKey(null),
  });
  useAppLocalNotificationsStore.setState({
    activeUserId: null,
    byId: {},
    orderedIds: [],
    unreadCount: 0,
  });
  const runnerHost = createRunnerHost();
  renderLifecycleController(runnerHost);
  return runnerHost;
}

describe("NotificationEmissionController", () => {
  beforeEach(() => {
    activate.mockReset();
    window.localStorage.clear();
    resetAuthSignedIn("user-1", "user@example.com");
    __resetHostNotificationsStoreForTests();
    useAppLocalNotificationsStore.getState().resetForTests();
    useAppLocalNotificationsStore.getState().activateIdentity("user-1");
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    __resetHostNotificationsStoreForTests();
    useAppLocalNotificationsStore.getState().resetForTests();
  });

  it("does not emit for host-source feed upserts", async () => {
    const runnerHost = createRunnerHost();
    renderController(runnerHost);
    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      useHostNotificationsStore.getState().upsert(
        hostEntry({
          id: "live-1",
          updatedAt: 30,
          readAt: null,
          kind: "agent.stopped",
        }),
      );
    });

    expect(runnerHost.notificationsSent).toEqual([]);
  });

  it("keeps app-local notification display renderer-owned", async () => {
    const runnerHost = createRunnerHost();
    renderController(runnerHost);
    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      useAppLocalNotificationsStore.getState().upsert({
        id: "host.error:error-1",
        updatedAt: 40,
        readAt: null,
        kind: "host.error",
        sourceRef: "error-1",
        payload: null,
        message: "Host error",
        detail: "Details",
      });
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(runnerHost.notificationsSent).toHaveLength(1);
    expect(runnerHost.notificationsSent[0]?.body).toBe("Details");
  });

  it("does not replay persisted unread notifications during reload hydration", async () => {
    const persisted = persistedAppLocalEntry(undefined);
    const runnerHost = renderPersistedController([persisted]);
    await act(async () => {
      await Promise.resolve();
    });

    expect(useAppLocalNotificationsStore.getState().orderedIds).toEqual([
      persisted.id,
    ]);
    expect(useAppLocalNotificationsStore.getState().unreadCount).toBe(1);
    expect(runnerHost.notificationsSent).toEqual([]);
    expect(
      useAppLocalNotificationsStore.getState().byId[persisted.id]
        .displayedUpdatedAt,
    ).toBeUndefined();
  });

  it("shows an unread notification first persisted since the previous app session", async () => {
    const previouslyDisplayed = persistedAppLocalEntry(40);
    const arrivedWhileStopped = {
      ...previouslyDisplayed,
      id: "host.error:arrived-while-stopped",
      updatedAt: 50,
      sourceRef: "arrived-while-stopped",
      message: "New host error",
      detail: "New details",
      displayedUpdatedAt: null,
    };
    const runnerHost = renderPersistedController([
      arrivedWhileStopped,
      previouslyDisplayed,
    ]);
    await act(async () => {
      await Promise.resolve();
    });

    expect(runnerHost.notificationsSent).toHaveLength(1);
    expect(runnerHost.notificationsSent[0]?.body).toBe("New details");
    expect(useAppLocalNotificationsStore.getState().unreadCount).toBe(2);
    expect(
      useAppLocalNotificationsStore.getState().byId[previouslyDisplayed.id]
        .displayedUpdatedAt,
    ).toBe(previouslyDisplayed.updatedAt);
    expect(
      useAppLocalNotificationsStore.getState().byId[arrivedWhileStopped.id]
        .displayedUpdatedAt,
    ).toBe(arrivedWhileStopped.updatedAt);

    const persistedAfterDisplay = Object.values(
      useAppLocalNotificationsStore.getState().byId,
    );
    cleanup();
    const reloadedRunnerHost = renderPersistedController(persistedAfterDisplay);
    await act(async () => {
      await Promise.resolve();
    });

    expect(reloadedRunnerHost.notificationsSent).toEqual([]);
  });

  it("reconciles a pending notification that existed before the controller mounted", async () => {
    const pending = {
      ...persistedAppLocalEntry(null),
      id: "host.error:before-mount",
      sourceRef: "before-mount",
    };
    act(() => {
      useAppLocalNotificationsStore.getState().upsert(pending);
    });
    const runnerHost = createRunnerHost();

    renderController(runnerHost);

    await waitFor(() => {
      expect(runnerHost.notificationsSent).toHaveLength(1);
    });
    expect(
      useAppLocalNotificationsStore.getState().byId[pending.id]
        .displayedUpdatedAt,
    ).toBe(pending.updatedAt);
  });

  it("uses the monotonic receipt when another window persisted a stale pending row", async () => {
    const pending = {
      ...persistedAppLocalEntry(null),
      id: "host.error:stale-window",
      sourceRef: "stale-window",
    };
    act(() => {
      useAppLocalNotificationsStore.getState().upsert(pending);
    });
    recordAppLocalDisplayReceipt({
      userId: "user-1",
      notificationId: pending.id,
      updatedAt: pending.updatedAt,
    });
    const runnerHost = createRunnerHost();

    renderController(runnerHost);

    await waitFor(() => {
      expect(
        useAppLocalNotificationsStore.getState().byId[pending.id]
          .displayedUpdatedAt,
      ).toBe(pending.updatedAt);
    });
    expect(runnerHost.notificationsSent).toEqual([]);
  });

  it("waits for native display success before persisting the receipt", async () => {
    let resolveDisplay: (() => void) | null = null;
    const displayPending = new Promise<void>((resolve) => {
      resolveDisplay = resolve;
    });
    const runnerHost = createRunnerHost();
    const showNotification = vi
      .spyOn(runnerHost.notifications, "show")
      .mockReturnValue(displayPending);
    renderController(runnerHost);
    const pending = {
      ...persistedAppLocalEntry(null),
      id: "host.error:delayed-display",
      sourceRef: "delayed-display",
    };
    const version = {
      userId: "user-1",
      notificationId: pending.id,
      updatedAt: pending.updatedAt,
    };

    act(() => {
      useAppLocalNotificationsStore.getState().upsert(pending);
    });
    await waitFor(() => {
      expect(showNotification).toHaveBeenCalledOnce();
    });
    expect(
      useAppLocalNotificationsStore.getState().byId[pending.id]
        .displayedUpdatedAt,
    ).toBeNull();
    expect(hasAppLocalDisplayReceipt(version)).toBe(false);

    act(() => {
      resolveDisplay?.();
    });
    await waitFor(() => {
      expect(
        useAppLocalNotificationsStore.getState().byId[pending.id]
          .displayedUpdatedAt,
      ).toBe(pending.updatedAt);
    });
    expect(hasAppLocalDisplayReceipt(version)).toBe(true);
  });

  it("does not recreate a cleared receipt when native display completes after sign-out", async () => {
    let resolveDisplay: (() => void) | null = null;
    const displayPending = new Promise<void>((resolve) => {
      resolveDisplay = resolve;
    });
    const runnerHost = createRunnerHost();
    const showNotification = vi
      .spyOn(runnerHost.notifications, "show")
      .mockReturnValue(displayPending);
    renderLifecycleController(runnerHost);
    const pending = {
      ...persistedAppLocalEntry(null),
      id: "host.error:sign-out-in-flight",
      sourceRef: "sign-out-in-flight",
    };
    const version = {
      userId: "user-1",
      notificationId: pending.id,
      updatedAt: pending.updatedAt,
    };

    act(() => {
      useAppLocalNotificationsStore.getState().upsert(pending);
    });
    await waitFor(() => {
      expect(showNotification).toHaveBeenCalledOnce();
    });
    act(() => {
      resetAuthSignedOut();
    });
    await waitFor(() => {
      expect(useAppLocalNotificationsStore.getState().activeUserId).toBeNull();
    });
    await act(async () => {
      resolveDisplay?.();
      await displayPending;
    });

    expect(hasAppLocalDisplayReceipt(version)).toBe(false);
  });

  it("acknowledges an in-flight receipt after a direct user switch", async () => {
    let resolveDisplay: (() => void) | null = null;
    const displayPending = new Promise<void>((resolve) => {
      resolveDisplay = resolve;
    });
    const runnerHost = createRunnerHost();
    const showNotification = vi
      .spyOn(runnerHost.notifications, "show")
      .mockReturnValue(displayPending);
    renderLifecycleController(runnerHost);
    const pending = {
      ...persistedAppLocalEntry(null),
      id: "host.error:user-switch-in-flight",
      sourceRef: "user-switch-in-flight",
    };
    const version = {
      userId: "user-1",
      notificationId: pending.id,
      updatedAt: pending.updatedAt,
    };

    act(() => {
      useAppLocalNotificationsStore.getState().upsert(pending);
    });
    await waitFor(() => {
      expect(showNotification).toHaveBeenCalledOnce();
    });
    act(() => {
      resetAuthSignedIn("user-2", "other@example.com");
    });
    await waitFor(() => {
      expect(useAppLocalNotificationsStore.getState().activeUserId).toBe(
        "user-2",
      );
    });
    await act(async () => {
      resolveDisplay?.();
      await displayPending;
    });

    expect(hasAppLocalDisplayReceipt(version)).toBe(true);
  });

  it("leaves a failed native display pending and retries after remount", async () => {
    const failingRunnerHost = createRunnerHost();
    const showNotification = vi
      .spyOn(failingRunnerHost.notifications, "show")
      .mockRejectedValue(new Error("native display failed"));
    renderController(failingRunnerHost);
    const pending = {
      ...persistedAppLocalEntry(null),
      id: "host.error:retry-display",
      sourceRef: "retry-display",
    };
    const version = {
      userId: "user-1",
      notificationId: pending.id,
      updatedAt: pending.updatedAt,
    };

    act(() => {
      useAppLocalNotificationsStore.getState().upsert(pending);
    });
    await waitFor(() => {
      expect(showNotification).toHaveBeenCalledOnce();
    });
    expect(
      useAppLocalNotificationsStore.getState().byId[pending.id]
        .displayedUpdatedAt,
    ).toBeNull();
    expect(hasAppLocalDisplayReceipt(version)).toBe(false);

    cleanup();
    const retryRunnerHost = createRunnerHost();
    renderController(retryRunnerHost);

    await waitFor(() => {
      expect(retryRunnerHost.notificationsSent).toHaveLength(1);
    });
    expect(hasAppLocalDisplayReceipt(version)).toBe(true);
  });

  it("shows a pending same-id row after switching users", async () => {
    const sharedId = "host.error:transport";
    persistEntries("user-a", [
      {
        ...persistedAppLocalEntry(10),
        id: sharedId,
        updatedAt: 10,
        sourceRef: "user-a",
        detail: "User A details",
      },
    ]);
    persistEntries("user-b", [
      {
        ...persistedAppLocalEntry(null),
        id: sharedId,
        updatedAt: 20,
        sourceRef: "user-b",
        detail: "User B details",
      },
    ]);
    useAppLocalNotificationsStore.persist.setOptions({
      name: appLocalNotificationsKey(null),
    });
    useAppLocalNotificationsStore.setState({
      activeUserId: null,
      byId: {},
      orderedIds: [],
      unreadCount: 0,
    });
    resetAuthSignedIn("user-a", "a@example.com");
    const runnerHost = createRunnerHost();
    render(
      <AppLocalNotificationsPersistLifecycleBridge>
        <RunnerHostProvider runnerHost={runnerHost}>
          <NotificationEmissionController />
        </RunnerHostProvider>
      </AppLocalNotificationsPersistLifecycleBridge>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    runnerHost.notificationsSent.length = 0;

    act(() => {
      resetAuthSignedIn("user-b", "b@example.com");
    });

    await waitFor(() => {
      expect(runnerHost.notificationsSent).toHaveLength(1);
    });
    expect(runnerHost.notificationsSent[0]?.body).toBe("User B details");
    expect(useAppLocalNotificationsStore.getState().activeUserId).toBe(
      "user-b",
    );
  });
});
