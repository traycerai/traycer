import { describe, expect, it } from "vitest";
import type { HostNotificationsCloudFeedRow } from "@traycer/protocol/host/notifications/contracts";
import {
  mergeHostPendingForkIntoCloudIndicators,
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
      { epics: {}, chats: {} },
    );

    expect(state.unreadFailure).toBe(true);
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
      readAt: null,
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
      [],
    );

    expect(result.epics["epic-1"]).toEqual({
      pendingApproval: false,
      pendingInterview: false,
      pendingFork: false,
      unreadFailure: true,
      unreadDone: true,
    });
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

  it("pends an approval only while resolvedAt is null", () => {
    const unresolved = selectCloudNotificationIndicators(
      rowsById([prompt("approval", "approval.requested", null)]),
      [],
      ["chat-1"],
    );
    const resolved = selectCloudNotificationIndicators(
      rowsById([prompt("approval", "approval.requested", 9)]),
      [],
      ["chat-1"],
    );

    expect(unresolved.chats["chat-1"].pendingApproval).toBe(true);
    expect(resolved.chats["chat-1"]).toBeUndefined();
  });

  it("pends an interview independently of the approval arm", () => {
    const result = selectCloudNotificationIndicators(
      rowsById([prompt("interview", "interview.requested", null)]),
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

    expect(mergeHostPendingForkIntoCloudIndicators(cloud, host)).toEqual({
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
