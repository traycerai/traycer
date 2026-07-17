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
    epicId: "epic-1",
    chatId: "chat-1",
    payload: {
      kind: "approval",
      epicId: "epic-1",
      chatId: "chat-1",
      chatTitle: "Deploy checkout fix",
      taskTitle: "Checkout notifications",
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
    kind: "stream.transport.error",
    sourceRef: id,
    payload: { kind: "chat", epicId: "epic-1", chatId: "chat-1" },
    message: "Chat stream closed unexpectedly",
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
      epicId: "epic-1",
      chatId: "chat-1",
    } as const;
    const stopped: HostNotificationEntry = {
      ...base,
      kind: "agent.stopped",
      severity: "done",
      outcome: "completed",
      payload: {
        kind: "chat",
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
        kind: "chat",
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
        kind: "agent_stalled",
        epicId: "epic-1",
        chatId: "chat-1",
        agentId: "chat-1",
        agentName: "Deploy checkout fix",
        taskTitle: "Checkout notifications",
        reason: "provider_buffering",
        title: "Provider is buffering",
        outcome: "errored",
      },
    };
    const workspaceFailure: HostNotificationEntry = {
      ...base,
      kind: "workspace.operation.failed",
      severity: "failure",
      outcome: "errored",
      payload: {
        kind: "workspace_operation_failed",
        epicId: "epic-1",
        chatId: "chat-1",
        chatTitle: "Deploy checkout fix",
        taskTitle: "Checkout notifications",
        operation: "provision",
        title: "Worktree creation failed",
        message: "Couldn't create worktree.",
        outcome: "errored",
      },
    };
    const interview: HostNotificationEntry = {
      ...base,
      kind: "interview.requested",
      severity: "needs_action",
      outcome: null,
      resolvedAt: null,
      payload: {
        kind: "interview",
        epicId: "epic-1",
        chatId: "chat-1",
        chatTitle: "Deploy checkout fix",
        taskTitle: "Checkout notifications",
        interviewBlockId: "block-1",
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
      body: "Deploy checkout fix • Provider is taking longer than expected",
    });
    expect(rowFromHostEntry(workspaceFailure)).toMatchObject({
      title: "Checkout notifications",
      body: "Deploy checkout fix • Worktree creation failed",
      payload: { kind: "chat", epicId: "epic-1", chatId: "chat-1" },
    });
    expect(rowFromHostEntry(interview)).toMatchObject({
      title: "Checkout notifications",
      body: "Deploy checkout fix • Question waiting",
    });
  });

  it("renders safe semantic failure copy without exposing raw messages", () => {
    const base = {
      id: "notification-semantic",
      updatedAt: 10,
      readAt: null,
      sourceRef: "agent-1",
      epicId: "epic-1",
      chatId: "chat-1",
      kind: "agent.stopped",
      severity: "failure",
      outcome: "errored",
    } as const;
    const entry = (
      reason: string | undefined,
      code: string,
      providerId: string | undefined,
    ): HostNotificationEntry => ({
      ...base,
      payload: {
        kind: "chat",
        epicId: "epic-1",
        chatId: "chat-1",
        agentName: "Debug notifications",
        taskTitle: "Notification errors",
        outcome: "errored",
        code,
        message: "raw /Users/alice/private-path and provider output",
        reason,
        providerId,
      },
    });

    expect(
      rowFromHostEntry(entry("auth", "auth", "claude-code")),
    ).toMatchObject({
      body: "Debug notifications • Claude Code is signed out. Reconnect to continue.",
    });
    expect(
      rowFromHostEntry(entry("rate_limit", "future-code", "claude-code")),
    ).toMatchObject({
      body: "Debug notifications • Claude Code rate limit reached",
    });
    expect(
      rowFromHostEntry(entry("future-reason", "future-code", undefined)),
    ).toMatchObject({
      body: "Debug notifications • Failed",
    });
    expect(rowFromHostEntry(entry(undefined, "auth", undefined))).toMatchObject(
      {
        body: "Debug notifications • Provider is signed out. Reconnect to continue.",
      },
    );
    expect(
      rowFromHostEntry(entry("auth", "auth", "future-provider")),
    ).toMatchObject({
      body: "Debug notifications • Provider is signed out. Reconnect to continue.",
    });
    expect(
      rowFromHostEntry(entry(undefined, "MISSING_API_KEY", "claude-code")),
    ).toMatchObject({
      body: "Debug notifications • Failed",
    });
  });

  it("presents known typed payloads and degrades unknown ones generically", () => {
    const base = {
      id: "notification-typed",
      updatedAt: 10,
      readAt: null,
      sourceRef: "chat-1",
      epicId: "epic-1",
      chatId: "chat-1",
    } as const;
    // A fully typed payload from a current host: presentation and the
    // navigation deep-link both come from the second-stage semantic parse.
    const typed: HostNotificationEntry = {
      ...base,
      kind: "agent.stopped",
      severity: "done",
      outcome: "completed",
      payload: {
        kind: "chat",
        epicId: "epic-1",
        chatId: "chat-1",
        agentName: "Deploy checkout fix",
        taskTitle: "Checkout notifications",
        outcome: "completed",
      },
    };
    expect(rowFromHostEntry(typed)).toMatchObject({
      title: "Checkout notifications",
      body: "Deploy checkout fix • Done",
      payload: { kind: "chat", epicId: "epic-1", chatId: "chat-1" },
    });

    // A payload kind from a NEWER host: unknown here, so the row renders
    // generically with no deep-link - it must never vanish or crash
    // presentation.
    const futureShape: HostNotificationEntry = {
      ...base,
      id: "notification-future",
      kind: "agent.stopped",
      severity: "done",
      outcome: "completed",
      payload: {
        kind: "future_shape",
        epicId: "epic-1",
        chatId: "chat-1",
        taskTitle: "Checkout notifications",
        outcome: "completed",
      },
    };
    expect(rowFromHostEntry(futureShape)).toMatchObject({
      title: "Task",
      body: "Chat • Done",
      payload: null,
    });

    // Cross-kind corruption: a well-formed payload under the WRONG row kind
    // must not mint contradictory copy or a deep-link.
    const crossKind: HostNotificationEntry = {
      ...base,
      id: "notification-cross-kind",
      kind: "approval.requested",
      severity: "needs_action",
      outcome: null,
      resolvedAt: null,
      payload: {
        kind: "chat",
        epicId: "epic-1",
        chatId: "chat-1",
        agentName: "Deploy checkout fix",
        taskTitle: "Checkout notifications",
        outcome: "completed",
      },
    };
    expect(rowFromHostEntry(crossKind)).toMatchObject({
      title: "Task",
      body: "Chat • Approval requested",
      payload: null,
    });

    // Wrongly-typed display fields fail the semantic parse and degrade the
    // same way.
    const malformed: HostNotificationEntry = {
      ...base,
      id: "notification-malformed",
      kind: "agent.stopped",
      severity: "done",
      outcome: "completed",
      payload: {
        kind: "chat",
        epicId: "epic-1",
        chatId: "chat-1",
        agentName: 42,
        taskTitle: null,
        outcome: "completed",
      },
    };
    expect(rowFromHostEntry(malformed)).toMatchObject({
      title: "Task",
      body: "Chat • Done",
      payload: null,
    });
  });

  it("formats app-local rows with their own payload and kind", () => {
    expect(rowFromAppLocalEntry(appLocalEntry("setup", 10, null))).toEqual({
      feedId: appLocalFeedId("setup"),
      source: "app-local",
      sourceId: "setup",
      createdAt: 10,
      readAt: null,
      title: "Chat stream closed unexpectedly",
      body: "Traycer notification",
      payload: { kind: "chat", epicId: "epic-1", chatId: "chat-1" },
      hostKind: null,
      appLocalKind: "stream.transport.error",
      globalEntry: null,
      severity: "failure",
      outcome: null,
    });
  });
});
