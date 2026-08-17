import { describe, expect, it } from "vitest";
import type { HostNotificationsCloudFeedRow } from "@traycer/protocol/host/notifications/contracts";
import {
  mergeHostPendingForkIntoCloudIndicators,
  selectCloudNotificationIndicatorProjection,
  selectCloudNotificationIndicators,
  selectNotificationIndicatorState,
} from "@/stores/notifications/notification-indicator-state";

describe("notification indicator state", () => {
  it("merges an unread app-local failure into host indicator flags", () => {
    const state = selectNotificationIndicatorState(
      {
        byId: {
          terminal: {
            id: "terminal",
            updatedAt: 1,
            readAt: null,
            kind: "terminal.closed",
            sourceRef: "terminal",
            payload: { kind: "chat", epicId: "epic-1", chatId: "chat-1" },
            message: "Terminal closed",
            detail: null,
            displayedUpdatedAt: null,
          },
        },
      },
      { epicId: "epic-1", chatId: "chat-1" },
      null,
      {
        epics: {},
        chats: {
          "chat-1": {
            unreadFailure: false,
            pendingFork: true,
            pendingApproval: true,
            pendingInterview: false,
            unreadDone: true,
          },
        },
      },
    );

    expect(state).toEqual({
      unreadFailure: true,
      unreadNonTerminalFailure: false,
      unreadTerminalFailure: true,
      pendingFork: true,
      pendingApproval: true,
      pendingInterview: false,
      unreadDone: true,
    });
  });

  it("keeps the epic indicator lit for unread chat-local failures", () => {
    const state = selectNotificationIndicatorState(
      {
        byId: {
          terminal: {
            id: "terminal",
            updatedAt: 1,
            readAt: null,
            kind: "terminal.closed",
            sourceRef: "terminal",
            payload: { kind: "chat", epicId: "epic-1", chatId: "chat-1" },
            message: "Terminal closed",
            detail: null,
            displayedUpdatedAt: null,
          },
        },
      },
      { epicId: "epic-1" },
      null,
      { epics: {}, chats: {} },
    );

    expect(state.unreadFailure).toBe(true);
    expect(state.unreadNonTerminalFailure).toBe(false);
    expect(state.unreadTerminalFailure).toBe(true);
  });

  it("keeps a host-bound tab free of another host's local failure", () => {
    const state = {
      byId: {
        failure: {
          id: "failure",
          originHostId: "host-a",
          updatedAt: 1,
          readAt: null,
          kind: "stream.transport.error" as const,
          sourceRef: "chat-1",
          payload: {
            kind: "chat" as const,
            epicId: "epic-1",
            chatId: "chat-1",
          },
          message: "Connection lost",
          detail: null,
          displayedUpdatedAt: null,
        },
      },
    };
    const entity = { epicId: "epic-1", chatId: "chat-1" };
    const indicators = { epics: {}, chats: {} };

    expect(
      selectNotificationIndicatorState(state, entity, "host-b", indicators)
        .unreadFailure,
    ).toBe(false);
    expect(
      selectNotificationIndicatorState(state, entity, "host-a", indicators)
        .unreadFailure,
    ).toBe(true);
  });
});

/** The cloud predicates mirror the host's `indicatorState` SQL, so these pin
 * prompt aggregation, terminal chronology, and the entity join against that
 * source rather than against the shape of the code under them. */
describe("cloud notification indicator derivation", () => {
  function wrap(
    entryId: string,
    entry: HostNotificationsCloudFeedRow["entry"],
  ): HostNotificationsCloudFeedRow {
    return {
      entryId,
      originHostId: "host-b",
      coalesceKey: `${entry.kind}:chat-1`,
      entry,
      presentation: { epicTitle: null, chatTitle: null },
    };
  }

  /** An `agent.stopped` occurrence, the arm every terminal severity rides. */
  function stopped(
    entryId: string,
    severity: "done" | "failure" | "info",
    readAt: number | null,
  ): HostNotificationsCloudFeedRow {
    return stoppedAt({
      entryId,
      severity,
      readAt,
      updatedAt: 1,
      chatId: "chat-1",
    });
  }

  function stoppedAt(input: {
    readonly entryId: string;
    readonly severity: "done" | "failure" | "info";
    readonly readAt: number | null;
    readonly updatedAt: number;
    readonly chatId: string;
  }): HostNotificationsCloudFeedRow {
    return wrap(input.entryId, {
      id: input.entryId,
      updatedAt: input.updatedAt,
      readAt: input.readAt,
      kind: "agent.stopped",
      sourceRef: null,
      severity: input.severity,
      outcome: "completed",
      epicId: "epic-1",
      chatId: input.chatId,
      payload: {
        kind: "chat",
        epicId: "epic-1",
        chatId: input.chatId,
        outcome: "completed",
      },
    });
  }

  /** The payload is inert for indicator derivation (only kind, severity and
   * the markers are read), but it is still shaped the way its entry kind's
   * producer shapes it, so the fixture is not a misleading example of a
   * legal-looking pairing production never emits. */
  function prompt(
    entryId: string,
    kind: "approval.requested" | "interview.requested",
    resolvedAt: number | null,
    readAt: number | null,
  ): HostNotificationsCloudFeedRow {
    const shared = {
      epicId: "epic-1",
      chatId: "chat-1",
      chatTitle: "Chat",
      taskTitle: "Epic",
    };
    return wrap(entryId, {
      id: entryId,
      updatedAt: 1,
      readAt,
      kind,
      sourceRef: null,
      severity: "needs_action",
      outcome: null,
      resolvedAt,
      epicId: "epic-1",
      chatId: "chat-1",
      payload:
        kind === "approval.requested"
          ? { kind: "approval", ...shared, approvalId: entryId }
          : { kind: "interview", ...shared, interviewBlockId: entryId },
    });
  }

  function rowsById(
    rows: ReadonlyArray<HostNotificationsCloudFeedRow>,
  ): Record<string, HostNotificationsCloudFeedRow> {
    return Object.fromEntries(rows.map((entry) => [entry.entryId, entry]));
  }

  it("uses the newest terminal outcome for a chat", () => {
    const result = selectCloudNotificationIndicators(
      rowsById([
        stoppedAt({
          entryId: "failure-unread",
          severity: "failure",
          readAt: null,
          updatedAt: 1,
          chatId: "chat-1",
        }),
        stoppedAt({
          entryId: "done-unread",
          severity: "done",
          readAt: null,
          updatedAt: 2,
          chatId: "chat-1",
        }),
      ]),
      [],
      ["chat-1"],
    );

    expect(result.chats["chat-1"]).toEqual({
      pendingApproval: false,
      pendingInterview: false,
      pendingFork: false,
      unreadFailure: false,
      unreadDone: true,
    });
  });

  it("keeps a newer failure above an older completion", () => {
    const result = selectCloudNotificationIndicators(
      rowsById([
        stoppedAt({
          entryId: "done-unread",
          severity: "done",
          readAt: null,
          updatedAt: 1,
          chatId: "chat-1",
        }),
        stoppedAt({
          entryId: "failure-unread",
          severity: "failure",
          readAt: null,
          updatedAt: 2,
          chatId: "chat-1",
        }),
      ]),
      [],
      ["chat-1"],
    );

    expect(result.chats["chat-1"]).toEqual({
      pendingApproval: false,
      pendingInterview: false,
      pendingFork: false,
      unreadFailure: true,
      unreadDone: false,
    });
  });

  it("does not let an independent completion hide a failure on the same chat", () => {
    const failure = stoppedAt({
      entryId: "workspace-failure",
      severity: "failure",
      readAt: null,
      updatedAt: 1,
      chatId: "chat-1",
    });
    const done = stoppedAt({
      entryId: "agent-done",
      severity: "done",
      readAt: null,
      updatedAt: 2,
      chatId: "chat-1",
    });
    const result = selectCloudNotificationIndicators(
      rowsById([
        { ...failure, coalesceKey: "workspace.operation.failed:event-1" },
        { ...done, coalesceKey: "agent.stopped:chat-1" },
      ]),
      ["epic-1"],
      ["chat-1"],
    );

    expect(result.epics["epic-1"]).toMatchObject({
      unreadFailure: true,
      unreadDone: true,
    });
    expect(result.chats["chat-1"]).toMatchObject({
      unreadFailure: true,
      unreadDone: true,
    });
  });

  it("preserves an unread failure when terminal timestamps tie", () => {
    const result = selectCloudNotificationIndicators(
      rowsById([
        stoppedAt({
          entryId: "a-failure-unread",
          severity: "failure",
          readAt: null,
          updatedAt: 1,
          chatId: "chat-1",
        }),
        stoppedAt({
          entryId: "z-done-unread",
          severity: "done",
          readAt: null,
          updatedAt: 1,
          chatId: "chat-1",
        }),
      ]),
      [],
      ["chat-1"],
    );

    expect(result.chats["chat-1"]).toEqual({
      pendingApproval: false,
      pendingInterview: false,
      pendingFork: false,
      unreadFailure: true,
      unreadDone: false,
    });
  });

  it("does not compare terminal timestamps across origin hosts", () => {
    const failure = stoppedAt({
      entryId: "failure-unread",
      severity: "failure",
      readAt: null,
      updatedAt: 100,
      chatId: "chat-1",
    });
    const done = stoppedAt({
      entryId: "done-unread",
      severity: "done",
      readAt: null,
      updatedAt: 1_000,
      chatId: "chat-1",
    });
    const result = selectCloudNotificationIndicators(
      rowsById([
        { ...failure, originHostId: "host-a" },
        { ...done, originHostId: "host-b" },
      ]),
      [],
      ["chat-1"],
    );

    expect(result.chats["chat-1"]).toEqual({
      pendingApproval: false,
      pendingInterview: false,
      pendingFork: false,
      unreadFailure: true,
      unreadDone: true,
    });
  });

  it("keeps per-origin feed indicators separate for host-bound tabs", () => {
    const failure = stoppedAt({
      entryId: "failure-unread",
      severity: "failure",
      readAt: null,
      updatedAt: 100,
      chatId: "chat-1",
    });
    const done = stoppedAt({
      entryId: "done-unread",
      severity: "done",
      readAt: null,
      updatedAt: 200,
      chatId: "chat-1",
    });
    const projection = selectCloudNotificationIndicatorProjection(
      rowsById([
        { ...failure, originHostId: "host-a" },
        { ...done, originHostId: "host-b" },
      ]),
      [],
      ["chat-1"],
    );
    const indicators = {
      ...projection.aggregate,
      byOriginHostId: projection.byOriginHostId,
    };
    const local = { byId: {} };
    const entity = { epicId: "epic-1", chatId: "chat-1" };

    expect(
      selectNotificationIndicatorState(local, entity, null, indicators),
    ).toMatchObject({ unreadFailure: true, unreadDone: true });
    expect(
      selectNotificationIndicatorState(local, entity, "host-a", indicators),
    ).toMatchObject({ unreadFailure: true, unreadDone: false });
    expect(
      selectNotificationIndicatorState(local, entity, "host-b", indicators),
    ).toMatchObject({ unreadFailure: false, unreadDone: true });
    expect(
      selectNotificationIndicatorState(local, entity, "host-c", indicators),
    ).toEqual({
      pendingApproval: false,
      pendingFork: false,
      pendingInterview: false,
      unreadDone: false,
      unreadFailure: false,
      unreadNonTerminalFailure: false,
      unreadTerminalFailure: false,
    });
  });

  it("does not let one chat's completion hide a sibling failure", () => {
    const result = selectCloudNotificationIndicators(
      rowsById([
        stoppedAt({
          entryId: "done-unread",
          severity: "done",
          readAt: null,
          updatedAt: 2,
          chatId: "chat-1",
        }),
        stoppedAt({
          entryId: "failure-unread",
          severity: "failure",
          readAt: null,
          updatedAt: 1,
          chatId: "chat-2",
        }),
      ]),
      ["epic-1"],
      ["chat-1", "chat-2"],
    );

    expect(result.epics["epic-1"]).toEqual({
      pendingApproval: false,
      pendingInterview: false,
      pendingFork: false,
      unreadFailure: true,
      unreadDone: true,
    });
  });

  it("rolls a retained unread chat completion into its epic without a chat projection", () => {
    const result = selectCloudNotificationIndicators(
      rowsById([
        stoppedAt({
          entryId: "done-unread",
          severity: "done",
          readAt: null,
          updatedAt: 1,
          chatId: "chat-not-loaded",
        }),
      ]),
      ["epic-1"],
      [],
    );

    expect(result.epics["epic-1"].unreadDone).toBe(true);
    expect(result.chats).toEqual({});
  });

  it("counts a chat-scoped row toward its epic as well", () => {
    const result = selectCloudNotificationIndicators(
      rowsById([stopped("done-unread", "done", null)]),
      ["epic-1"],
      ["chat-1"],
    );

    expect(result.epics["epic-1"].unreadDone).toBe(true);
    expect(result.chats["chat-1"].unreadDone).toBe(true);
  });

  it("rolls a retained unread prompt into its epic without a chat projection", () => {
    const result = selectCloudNotificationIndicators(
      rowsById([prompt("approval", "approval.requested", null, null)]),
      ["epic-1"],
      [],
    );

    expect(result.epics["epic-1"].pendingApproval).toBe(true);
    expect(result.chats).toEqual({});
  });

  it("treats a read marker as clearing the unread arms", () => {
    const result = selectCloudNotificationIndicators(
      rowsById([
        stopped("done-read", "done", 5),
        stopped("failure-read", "failure", 5),
      ]),
      [],
      ["chat-1"],
    );

    expect(result.chats["chat-1"]).toBeUndefined();
  });

  it("keeps a read completion as the quiet winner over an older failure", () => {
    const result = selectCloudNotificationIndicators(
      rowsById([
        stoppedAt({
          entryId: "failure-unread",
          severity: "failure",
          readAt: null,
          updatedAt: 1,
          chatId: "chat-1",
        }),
        stoppedAt({
          entryId: "done-read",
          severity: "done",
          readAt: 3,
          updatedAt: 2,
          chatId: "chat-1",
        }),
      ]),
      ["epic-1"],
      ["chat-1"],
    );

    expect(result).toEqual({ epics: {}, chats: {} });
  });

  it("lights an approval while it is unresolved, including after it is read", () => {
    const unresolved = selectCloudNotificationIndicators(
      rowsById([prompt("approval", "approval.requested", null, null)]),
      [],
      ["chat-1"],
    );
    const resolvedButUnread = selectCloudNotificationIndicators(
      rowsById([prompt("approval", "approval.requested", 9, null)]),
      [],
      ["chat-1"],
    );
    const unresolvedButRead = selectCloudNotificationIndicators(
      rowsById([prompt("approval", "approval.requested", null, 10)]),
      [],
      ["chat-1"],
    );

    expect(unresolved.chats["chat-1"].pendingApproval).toBe(true);
    expect(resolvedButUnread.chats["chat-1"]).toBeUndefined();
    expect(unresolvedButRead.chats["chat-1"].pendingApproval).toBe(true);
  });

  it("lights a read-but-unresolved interview and clears it once resolved", () => {
    const unresolvedButRead = selectCloudNotificationIndicators(
      rowsById([prompt("interview", "interview.requested", null, 10)]),
      [],
      ["chat-1"],
    );
    const resolved = selectCloudNotificationIndicators(
      rowsById([prompt("interview", "interview.requested", 11, 10)]),
      [],
      ["chat-1"],
    );

    expect(unresolvedButRead.chats["chat-1"].pendingInterview).toBe(true);
    expect(resolved.chats["chat-1"]).toBeUndefined();
  });

  it("pends an interview independently of the approval arm", () => {
    const result = selectCloudNotificationIndicators(
      rowsById([prompt("interview", "interview.requested", null, null)]),
      [],
      ["chat-1"],
    );

    expect(result.chats["chat-1"]).toEqual({
      pendingApproval: false,
      pendingInterview: true,
      pendingFork: false,
      unreadFailure: false,
      unreadDone: false,
    });
  });

  it("lights nothing for an unread info row", () => {
    const result = selectCloudNotificationIndicators(
      rowsById([stopped("info", "info", null)]),
      ["epic-1"],
      ["chat-1"],
    );

    expect(result).toEqual({ epics: {}, chats: {} });
  });

  it("ignores entities the surface did not ask about", () => {
    const result = selectCloudNotificationIndicators(
      rowsById([stopped("done-unread", "done", null)]),
      [],
      ["chat-2"],
    );

    expect(result.chats).toEqual({});
  });
});

describe("cloud notification indicator authority", () => {
  it("merges only the connected host's pending fork bit into cloud flags", () => {
    const cloud = {
      epics: {
        "epic-1": {
          pendingApproval: false,
          pendingInterview: false,
          pendingFork: false,
          unreadFailure: false,
          unreadDone: true,
        },
      },
      chats: {
        "chat-1": {
          pendingApproval: true,
          pendingInterview: false,
          pendingFork: false,
          unreadFailure: false,
          unreadDone: false,
        },
      },
    };
    const host = {
      epics: {},
      chats: {
        "chat-1": {
          pendingApproval: false,
          pendingInterview: true,
          pendingFork: true,
          unreadFailure: true,
          unreadDone: true,
        },
      },
    };

    expect(mergeHostPendingForkIntoCloudIndicators(cloud, host, null)).toEqual({
      epics: cloud.epics,
      chats: {
        "chat-1": {
          pendingApproval: true,
          pendingInterview: false,
          pendingFork: true,
          unreadFailure: false,
          unreadDone: false,
        },
      },
    });
  });
});
