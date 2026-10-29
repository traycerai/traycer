import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import type { HostNotificationsCloudFeedRowV16 } from "@traycer/protocol/host/notifications/contracts";
import {
  __resetHostNotificationsStoreForTests,
  useHostNotificationsStore,
  type HostNotificationFeedEntry,
} from "@/stores/notifications/host-notifications-store";
import { __resetAppLocalNotificationsStoreForTests } from "@/stores/notifications/app-local-notifications-store";
import { useCloudNotificationsStore } from "@/stores/notifications/cloud-notifications-store";
import {
  useMergedNotificationRows,
  useMergedNotificationUnreadCount,
  useNotificationBellState,
} from "@/stores/notifications/merged-notifications";
import { __resetNotificationsStoreForTests } from "@/stores/notifications/notifications-store";

vi.mock("@/lib/notifications/notification-feed-mode", async (importActual) => {
  const actual =
    await importActual<
      typeof import("@/lib/notifications/notification-feed-mode")
    >();
  return {
    ...actual,
    useNotificationFeedMode: () => "cloud",
    useNotificationFeedModeSettling: () => false,
  };
});
vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => "host-1",
}));
vi.mock("@/hooks/notifications/use-notification-host", () => ({
  useNotificationResolveHostId: () => "host-1",
  useNotificationResolveHost: () => ({ hostId: "host-1", client: null }),
}));

const AGENT_ID = "agent-failure";
const SANDBOX_NOTICE_PAYLOAD = {
  kind: "sandbox_notice",
  sandboxId: "sbx-1",
  sandboxName: "build box",
  notice: { kind: "resting_destroyed" },
} as const;
const APPLY_FAILED_PAYLOAD = {
  kind: "environment_apply_failed",
  environmentId: "env-1",
  hostId: "host-1",
  hostName: "dev-box",
  itemKey: "settings",
  reason: "settings_not_applied",
} as const;

const PRESENTATION = { epicTitle: "Epic", chatTitle: "Chat" } as const;

function cloudRow(
  entry: HostNotificationsCloudFeedRowV16["entry"],
): HostNotificationsCloudFeedRowV16 {
  return {
    entryId: entry.id,
    originHostId: "host-cloud",
    coalesceKey: `${entry.kind}:${entry.id}`,
    entry,
    presentation: PRESENTATION,
  };
}

function agentFailureEntry(id: string): HostNotificationFeedEntry {
  return {
    id,
    updatedAt: 10,
    readAt: null,
    kind: "agent.stopped",
    sourceRef: id,
    severity: "failure",
    outcome: "errored",
    epicId: "epic-1",
    chatId: "chat-1",
    payload: {
      kind: "chat",
      epicId: "epic-1",
      chatId: "chat-1",
      outcome: "errored",
    },
  };
}

function sandboxNoticeEntry(id: string): HostNotificationFeedEntry {
  return {
    id,
    updatedAt: 10,
    readAt: null,
    kind: "sandbox.notice",
    sourceRef: id,
    severity: "needs_action",
    outcome: "completed",
    epicId: null,
    chatId: null,
    payload: SANDBOX_NOTICE_PAYLOAD,
  };
}

function applyFailedEntry(id: string): HostNotificationFeedEntry {
  return {
    id,
    updatedAt: 10,
    readAt: null,
    kind: "environment.apply.failed",
    sourceRef: id,
    severity: "failure",
    outcome: "errored",
    epicId: null,
    chatId: null,
    payload: APPLY_FAILED_PAYLOAD,
  };
}

/** A sandbox push: an ordinary agent row kind, told apart by its entry key. */
const SANDBOX_PUSH_ID = "sandbox-resting:sbx-1:7d";

function applyHost(
  entries: ReadonlyArray<HostNotificationFeedEntry>,
  summary: { readonly unreadCount: number; readonly attentionCount: number },
): void {
  useHostNotificationsStore.getState().applySnapshot({
    attention: { entries, nextCursor: null },
    recent: { entries, nextCursor: null },
    summary,
  });
}

function readCenter() {
  return renderHook(() => ({
    sourceIds: useMergedNotificationRows().map((row) => row.sourceId),
    bell: useNotificationBellState(),
    unread: useMergedNotificationUnreadCount(),
  })).result.current;
}

describe("sandbox and environment-apply notices stay out of the notification center", () => {
  beforeEach(() => {
    __resetHostNotificationsStoreForTests();
    __resetAppLocalNotificationsStoreForTests();
    __resetNotificationsStoreForTests();
    useCloudNotificationsStore.getState().reset();
    applyHost([], { unreadCount: 0, attentionCount: 0 });
  });

  afterEach(() => {
    cleanup();
    useCloudNotificationsStore.getState().reset();
  });

  // Each summary counts the dropped rows too, as the feed's own does: the
  // bell and the unread count must come out as the one agent row alone.
  const ONE_AGENT_FAILURE = {
    sourceIds: [AGENT_ID],
    bell: { kind: "attention", count: 1 },
    unread: 1,
  };

  it("drops them from a cloud snapshot", () => {
    useCloudNotificationsStore.getState().applySnapshot({
      rows: [
        cloudRow(agentFailureEntry(AGENT_ID)),
        cloudRow(sandboxNoticeEntry("sandbox-notice-row")),
        cloudRow(applyFailedEntry("apply-failed-row")),
      ],
      summary: { totalCount: 3, unreadCount: 3, attentionCount: 3 },
      version: 3,
    });

    expect(readCenter()).toEqual(ONE_AGENT_FAILURE);
  });

  it("drops them from a cloud replica seed", () => {
    useCloudNotificationsStore.getState().seedFromReplica({
      accountId: "user-a",
      rows: [
        cloudRow(agentFailureEntry(AGENT_ID)),
        cloudRow(sandboxNoticeEntry("sandbox-notice-row")),
        cloudRow(applyFailedEntry("apply-failed-row")),
      ],
      summary: { totalCount: 3, unreadCount: 3, attentionCount: 3 },
    });

    expect(readCenter()).toEqual(ONE_AGENT_FAILURE);
  });

  it("drops a cloud push keyed for a sandbox, whatever its row kind", () => {
    useCloudNotificationsStore.getState().applySnapshot({
      rows: [
        cloudRow(agentFailureEntry(AGENT_ID)),
        cloudRow(agentFailureEntry(SANDBOX_PUSH_ID)),
      ],
      summary: { totalCount: 2, unreadCount: 2, attentionCount: 2 },
      version: 3,
    });

    expect(readCenter()).toEqual(ONE_AGENT_FAILURE);
  });

  it("drops rows a host still holds", () => {
    useCloudNotificationsStore.getState().applySnapshot({
      rows: [],
      summary: { totalCount: 0, unreadCount: 0, attentionCount: 0 },
      version: 3,
    });
    applyHost(
      [
        agentFailureEntry(AGENT_ID),
        sandboxNoticeEntry("host-sandbox-notice"),
        applyFailedEntry("host-apply-failed"),
      ],
      { unreadCount: 3, attentionCount: 3 },
    );

    expect(readCenter()).toEqual(ONE_AGENT_FAILURE);
  });
});
