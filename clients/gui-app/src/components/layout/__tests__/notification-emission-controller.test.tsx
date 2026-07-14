import "../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { NotificationEmissionController } from "@/components/layout/bridges/notification-emission-controller";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import {
  __resetHostNotificationsStoreForTests,
  useHostNotificationsStore,
} from "@/stores/notifications/host-notifications-store";
import { useAppLocalNotificationsStore } from "@/stores/notifications/app-local-notifications-store";
import type { HostNotificationEntry } from "@traycer/protocol/host/notifications/contracts";

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

describe("NotificationEmissionController", () => {
  beforeEach(() => {
    activate.mockReset();
    __resetHostNotificationsStoreForTests();
    useAppLocalNotificationsStore.getState().resetForTests();
    useAppLocalNotificationsStore.getState().activateIdentity("user-1");
  });

  afterEach(() => {
    cleanup();
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
});
