import { describe, expect, it } from "vitest";
import type { HostNotificationEntry } from "@traycer/protocol/host/notifications/contracts";
import {
  type NotificationEntry,
  NOTIFICATION_EVENT_TYPES,
} from "@traycer/protocol/notifications/notification-entry";
import {
  appLocalFeedId,
  globalFeedId,
  hostFeedId,
  mergeNotificationFeedIds,
  mergedUnreadCount,
  rowFromAppLocalEntry,
  rowFromGlobalEntry,
  rowFromHostEntry,
} from "@/stores/notifications/merged-notifications";
import type { AppLocalNotificationEntry } from "@/stores/notifications/app-local-notifications-store";

function hostEntry(
  id: string,
  updatedAt: number,
  readAt: number | null,
): HostNotificationEntry {
  return {
    id,
    updatedAt,
    readAt,
    kind: "approval.requested",
    sourceRef: "approval-1",
    severity: "needs_action",
    outcome: null,
    resolvedAt: null,
    payload: {
      epicId: "epic-1",
      chatId: "chat-1",
      approvalId: "approval-1",
    },
  };
}

function globalEntry(
  id: string,
  createdAt: number,
  readAt: number | null,
): NotificationEntry {
  return {
    id,
    createdAt,
    readAt,
    event: {
      kind: NOTIFICATION_EVENT_TYPES.INVITED,
      epicId: "epic-1",
      actorName: "Alice",
    },
  };
}

function appLocalEntry(
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
    message: "Worktree setup failed",
    detail: null,
  };
}

describe("merged notifications feed", () => {
  it("merges sources into one newest-first id projection", () => {
    const ids = mergeNotificationFeedIds(
      [hostEntry("host-old", 10, null), hostEntry("host-new", 30, null)],
      [{ feedId: appLocalFeedId("app-local-mid"), createdAt: 25 }],
      [globalEntry("global-mid", 20, null)],
    );

    expect(ids).toEqual([
      hostFeedId("host-new"),
      appLocalFeedId("app-local-mid"),
      globalFeedId("global-mid"),
      hostFeedId("host-old"),
    ]);
  });

  it("aggregates unread badge counts across all source seams", () => {
    expect(
      mergedUnreadCount({
        hostUnread: 2,
        appLocalUnread: 3,
        globalUnread: 4,
      }),
    ).toBe(9);
  });

  it("derives actionable approval payloads from host entries", () => {
    expect(rowFromHostEntry(hostEntry("approval", 10, null)).payload).toEqual({
      kind: "approval",
      epicId: "epic-1",
      chatId: "chat-1",
      approvalId: "approval-1",
      sessionId: undefined,
      artifactId: undefined,
    });
  });

  it("splits global notification titles from their collaboration context", () => {
    expect(rowFromGlobalEntry(globalEntry("global", 10, null))).toMatchObject({
      title: "Alice invited you to an epic",
      body: "Collaboration",
    });
  });

  it("uses the task title in host notification copy", () => {
    const base = {
      id: "notification-1",
      updatedAt: 10,
      readAt: null,
      sourceRef: "agent-1",
    } as const;
    const stopped: HostNotificationEntry = {
      ...base,
      kind: "agent.stopped",
      severity: "done",
      outcome: "completed",
      payload: {
        epicId: "epic-1",
        chatId: "chat-1",
        agentName: "Deploy checkout fix",
        taskTitle: "Checkout notifications",
        outcome: "completed",
      },
    };
    const rateLimited: HostNotificationEntry = {
      ...base,
      kind: "agent.stopped",
      severity: "failure",
      outcome: "errored",
      payload: {
        epicId: "epic-1",
        chatId: "chat-1",
        agentName: "Deploy checkout fix",
        taskTitle: "Checkout notifications",
        outcome: "errored",
        code: "RATE_LIMIT",
      },
    };
    const stalled: HostNotificationEntry = {
      ...base,
      kind: "agent.stalled",
      severity: "failure",
      outcome: "errored",
      payload: {
        epicId: "epic-1",
        chatId: "chat-1",
        agentName: "Deploy checkout fix",
        taskTitle: "Checkout notifications",
      },
    };
    const interview: HostNotificationEntry = {
      ...base,
      kind: "interview.requested",
      severity: "needs_action",
      outcome: null,
      resolvedAt: null,
      payload: {
        epicId: "epic-1",
        chatId: "chat-1",
        chatTitle: "Deploy checkout fix",
        taskTitle: "Checkout notifications",
      },
    };

    expect(rowFromHostEntry(stopped)).toMatchObject({
      title: "Checkout notifications",
      body: "Deploy checkout fix • Done",
    });
    expect(rowFromHostEntry(rateLimited)).toMatchObject({
      title: "Checkout notifications",
      body: "Deploy checkout fix • Rate limit reached",
    });
    expect(rowFromHostEntry(stalled)).toMatchObject({
      title: "Checkout notifications",
      body: "Deploy checkout fix • Stalled",
    });
    expect(rowFromHostEntry(interview)).toMatchObject({
      title: "Checkout notifications",
      body: "Deploy checkout fix • Question waiting",
    });
  });

  it("does not display UUID placeholders from legacy host payloads", () => {
    const interview: HostNotificationEntry = {
      id: "legacy-interview",
      updatedAt: 10,
      readAt: null,
      sourceRef: "interview-1",
      kind: "interview.requested",
      severity: "needs_action",
      outcome: null,
      resolvedAt: null,
      payload: {
        epicId: "epic-1",
        chatId: "40694091-7647-44a6-856a-54d3fd620412",
        chatTitle: "Chat 40694091-7647-44a6-856a-54d3fd620412",
      },
    };

    expect(rowFromHostEntry(interview)).toMatchObject({
      title: "Task",
      body: "Chat • Question waiting",
    });
  });

  it("formats app-local rows with their own payload and kind", () => {
    expect(rowFromAppLocalEntry(appLocalEntry("setup", 10, null))).toEqual({
      feedId: appLocalFeedId("setup"),
      source: "app-local",
      sourceId: "setup",
      createdAt: 10,
      readAt: null,
      title: "Worktree setup failed",
      body: "Traycer notification",
      payload: { kind: "chat", epicId: "epic-1", chatId: "chat-1" },
      hostKind: null,
      appLocalKind: "worktree.setup.failed",
      globalEntry: null,
      severity: "failure",
      outcome: null,
    });
  });
});
