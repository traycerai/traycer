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
import type { HostNotificationEntry } from "@traycer/protocol/host/notifications/contracts";

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
  return {
    id: input.id,
    updatedAt: input.updatedAt,
    readAt: input.readAt,
    kind: input.kind,
    sourceRef: input.id,
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

async function advanceHoldWindow(): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(3_000);
    await Promise.resolve();
  });
}

describe("NotificationEmissionController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_777_768_800_000);
    __resetHostNotificationsStoreForTests();
  });

  afterEach(() => {
    cleanup();
    __resetHostNotificationsStoreForTests();
    vi.useRealTimers();
  });

  it("baselines host snapshots and emits only later live host upserts", async () => {
    const runnerHost = createRunnerHost();
    renderController(runnerHost);
    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      useHostNotificationsStore.getState().replaceFromSnapshot(
        [
          hostEntry({
            id: "snapshot-1",
            updatedAt: 10,
            readAt: null,
            kind: "agent.stopped",
          }),
          hostEntry({
            id: "snapshot-2",
            updatedAt: 20,
            readAt: null,
            kind: "approval.requested",
          }),
        ],
        50,
      );
    });
    await advanceHoldWindow();

    expect(runnerHost.notificationsSent).toEqual([]);

    act(() => {
      useHostNotificationsStore.getState().upsert(
        hostEntry({
          id: "live-1",
          updatedAt: 30,
          readAt: null,
          kind: "interview.requested",
        }),
      );
    });
    await advanceHoldWindow();

    expect(runnerHost.notificationsSent).toHaveLength(1);
    expect(runnerHost.notificationsSent[0]?.body).toBe(
      "Question waiting in Chat",
    );

    act(() => {
      useHostNotificationsStore.getState().replaceFromSnapshot(
        [
          hostEntry({
            id: "snapshot-1",
            updatedAt: 10,
            readAt: null,
            kind: "agent.stopped",
          }),
          hostEntry({
            id: "live-1",
            updatedAt: 30,
            readAt: null,
            kind: "interview.requested",
          }),
          hostEntry({
            id: "reconnect-1",
            updatedAt: 40,
            readAt: null,
            kind: "approval.requested",
          }),
        ],
        50,
      );
    });
    await advanceHoldWindow();

    expect(runnerHost.notificationsSent).toHaveLength(1);
  });
});
