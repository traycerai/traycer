import { describe, expect, it } from "vitest";
import type {
  HostNotificationsCloudFeedRow,
  HostNotificationsCloudFeedRowV15,
  HostNotificationsIndicatorState,
  HostNotificationsIndicatorStateResponse,
} from "@traycer/protocol/host/notifications/contracts";
import {
  indicatorHasUnread,
  mergeHostPendingForkIntoCloudIndicators,
  mergeLocalPartitionIntoCloudIndicators,
  selectCloudNotificationIndicatorProjection,
  selectCloudNotificationIndicators,
  selectNotificationIndicatorState,
} from "@/stores/notifications/notification-indicator-state";

/** An entity whose unread rows light no glyph: they are counted and nothing
 * else. `null` is a host that does not count. */
function counted(unreadCount: number | null): HostNotificationsIndicatorState {
  return {
    pendingApproval: false,
    pendingInterview: false,
    pendingFork: false,
    unreadFailure: false,
    unreadDone: false,
    unreadCount,
  };
}

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
            unreadCount: 1,
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

  /** A bot's answer: the `done` row the host mints once per participant, on
   * the bot's epic and the thread's chat. */
  function botAnswer(
    entryId: string,
    threadId: string,
    readAt: number | null,
  ): HostNotificationsCloudFeedRowV15 {
    return {
      entryId,
      originHostId: "host-b",
      coalesceKey: `host.operation.finished:${entryId}`,
      entry: {
        id: entryId,
        updatedAt: 1,
        readAt,
        kind: "host.operation.finished",
        sourceRef: null,
        severity: "done",
        outcome: "completed",
        epicId: "bot-1",
        chatId: threadId,
        payload: {
          kind: "bot_thread_verdict",
          operation: "bot.thread.verdict",
          title: "Tracy answered",
          message: "Your question about the release",
          botId: "bot-1",
          threadId,
          replyMessageId: entryId,
        },
      },
      presentation: { epicTitle: null, chatTitle: null },
    };
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
    rows: ReadonlyArray<HostNotificationsCloudFeedRowV15>,
  ): Record<string, HostNotificationsCloudFeedRowV15> {
    return Object.fromEntries(rows.map((entry) => [entry.entryId, entry]));
  }

  it("does not light the chat's approval glyph for an unresolved browser prompt, though its unread row is counted", () => {
    const browserRow: HostNotificationsCloudFeedRowV15 = {
      entryId: "browser-1",
      originHostId: "host-b",
      coalesceKey: "browser.human.needed:chat-1",
      entry: {
        id: "browser-1",
        updatedAt: 1,
        readAt: null,
        kind: "browser.human.needed",
        sourceRef: null,
        severity: "needs_action",
        outcome: null,
        resolvedAt: null,
        epicId: "epic-1",
        chatId: "chat-1",
        payload: {
          kind: "browser_human_needed",
          epicId: "epic-1",
          chatId: "chat-1",
          sessionId: "session-1",
          tabId: "tab-1",
          reason: "sign in",
        },
      },
      presentation: { epicTitle: null, chatTitle: null },
    };
    const result = selectCloudNotificationIndicators(
      { "browser-1": browserRow },
      ["epic-1"],
      ["chat-1"],
    );

    expect(result.chats).toEqual({ "chat-1": counted(1) });
    expect(result.epics).toEqual({ "epic-1": counted(1) });
  });

  it("uses the origin's durable terminal ordering cursor", () => {
    const result = selectCloudNotificationIndicators(
      rowsById([
        stoppedAt({
          entryId: "0001-failure-unread",
          severity: "failure",
          readAt: null,
          updatedAt: 1,
          chatId: "chat-1",
        }),
        stoppedAt({
          entryId: "0002-done-unread",
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
      unreadCount: 2,
    });
  });

  it("keeps a newer failure above an older completion", () => {
    const result = selectCloudNotificationIndicators(
      rowsById([
        stoppedAt({
          entryId: "0001-done-unread",
          severity: "done",
          readAt: null,
          updatedAt: 1,
          chatId: "chat-1",
        }),
        stoppedAt({
          entryId: "0002-failure-unread",
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
      unreadCount: 2,
    });
  });

  it("lets a later completion own the glyph while retaining the failure row", () => {
    const failure = stoppedAt({
      entryId: "0001-workspace-failure",
      severity: "failure",
      readAt: null,
      updatedAt: 1,
      chatId: "chat-1",
    });
    const done = stoppedAt({
      entryId: "0002-agent-done",
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
      unreadFailure: false,
      unreadDone: true,
    });
    expect(result.chats["chat-1"]).toMatchObject({
      unreadFailure: false,
      unreadDone: true,
    });
  });

  it("lets a silent automatic recovery clear Error without replacing it with Done, the failure row still counted", () => {
    const failure = stoppedAt({
      entryId: "0001-agent-failure",
      severity: "failure",
      readAt: null,
      updatedAt: 1,
      chatId: "chat-1",
    });
    const recovery = stoppedAt({
      entryId: "0002-agent-recovery",
      severity: "done",
      readAt: 2,
      updatedAt: 2,
      chatId: "chat-1",
    });
    const result = selectCloudNotificationIndicators(
      rowsById([
        failure,
        {
          ...recovery,
          entry: {
            ...recovery.entry,
            payload: {
              outcome: "completed",
              automaticRecovery: true,
            },
          },
        },
      ]),
      ["epic-1"],
      ["chat-1"],
    );

    expect(result).toEqual({
      epics: { "epic-1": counted(1) },
      chats: { "chat-1": counted(1) },
    });
  });

  it("does not let automatic recovery erase an unread Done", () => {
    const done = stoppedAt({
      entryId: "0001-agent-done",
      severity: "done",
      readAt: null,
      updatedAt: 1,
      chatId: "chat-1",
    });
    const recovery = stoppedAt({
      entryId: "0002-agent-recovery",
      severity: "done",
      readAt: 2,
      updatedAt: 2,
      chatId: "chat-1",
    });
    const result = selectCloudNotificationIndicators(
      rowsById([
        done,
        {
          ...recovery,
          entry: {
            ...recovery.entry,
            payload: {
              outcome: "completed",
              automaticRecovery: true,
            },
          },
        },
      ]),
      ["epic-1"],
      ["chat-1"],
    );

    expect(result.epics["epic-1"].unreadDone).toBe(true);
    expect(result.chats["chat-1"].unreadDone).toBe(true);
  });

  it("uses entry identity to break tied terminal timestamps", () => {
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
      unreadFailure: false,
      unreadDone: true,
      unreadCount: 2,
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
      unreadCount: 2,
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
          entryId: "0001-failure-unread",
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
      unreadCount: 2,
    });
  });

  it("promotes a host terminal failure to attention on an epic aggregate", () => {
    const result = selectNotificationIndicatorState(
      { byId: {} },
      { epicId: "epic-1" },
      null,
      {
        epics: {
          "epic-1": {
            pendingApproval: false,
            pendingInterview: false,
            pendingFork: false,
            unreadFailure: true,
            unreadDone: true,
            unreadCount: 1,
          },
        },
        chats: {},
      },
    );

    expect(result).toMatchObject({
      unreadFailure: true,
      unreadNonTerminalFailure: true,
      unreadTerminalFailure: false,
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

  it("keeps a read completion as the quiet winner over an older failure, which stays counted", () => {
    const result = selectCloudNotificationIndicators(
      rowsById([
        stoppedAt({
          entryId: "0001-failure-unread",
          severity: "failure",
          readAt: null,
          updatedAt: 1,
          chatId: "chat-1",
        }),
        stoppedAt({
          entryId: "0002-done-read",
          severity: "done",
          readAt: 3,
          updatedAt: 2,
          chatId: "chat-1",
        }),
      ]),
      ["epic-1"],
      ["chat-1"],
    );

    expect(result).toEqual({
      epics: { "epic-1": counted(1) },
      chats: { "chat-1": counted(1) },
    });
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
    expect(resolvedButUnread.chats["chat-1"]).toEqual(counted(1));
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
      unreadCount: 1,
    });
  });

  it("neither counts nor lights an unread info row, so the entity cannot read as unread", () => {
    const result = selectCloudNotificationIndicators(
      rowsById([stopped("info", "info", null)]),
      ["epic-1"],
      ["chat-1"],
    );
    const resolved = selectNotificationIndicatorState(
      { byId: {} },
      { epicId: "epic-1", chatId: "chat-1" },
      null,
      result,
    );

    expect(result).toEqual({ epics: {}, chats: {} });
    expect(resolved).toEqual({
      unreadFailure: false,
      unreadNonTerminalFailure: false,
      unreadTerminalFailure: false,
      pendingFork: false,
      pendingApproval: false,
      pendingInterview: false,
      unreadDone: false,
    });
  });

  it("counts only the rows reading the entity clears when an info row sits beside them", () => {
    const result = selectCloudNotificationIndicators(
      rowsById([stopped("info", "info", null), stopped("done", "done", null)]),
      ["epic-1"],
      ["chat-1"],
    );

    expect(result.chats["chat-1"].unreadCount).toBe(1);
    expect(result.epics["epic-1"].unreadCount).toBe(1);
  });

  it("counts each unread row on its epic and its chat, and gives a thread with only read rows no entry", () => {
    const result = selectCloudNotificationIndicators(
      rowsById([
        botAnswer("answer-1", "thread-1", null),
        botAnswer("answer-2", "thread-1", null),
        botAnswer("answer-3", "thread-1", 5),
        botAnswer("answer-4", "thread-2", 5),
      ]),
      ["bot-1"],
      ["thread-1", "thread-2"],
    );

    expect(result).toEqual({
      epics: { "bot-1": counted(2) },
      chats: { "thread-1": counted(2) },
    });
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

describe("an entity's unread count", () => {
  /** One origin's rows as the cloud holds them, on an epic and a chat. */
  function partition(
    count: number | null,
  ): HostNotificationsIndicatorStateResponse {
    return {
      epics: { "epic-1": counted(count) },
      chats: { "chat-1": counted(count) },
    };
  }

  it("counts a notification once when the retained cloud snapshot and the fallback host answer both hold it", () => {
    const merged = mergeLocalPartitionIntoCloudIndicators(
      { ...partition(1), byOriginHostId: { "host-a": partition(1) } },
      partition(1),
      "host-a",
      false,
    );

    expect(merged.epics).toEqual({ "epic-1": counted(1) });
    expect(merged.chats).toEqual({ "chat-1": counted(1) });
    expect(merged.byOriginHostId).toEqual({ "host-a": partition(1) });
  });

  it("keeps the cloud's count while its lane serves, whatever the host answers", () => {
    const merged = mergeLocalPartitionIntoCloudIndicators(
      {
        epics: { "epic-1": counted(2) },
        chats: {},
        byOriginHostId: {
          "host-a": { epics: { "epic-1": counted(2) }, chats: {} },
        },
      },
      {
        epics: {
          "epic-1": counted(5),
          "epic-2": { ...counted(4), pendingFork: true },
        },
        chats: {},
      },
      "host-a",
      true,
    );

    expect(merged.epics).toEqual({
      "epic-1": counted(2),
      "epic-2": { ...counted(0), pendingFork: true },
    });
    expect(merged.byOriginHostId?.["host-a"].epics["epic-1"]).toEqual(
      counted(2),
    );
  });

  it("lets the host's answer replace the bound origin's cloud count but keeps every other origin's rows", () => {
    const merged = mergeLocalPartitionIntoCloudIndicators(
      {
        ...partition(3),
        byOriginHostId: { "host-a": partition(1), "host-b": partition(2) },
      },
      partition(1),
      "host-a",
      false,
    );

    expect(merged.epics).toEqual({ "epic-1": counted(3) });
    expect(merged.byOriginHostId?.["host-a"]).toEqual(partition(1));
    expect(merged.byOriginHostId?.["host-b"]).toEqual(partition(2));
  });

  it("drops the bound origin's cloud rows from the count once the host has read them", () => {
    const merged = mergeLocalPartitionIntoCloudIndicators(
      {
        ...partition(3),
        byOriginHostId: { "host-a": partition(1), "host-b": partition(2) },
      },
      { epics: {}, chats: {} },
      "host-a",
      false,
    );

    expect(merged.epics).toEqual({ "epic-1": counted(2) });
    expect(merged.byOriginHostId?.["host-a"]).toEqual({
      epics: { "epic-1": counted(null) },
      chats: { "chat-1": counted(null) },
    });
  });

  it("leaves a host that does not count unknown where the cloud holds nothing", () => {
    const merged = mergeLocalPartitionIntoCloudIndicators(
      { epics: {}, chats: {}, byOriginHostId: { "host-a": partition(1) } },
      { epics: { "epic-9": counted(null) }, chats: {} },
      "host-a",
      false,
    );

    expect(merged.epics).toEqual({ "epic-9": counted(null) });
    expect(merged.byOriginHostId?.["host-a"].epics["epic-9"]).toEqual(
      counted(null),
    );
  });

  it("counts from the cloud alone when the host answers with no origin to attribute it to", () => {
    const merged = mergeLocalPartitionIntoCloudIndicators(
      partition(2),
      partition(1),
      null,
      false,
    );

    expect(merged.epics).toEqual({ "epic-1": counted(2) });
    expect(merged.chats).toEqual({ "chat-1": counted(2) });
  });

  it("ORs the flags across planes in either lane state", () => {
    const hostLit = {
      epics: { "epic-1": { ...counted(1), pendingFork: true } },
      chats: {},
    };
    const cloudLit = {
      epics: { "epic-1": { ...counted(1), unreadFailure: true } },
      chats: {},
      byOriginHostId: {
        "host-a": {
          epics: { "epic-1": { ...counted(1), unreadFailure: true } },
          chats: {},
        },
      },
    };

    for (const serving of [true, false]) {
      const merged = mergeLocalPartitionIntoCloudIndicators(
        cloudLit,
        hostLit,
        "host-a",
        serving,
      );
      expect(merged.epics["epic-1"]).toMatchObject({
        pendingFork: true,
        unreadFailure: true,
        unreadCount: 1,
      });
    }
  });

  it.each([
    { name: "a count above zero", state: counted(1), unread: true },
    { name: "a count of zero", state: counted(0), unread: false },
    { name: "no count and nothing lit", state: counted(null), unread: false },
    {
      name: "no count and an unread done",
      state: { ...counted(null), unreadDone: true },
      unread: true,
    },
    {
      name: "no count and an unread failure",
      state: { ...counted(null), unreadFailure: true },
      unread: true,
    },
  ])("reads $name as unread: $unread", ({ state, unread }) => {
    expect(indicatorHasUnread(state)).toBe(unread);
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
          unreadCount: 1,
        },
      },
      chats: {
        "chat-1": {
          pendingApproval: true,
          pendingInterview: false,
          pendingFork: false,
          unreadFailure: false,
          unreadDone: false,
          unreadCount: 1,
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
          unreadCount: 3,
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
          unreadCount: 1,
        },
      },
    });
  });
});
