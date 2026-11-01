import { describe, expect, it } from "vitest";
import type {
  HostNotificationEntry,
  HostNotificationEntryV23,
  HostNotificationsCloudFeedRow,
  HostNotificationsCloudFeedRowV16,
} from "@traycer/protocol/host/notifications/contracts";
import {
  type NotificationEntry,
  NOTIFICATION_EVENT_TYPES,
} from "@traycer/protocol/notifications/notification-entry";
import {
  appLocalFeedId,
  mergedUnreadCount,
  rowFromAppLocalEntry,
  rowFromCloudFeedRow,
  rowFromGlobalEntry,
  rowFromHostEntry,
} from "@/stores/notifications/merged-notifications";
import { classifyNotificationLifecycle } from "@/lib/notifications/notification-lifecycle";
import type { AppLocalNotificationEntry } from "@/stores/notifications/app-local-notifications-store";
import type { HostNotificationFeedEntry } from "@/stores/notifications/host-notifications-store";

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
    originHostId: "host-a",
    updatedAt,
    readAt,
    kind: "stream.transport.error",
    sourceRef: id,
    payload: { kind: "chat", epicId: "epic-1", chatId: "chat-1" },
    message: "Agent stream closed unexpectedly",
    detail: null,
    displayedUpdatedAt: null,
  };
}

describe("merged notifications feed", () => {
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

  it("targets the terminal agent from TUI completion rows", () => {
    const entry: HostNotificationEntry = {
      id: "agent.stopped:tui-1",
      updatedAt: 10,
      readAt: null,
      kind: "agent.stopped",
      sourceRef: "tui-1",
      severity: "done",
      outcome: "completed",
      epicId: "epic-1",
      chatId: "tui-1",
      payload: {
        kind: "epic",
        epicId: "epic-1",
        tuiAgentId: "tui-1",
        agentName: "Terminal agent",
        taskTitle: "Checkout notifications",
        outcome: "completed",
      },
    };

    const row = rowFromHostEntry(entry);
    expect(row.payload).toEqual({
      kind: "chat",
      epicId: "epic-1",
      chatId: "tui-1",
    });
    expect(row.agentSurface).toBe("tui");
  });

  it("preserves transcript anchors from failure and qualified Done rows", () => {
    const base: HostNotificationEntry = {
      id: "agent.stopped:chat-1",
      updatedAt: 10,
      readAt: null,
      kind: "agent.stopped",
      sourceRef: "chat-1",
      severity: "done",
      outcome: "completed",
      epicId: "epic-1",
      chatId: "chat-1",
      payload: {
        kind: "chat",
        epicId: "epic-1",
        chatId: "chat-1",
        hostId: "chat-host",
        agentName: "Agent",
        taskTitle: "Task",
        outcome: "completed",
        messageId: "assistant-message-1",
        backgroundWorkRunning: true,
      },
    };

    const qualifiedDone = rowFromHostEntry(base);
    expect(qualifiedDone.payload).toEqual({
      kind: "chat",
      epicId: "epic-1",
      chatId: "chat-1",
      hostId: "chat-host",
      messageId: "assistant-message-1",
      eventId: undefined,
    });
    expect(qualifiedDone.agentSurface).toBe("gui");
    expect(
      rowFromHostEntry({
        ...base,
        id: "agent.failed:chat-1:occurrence-1",
        severity: "failure",
        outcome: "errored",
        payload: {
          ...base.payload,
          outcome: "errored",
          occurrenceId: "occurrence-1",
          messageId: undefined,
          eventId: "send-failed-event-1",
        },
      }).payload,
    ).toEqual({
      kind: "chat",
      epicId: "epic-1",
      chatId: "chat-1",
      hostId: "chat-host",
      messageId: undefined,
      eventId: "send-failed-event-1",
    });

    expect(
      rowFromHostEntry({
        ...base,
        payload: {
          ...base.payload,
          backgroundWorkRunning: false,
        },
      }).payload,
    ).toEqual({
      kind: "chat",
      epicId: "epic-1",
      chatId: "chat-1",
      hostId: "chat-host",
      messageId: undefined,
      eventId: undefined,
      scrollToEnd: true,
    });
  });

  it("labels a paused completed chat row and keeps its Done navigation", () => {
    const row = rowFromHostEntry({
      id: "agent.stopped:chat-1",
      updatedAt: 10,
      readAt: null,
      kind: "agent.stopped",
      sourceRef: "chat-1",
      severity: "done",
      outcome: "completed",
      epicId: "epic-1",
      chatId: "chat-1",
      payload: {
        kind: "chat",
        epicId: "epic-1",
        chatId: "chat-1",
        hostId: "chat-host",
        agentName: "Agent",
        taskTitle: "Task",
        outcome: "completed",
        messageId: "assistant-message-1",
        eventId: "event-1",
        unverified: true,
      },
    });

    expect(row.body).toBe("Agent • Paused, not verified");
    expect(row.severity).toBe("done");
    expect(row.outcome).toBe("completed");
    expect(row.payload).toEqual({
      kind: "chat",
      epicId: "epic-1",
      chatId: "chat-1",
      hostId: "chat-host",
      messageId: undefined,
      eventId: undefined,
      scrollToEnd: true,
    });
  });

  it("uses embedded cloud payload titles when the presentation snapshot is absent", () => {
    const embedded: HostNotificationsCloudFeedRow = {
      entryId: "entry-legacy",
      originHostId: "host-a",
      coalesceKey: "agent.stopped:legacy",
      entry: {
        id: "agent.stopped:legacy",
        updatedAt: 10,
        readAt: null,
        kind: "agent.stopped",
        sourceRef: "legacy",
        severity: "done",
        outcome: "completed",
        epicId: "epic-legacy",
        chatId: "chat-legacy",
        payload: {
          kind: "chat",
          epicId: "epic-legacy",
          chatId: "chat-legacy",
          agentName: "Legacy agent",
          taskTitle: "Legacy task",
          outcome: "completed",
        },
      },
      presentation: { epicTitle: null, chatTitle: null },
    };

    expect(rowFromCloudFeedRow(embedded)).toMatchObject({
      title: "Legacy task",
      body: "Legacy agent • Done",
    });
    expect(
      rowFromCloudFeedRow({
        ...embedded,
        entryId: "entry-untitled",
        coalesceKey: "agent.stopped:untitled",
        entry: {
          ...embedded.entry,
          id: "agent.stopped:untitled",
          sourceRef: "untitled",
          payload: {
            kind: "chat",
            epicId: "epic-legacy",
            chatId: "chat-legacy",
            outcome: "completed",
          },
        },
      }),
    ).toMatchObject({
      title: "Task",
      body: "Agent • Done",
    });
  });

  it("uses the cloud task title as the header with the chat title as fallback", () => {
    const cloudRow: HostNotificationsCloudFeedRow = {
      entryId: "entry-completed",
      originHostId: "host-a",
      coalesceKey: "agent.stopped:chat-1",
      entry: {
        id: "agent.stopped:chat-1",
        updatedAt: 10,
        readAt: null,
        kind: "agent.stopped",
        sourceRef: "chat-1",
        severity: "done",
        outcome: "completed",
        epicId: "epic-1",
        chatId: "chat-1",
        payload: {
          kind: "chat",
          epicId: "epic-1",
          chatId: "chat-1",
          agentName: "Test Code Execution",
          taskTitle: "Stale task title",
          outcome: "completed",
        },
      },
      presentation: {
        epicTitle: "Notification improvements",
        chatTitle: "Test Code Execution",
      },
    };

    expect(rowFromCloudFeedRow(cloudRow)).toMatchObject({
      title: "Notification improvements",
      body: "Test Code Execution • Done",
    });
    expect(
      rowFromCloudFeedRow({
        ...cloudRow,
        presentation: {
          ...cloudRow.presentation,
          epicTitle: "",
        },
      }),
    ).toMatchObject({
      title: "Test Code Execution",
      body: "Test Code Execution • Done",
    });
    expect(
      rowFromCloudFeedRow({
        ...cloudRow,
        presentation: {
          epicTitle: "",
          chatTitle: "",
        },
      }),
    ).toMatchObject({
      title: "Stale task title",
      body: "Test Code Execution • Done",
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
    const interviewPayload = {
      kind: "interview" as const,
      epicId: "epic-1",
      chatId: "chat-1",
      chatTitle: "Deploy checkout fix",
      taskTitle: "Checkout notifications",
      interviewBlockId: "block-1",
    };
    const interviewWaiting: HostNotificationEntry = {
      ...base,
      kind: "interview.requested",
      severity: "needs_action",
      outcome: null,
      resolvedAt: null,
      payload: interviewPayload,
    };
    // resolvedAt is the only resolved/unresolved signal for this kind
    // (outcome is always null) - presentation must branch on that field alone.
    const interviewResolved: HostNotificationEntry = {
      ...base,
      id: "notification-interview-resolved",
      kind: "interview.requested",
      severity: "needs_action",
      outcome: null,
      resolvedAt: 99,
      payload: interviewPayload,
    };
    const approvalPayload = {
      kind: "approval" as const,
      epicId: "epic-1",
      chatId: "chat-1",
      chatTitle: "Deploy checkout fix",
      taskTitle: "Checkout notifications",
      approvalId: "approval-1",
    };
    const approvalWaiting: HostNotificationEntry = {
      ...base,
      id: "notification-approval-waiting",
      kind: "approval.requested",
      severity: "needs_action",
      outcome: null,
      resolvedAt: null,
      payload: approvalPayload,
    };
    // Same resolvableRequestStatus branch as interview - resolvedAt only.
    const approvalResolved: HostNotificationEntry = {
      ...base,
      id: "notification-approval-resolved",
      kind: "approval.requested",
      severity: "needs_action",
      outcome: null,
      resolvedAt: 99,
      payload: approvalPayload,
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
    expect(rowFromHostEntry(interviewWaiting)).toMatchObject({
      title: "Checkout notifications",
      body: "Deploy checkout fix • Question waiting",
    });
    expect(rowFromHostEntry(interviewResolved)).toMatchObject({
      title: "Checkout notifications",
      body: "Deploy checkout fix • Question resolved",
    });
    expect(rowFromHostEntry(approvalWaiting)).toMatchObject({
      title: "Checkout notifications",
      body: "Deploy checkout fix • Approval requested",
    });
    expect(rowFromHostEntry(approvalResolved)).toMatchObject({
      title: "Checkout notifications",
      body: "Deploy checkout fix • Approval resolved",
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
      body: "Agent • Done",
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
      body: "Agent • Approval requested",
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
      body: "Agent • Done",
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
      title: "Agent stream closed unexpectedly",
      body: "Traycer notification",
      payload: { kind: "chat", epicId: "epic-1", chatId: "chat-1" },
      hostKind: null,
      appLocalKind: "stream.transport.error",
      globalEntry: null,
      severity: "failure",
      outcome: null,
      resolvedAt: null,
      sourceRef: null,
      originHostId: "host-a",
      category: "system",
    });
  });

  it("projects host resolvedAt and category onto merged rows", () => {
    const unresolved = hostEntry("approval", 10, null);
    expect(rowFromHostEntry(unresolved)).toMatchObject({
      resolvedAt: null,
      category: "task",
      severity: "needs_action",
    });

    // Build a resolved approval row without spreading a union-typed entry
    // (TS loses the `approval.requested` arm under `{...entry, resolvedAt}`).
    const resolved = hostEntry("approval", 10, null);
    expect(
      rowFromHostEntry({
        id: resolved.id,
        updatedAt: resolved.updatedAt,
        readAt: resolved.readAt,
        kind: "approval.requested",
        sourceRef: resolved.sourceRef,
        severity: "needs_action",
        outcome: null,
        resolvedAt: 99,
        epicId: resolved.epicId,
        chatId: resolved.chatId,
        payload: resolved.payload,
      }),
    ).toMatchObject({
      resolvedAt: 99,
      category: "task",
    });
  });

  it("projects global category as collaboration", () => {
    expect(rowFromGlobalEntry(globalEntry("global", 10, null))).toMatchObject({
      category: "collaboration",
      resolvedAt: null,
      severity: "info",
    });
  });

  it("projects a role change as collaboration on both lanes, not as their task", () => {
    // The row the member is told their own role moved by, which mirrors the
    // task-sharing role change — a `global`, Collaboration row. Both lanes say
    // task, so each has to read the kind for the filter to keep the row under
    // Collaboration; the cloud lane is asserted beside the host one because it
    // is the lane that carries the row between hosts. Its title comes with it:
    // a cloud row prefers the epic and chat titles its producer snapshotted
    // over the composed copy, and this is the first kind the center carries
    // that belongs to no epic, so those titles have to be absent for the
    // member to read what happened.
    const entry = {
      id: "role-1",
      updatedAt: 10,
      readAt: null,
      kind: "team.role.changed",
      sourceRef: null,
      severity: "info",
      outcome: "completed",
      epicId: null,
      chatId: null,
      payload: {
        kind: "team_role_changed",
        environmentId: "env-1",
        teamName: "Acme",
        from: "editor",
        to: "admin",
      },
    } as const satisfies HostNotificationFeedEntry;

    expect(rowFromHostEntry(entry)).toMatchObject({
      category: "collaboration",
      severity: "info",
    });
    expect(
      rowFromCloudFeedRow({
        entryId: entry.id,
        originHostId: "host-a",
        coalesceKey: entry.id,
        entry,
        presentation: { epicTitle: null, chatTitle: null },
      }),
    ).toMatchObject({
      category: "collaboration",
      severity: "info",
      title: "Your role changed",
    });
  });

  it("routes a parked managed-command delivery back to the chat holding it", () => {
    expect(
      rowFromHostEntry({
        id: "managed-command.delivery:command-3",
        updatedAt: 10,
        readAt: null,
        kind: "host.operation.finished",
        sourceRef: "command-3",
        severity: "needs_action",
        outcome: "completed",
        epicId: "epic-1",
        chatId: "chat-1",
        payload: {
          kind: "managed_command_delivery_parked",
          operation: "managed-command.delivery",
          title: "Command output is waiting",
          message:
            "A managed command finished but the chat couldn't receive it.",
          commandId: "command-3",
          epicId: "epic-1",
          chatId: "chat-1",
        },
      }),
    ).toMatchObject({
      title: "Command output is waiting",
      body: "A managed command finished but the chat couldn't receive it.",
      payload: { kind: "chat", epicId: "epic-1", chatId: "chat-1" },
    });
  });

  it("leaves a legacy parked-delivery row (no epicId/chatId) with no destination", () => {
    const row = rowFromHostEntry({
      id: "managed-command.delivery:command-4",
      updatedAt: 10,
      readAt: null,
      kind: "host.operation.finished",
      sourceRef: "command-4",
      severity: "needs_action",
      outcome: "completed",
      epicId: null,
      chatId: null,
      payload: {
        kind: "managed_command_delivery_parked",
        operation: "managed-command.delivery",
        title: "Command output is waiting",
        message: "A managed command finished but the chat couldn't receive it.",
        commandId: "command-4",
      },
    });
    expect(row).toMatchObject({
      title: "Command output is waiting",
      body: "A managed command finished but the chat couldn't receive it.",
    });
    expect(row.payload).toBeNull();
  });

  it("renders a newer host's unknown operation payload from its common fields, with no destination", () => {
    const row = rowFromHostEntry({
      id: "testbox.provision:command-2",
      updatedAt: 10,
      readAt: null,
      kind: "host.operation.finished",
      sourceRef: "command-2",
      severity: "done",
      outcome: "completed",
      epicId: null,
      chatId: null,
      payload: {
        kind: "testbox_provision",
        operation: "testbox.provision",
        title: "Test box ready",
        message: "Provisioned 1 test box.",
      },
    });
    expect(row).toMatchObject({
      title: "Test box ready",
      body: "Provisioned 1 test box.",
    });
    // Readable and acknowledgeable, but never routed by guesswork.
    expect(row.payload).toBeNull();
  });

  describe("a bot's answer", () => {
    function verdictEntry(
      readAt: number | null,
      operation: string,
    ): HostNotificationFeedEntry {
      return {
        id: `${operation}:reply-1`,
        updatedAt: 10,
        readAt,
        kind: "host.operation.finished",
        sourceRef: "reply-1",
        severity: "done",
        outcome: "completed",
        epicId: "bot-1",
        chatId: "thread-1",
        payload: {
          kind: "bot_thread_verdict",
          operation,
          title: "Tracy answered",
          message: "Your question about the release",
          botId: "bot-1",
          threadId: "thread-1",
          replyMessageId: "reply-1",
        },
      };
    }

    function cloudRowOf(
      entry: HostNotificationFeedEntry,
    ): HostNotificationsCloudFeedRowV16 {
      return {
        entryId: entry.id,
        originHostId: "host-a",
        coalesceKey: entry.id,
        entry,
        presentation: { epicTitle: null, chatTitle: null },
      };
    }

    it.each([
      {
        plane: "host feed",
        rowOf: (entry: HostNotificationFeedEntry) => rowFromHostEntry(entry),
      },
      {
        plane: "cloud feed",
        rowOf: (entry: HostNotificationFeedEntry) =>
          rowFromCloudFeedRow(cloudRowOf(entry)),
      },
    ])(
      "is Attention's answer class while unread and Recent once read, from the $plane",
      ({ rowOf }) => {
        const unread = rowOf(verdictEntry(null, "bot.thread.verdict"));
        const read = rowOf(verdictEntry(5, "bot.thread.verdict"));

        expect(unread.botAnswer).toBe(true);
        expect(classifyNotificationLifecycle(unread)).toEqual({
          section: "attention",
          tier: "answer",
        });
        expect(classifyNotificationLifecycle(read)).toEqual({
          section: "recent",
        });
      },
    );

    it("is no answer when the finished operation is another one", () => {
      const row = rowFromHostEntry(verdictEntry(null, "testbox.provision"));

      expect(row.botAnswer).toBe(false);
      expect(classifyNotificationLifecycle(row)).toEqual({
        section: "recent",
      });
    });
  });

  describe("a bot's conversation row", () => {
    function conversationEntry(
      readAt: number | null,
      operation: string,
      mention: boolean,
    ): HostNotificationFeedEntry {
      return {
        id: `${operation}:row-1`,
        updatedAt: 10,
        readAt,
        kind: "host.operation.finished",
        sourceRef: "row-1",
        severity: "done",
        outcome: "completed",
        epicId: "bot-1",
        chatId: "thread-1",
        payload: {
          kind: "bot_conversation",
          operation,
          title: "Tracy",
          message: "Something in the thread",
          botId: "bot-1",
          threadId: "thread-1",
          messageId: "row-1",
          mention,
        },
      };
    }

    const planes = [
      {
        plane: "host feed",
        rowOf: (entry: HostNotificationFeedEntry) => rowFromHostEntry(entry),
      },
      {
        plane: "cloud feed",
        rowOf: (entry: HostNotificationFeedEntry) =>
          rowFromCloudFeedRow({
            entryId: entry.id,
            originHostId: "host-a",
            coalesceKey: entry.id,
            entry,
            presentation: { epicTitle: null, chatTitle: null },
          }),
      },
    ];

    it.each(planes)(
      "files an unread reply in a followed thread under Attention's answer class, and Recent once read, from the $plane",
      ({ rowOf }) => {
        const unread = rowOf(conversationEntry(null, "bot.reply", false));
        const read = rowOf(conversationEntry(5, "bot.reply", false));

        expect(classifyNotificationLifecycle(unread)).toEqual({
          section: "attention",
          tier: "answer",
        });
        expect(classifyNotificationLifecycle(read)).toEqual({
          section: "recent",
        });
      },
    );

    it.each(planes)(
      "files an unread row that mentions the person under Attention's answer class, from the $plane",
      ({ rowOf }) => {
        expect(
          classifyNotificationLifecycle(
            rowOf(conversationEntry(null, "bot.post", true)),
          ),
        ).toEqual({ section: "attention", tier: "answer" });
      },
    );

    it.each(planes)(
      "leaves a post that mentions no one under Recent, from the $plane",
      ({ rowOf }) => {
        expect(
          classifyNotificationLifecycle(
            rowOf(conversationEntry(null, "bot.post", false)),
          ),
        ).toEqual({ section: "recent" });
      },
    );
  });

  describe("a bot's row opens the bot's tab", () => {
    function botEntry(
      payload: HostNotificationFeedEntry["payload"],
    ): HostNotificationFeedEntry {
      return {
        id: "bot-row-1",
        updatedAt: 10,
        readAt: null,
        kind: "host.operation.finished",
        sourceRef: "row-1",
        severity: "done",
        outcome: "completed",
        epicId: "bot-1",
        chatId: null,
        payload,
      };
    }

    const verdict = {
      kind: "bot_thread_verdict",
      operation: "bot.thread.verdict",
      title: "Tracy answered",
      message: "Your question about the release",
      botId: "bot-1",
      threadId: "thread-1",
      replyMessageId: "reply-1",
    };
    const conversation = {
      kind: "bot_conversation",
      event: "bot.reply",
      operation: "bot.reply",
      title: "Tracy",
      message: "Something in the thread",
      botId: "bot-1",
      conversationId: "conversation-1",
      threadId: "thread-1",
      messageId: "message-1",
      authorUserId: null,
      mention: false,
    };

    const planes = [
      {
        plane: "host feed",
        rowOf: (entry: HostNotificationFeedEntry) => rowFromHostEntry(entry),
      },
      {
        plane: "cloud feed",
        rowOf: (entry: HostNotificationFeedEntry) =>
          rowFromCloudFeedRow({
            entryId: entry.id,
            originHostId: "host-a",
            coalesceKey: entry.id,
            entry,
            presentation: { epicTitle: null, chatTitle: null },
          }),
      },
    ];

    it.each(planes)(
      "opens the thread on the answer a verdict row names, with the row's own copy, from the $plane",
      ({ rowOf }) => {
        const row = rowOf(botEntry(verdict));

        expect(row.payload).toEqual({
          kind: "chat",
          epicId: "bot-1",
          chatId: "thread-1",
          bot: { botId: "bot-1", threadId: "thread-1", messageId: "reply-1" },
        });
        expect(row).toMatchObject({
          title: "Tracy answered",
          body: "Your question about the release",
        });
      },
    );

    it.each(planes)(
      "opens the thread on the row a conversation reply names, from the $plane",
      ({ rowOf }) => {
        const row = rowOf(botEntry(conversation));

        expect(row.payload).toEqual({
          kind: "chat",
          epicId: "bot-1",
          chatId: "thread-1",
          bot: { botId: "bot-1", threadId: "thread-1", messageId: "message-1" },
        });
        expect(row).toMatchObject({
          title: "Tracy",
          body: "Something in the thread",
        });
      },
    );

    it.each(planes)(
      "opens the channel on a post that is in no thread, from the $plane",
      ({ rowOf }) => {
        const row = rowOf(
          botEntry({
            ...conversation,
            event: "bot.post",
            operation: "bot.post",
            threadId: null,
          }),
        );

        expect(row.payload).toEqual({
          kind: "chat",
          epicId: "bot-1",
          chatId: "conversation-1",
          bot: { botId: "bot-1", threadId: null, messageId: "message-1" },
        });
      },
    );

    it.each(planes)(
      "routes no other finished operation, from the $plane",
      ({ rowOf }) => {
        const row = rowOf(
          botEntry({
            kind: "test_box",
            operation: "testbox.provision",
            title: "Test box ready",
            message: "Provisioned 1 test box.",
          }),
        );

        expect(row.payload).toBeNull();
      },
    );
  });

  describe("secrets rows", () => {
    const grantEntry: HostNotificationEntryV23 = {
      id: "secret-entry-1",
      updatedAt: 10,
      readAt: null,
      kind: "secret.grant.requested",
      sourceRef: "request-1",
      severity: "needs_action",
      outcome: null,
      resolvedAt: null,
      epicId: "epic-1",
      chatId: "chat-1",
      payload: {
        kind: "secret_grant_request",
        requestId: "request-1",
        hostId: "host-1",
        secretName: "DB_PASSWORD",
        destination: "db.example.com",
        port: 3306,
        protocol: "mysql",
        reason: "Run the migration",
        sandboxName: "build-box",
        epicId: "epic-1",
        chatId: "chat-1",
      },
    };
    const exportEntry: HostNotificationEntryV23 = {
      id: "secret-entry-2",
      updatedAt: 20,
      readAt: null,
      kind: "secret.export.minted",
      sourceRef: "export-1",
      severity: "info",
      outcome: "completed",
      epicId: "epic-1",
      chatId: "chat-1",
      payload: {
        kind: "secret_export_minted",
        secretName: "DEPLOY_KEY",
        exportKind: "presigned_url",
        expiresAt: 1_700_000_900_000,
        hostId: "host-1",
        epicId: "epic-1",
        chatId: "chat-1",
      },
    };

    it("projects a grant request into the grant-request detail", () => {
      const row = rowFromHostEntry(grantEntry);
      expect(row.secrets).toEqual({
        kind: "grant-request",
        requestId: "request-1",
        secretName: "DB_PASSWORD",
        destination: "db.example.com",
        port: 3306,
        protocol: "mysql",
        reason: "Run the migration",
        sandboxName: "build-box",
        environmentId: null,
        teamName: null,
        decision: null,
        decidedBy: null,
      });
      expect(row.payload).toEqual({
        kind: "chat",
        epicId: "epic-1",
        chatId: "chat-1",
      });
    });

    it("projects a resolved team grant request with its team and who answered", () => {
      const row = rowFromHostEntry({
        ...grantEntry,
        resolvedAt: 30,
        payload: {
          kind: "secret_grant_request",
          requestId: "request-1",
          hostId: "host-1",
          secretName: "DB_PASSWORD",
          destination: "db.example.com",
          protocol: "mysql",
          reason: "Run the migration",
          environmentId: "env-team-1",
          teamName: "Acme",
          decision: "approved",
          decidedBy: "Ana",
        },
      });
      expect(row.secrets).toMatchObject({
        kind: "grant-request",
        environmentId: "env-team-1",
        teamName: "Acme",
        decision: "approved",
        decidedBy: "Ana",
      });
    });

    it("has no navigation payload when the host named no chat", () => {
      const row = rowFromHostEntry({
        ...grantEntry,
        epicId: null,
        chatId: null,
        payload: {
          kind: "secret_grant_request",
          requestId: "request-3",
          hostId: "host-1",
          secretName: null,
          destination: "db.example.com",
          protocol: null,
          reason: "",
        },
      });
      expect(row.payload).toBeNull();
      expect(row.secrets).toMatchObject({
        kind: "grant-request",
        requestId: "request-3",
        secretName: null,
      });
    });

    it("gives a secrets row whose payload cannot be read no detail", () => {
      expect(
        rowFromHostEntry({ ...exportEntry, payload: { kind: "unheard_of" } })
          .secrets,
      ).toBeNull();
    });

    it("leaves secrets null on an ordinary host row", () => {
      expect(
        rowFromHostEntry(hostEntry("approval", 10, null)).secrets,
      ).toBeNull();
    });

    it("projects the detail from a cloud feed row too", () => {
      const row = rowFromCloudFeedRow({
        entryId: "entry-secret",
        originHostId: "host-a",
        coalesceKey: "secret.grant.requested:request-1",
        entry: grantEntry,
        presentation: { epicTitle: "Deploy", chatTitle: "Release" },
      });
      expect(row.secrets).toMatchObject({ kind: "grant-request" });
    });
  });
});
