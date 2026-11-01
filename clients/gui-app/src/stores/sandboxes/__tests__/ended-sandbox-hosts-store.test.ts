import { beforeEach, describe, expect, it } from "vitest";
import {
  sandboxOperationFixture,
  sandboxSummaryFixture,
} from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import {
  __resetAppLocalNotificationsStoreForTests,
  emitChatStreamErrorNotification,
  emitTerminalClosedNotification,
  useAppLocalNotificationsStore,
} from "@/stores/notifications/app-local-notifications-store";
import {
  endedSandboxHost,
  forgetEndedSandboxHost,
  recordEndedSandboxHost,
  recordListedDestroys,
  useEndedSandboxHostsStore,
} from "@/stores/sandboxes/ended-sandbox-hosts-store";

const ME = { userId: "u-me", displayName: "Me" };
const OWN_DESTROY = {
  name: "box-a",
  at: 1_000,
  cause: "verb",
  actor: ME,
  idleMinutes: null,
};

function notificationIds(): string[] {
  return Object.keys(useAppLocalNotificationsStore.getState().byId).sort();
}

function raiseStreamFailure(hostId: string, chatId: string): void {
  emitChatStreamErrorNotification({
    hostId,
    epicId: "epic-1",
    chatId,
    details: {
      code: "CONNECTION_LOST",
      reason: "Connection lost",
      incompatibleMethods: null,
      upgradeGuidance: null,
    },
  });
}

describe("the ended sandbox hosts store", () => {
  beforeEach(() => {
    window.localStorage.clear();
    __resetAppLocalNotificationsStoreForTests();
    useAppLocalNotificationsStore.getState().activateIdentity("user-a");
    useEndedSandboxHostsStore.setState({ byHostId: {} });
  });

  it("records a destroy and forgets one that did not happen", () => {
    recordEndedSandboxHost("host-a", OWN_DESTROY);
    expect(endedSandboxHost("host-a")).toEqual(OWN_DESTROY);

    forgetEndedSandboxHost("host-a");

    expect(endedSandboxHost("host-a")).toBeNull();
  });

  it("withdraws that host's stream failures, and nothing else", () => {
    raiseStreamFailure("host-a", "chat-1");
    raiseStreamFailure("host-a", "chat-2");
    raiseStreamFailure("host-b", "chat-3");
    emitTerminalClosedNotification({
      instanceId: "tile-1",
      hostId: "host-a",
      hostLabel: "box-a",
      sandboxStopped: false,
      target: {
        kind: "terminal",
        epicId: "epic-1",
        terminalId: "terminal-tile-1",
        tabId: "view-tab-1",
        paneId: "pane-1",
        tileInstanceId: "tile-1",
      },
    });
    expect(notificationIds()).toHaveLength(4);

    recordEndedSandboxHost("host-a", OWN_DESTROY);

    expect(notificationIds()).toEqual([
      "stream.transport.error:host-b:chat-3:CONNECTION_LOST",
      "terminal.closed:tile-1",
    ]);
  });

  describe("recordListedDestroys", () => {
    const row = (
      hostId: string,
      operation: Parameters<typeof sandboxOperationFixture>[0] | null,
    ) =>
      sandboxSummaryFixture({
        hostId,
        displayName: `name-${hostId}`,
        operation:
          operation === null ? null : sandboxOperationFixture(operation),
      });

    it("records a row a member is destroying or has destroyed, with its name, time and actor", () => {
      recordListedDestroys([
        row("host-moving", { state: "destroying", at: 5_000 }),
        row("host-gone", { state: "destroyed", at: 6_000 }),
      ]);

      expect(endedSandboxHost("host-moving")).toEqual({
        name: "name-host-moving",
        at: 5_000,
        cause: "verb",
        actor: ME,
        idleMinutes: null,
      });
      expect(endedSandboxHost("host-gone")?.at).toBe(6_000);
    });

    it("records no row without an operation", () => {
      recordListedDestroys([row("host-a", null)]);
      expect(endedSandboxHost("host-a")).toBeNull();
    });

    it("records a row the system destroyed, with its cause and no actor", () => {
      recordListedDestroys([
        row("host-idle", { cause: "burst-idle", actor: null }),
        row("host-resting", { cause: "resting", actor: null }),
      ]);
      expect(endedSandboxHost("host-idle")).toMatchObject({
        cause: "burst-idle",
        actor: null,
      });
      expect(endedSandboxHost("host-resting")).toMatchObject({
        cause: "resting",
        actor: null,
      });
    });

    it("records no row that is only suspending or stopping", () => {
      recordListedDestroys([
        row("host-suspend", { state: "suspending" }),
        row("host-stop", { state: "stopped" }),
      ]);
      expect(endedSandboxHost("host-suspend")).toBeNull();
      expect(endedSandboxHost("host-stop")).toBeNull();
    });

    it("keeps the record already held for a host and its stream failures withdrawn once", () => {
      recordEndedSandboxHost("host-a", { ...OWN_DESTROY, name: "own-record" });
      raiseStreamFailure("host-a", "chat-1");

      recordListedDestroys([row("host-a", { state: "destroyed", at: 9_000 })]);

      expect(endedSandboxHost("host-a")?.name).toBe("own-record");
      // The listed destroy did not record again, so it withdrew nothing.
      expect(notificationIds()).toEqual([
        "stream.transport.error:host-a:chat-1:CONNECTION_LOST",
      ]);
    });
  });
});
