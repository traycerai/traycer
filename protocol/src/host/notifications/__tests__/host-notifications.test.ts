import { describe, expect, it } from "vitest";
import {
  hostRpcRegistry,
  hostStreamRpcRegistry,
} from "@traycer/protocol/host/registry";
import {
  HOST_NOTIFICATIONS_INDICATOR_BATCH_CAP,
  hostNotificationsClearAll,
  hostNotificationEntrySchema,
  hostNotificationsGetConfig,
  hostNotificationsIndicatorState,
  hostNotificationsList,
  hostNotificationsListRequestSchema,
  hostNotificationsMarkAllRead,
  hostNotificationsMarkRead,
  hostNotificationsSetConfig,
  hostNotificationsSubscribe,
  hostNotificationsSubscribeClientFrameSchema,
  hostNotificationsSubscribeServerFrameSchema,
  hostNotificationsSummarySchema,
} from "@traycer/protocol/host/notifications/contracts";

const APPROVAL_ENTRY = {
  id: "notification-1",
  updatedAt: 1_700_000_000_000,
  readAt: null,
  resolvedAt: null,
  epicId: "epic-1",
  chatId: "chat-1",
  kind: "approval.requested" as const,
  sourceRef: "approval-1",
  severity: "needs_action" as const,
  outcome: null,
  payload: {
    epicId: "epic-1",
    chatId: "chat-1",
    approvalId: "approval-1",
  },
};

const STOPPED_ENTRY = {
  id: "notification-2",
  updatedAt: 1_700_000_000_010,
  readAt: null,
  epicId: "epic-1",
  chatId: "chat-1",
  kind: "agent.stopped" as const,
  sourceRef: "agent-1",
  severity: "failure" as const,
  outcome: "errored" as const,
  payload: {
    epicId: "epic-1",
    chatId: "chat-1",
    agentId: "agent-1",
    outcome: "errored" as const,
    code: "rate_limit",
    message: "rate limit reached",
  },
};


const WORKSPACE_OPERATION_FAILED_ENTRY = {
  ...STOPPED_ENTRY,
  id: "notification-3",
  kind: "workspace.operation.failed" as const,
  sourceRef: "setup-event-1",
  payload: {
    kind: "workspace_operation_failed",
    epicId: "epic-1",
    chatId: "chat-1",
    chatTitle: "Deploy checkout fix",
    taskTitle: "Checkout notifications",
    operation: "setup",
    title: "Workspace setup failed",
    message: "Setup exited with code 1.",
    outcome: "errored" as const,
  },
};

const SUMMARY = { unreadCount: 2, attentionCount: 1 } as const;

const ATTENTION_CURSOR = {
  kind: "attention" as const,
  tier: "blocking" as const,
  updatedAt: 1_700_000_000_000,
  id: "notification-1",
};

const CHRONOLOGICAL_CURSOR = {
  kind: "chronological" as const,
  updatedAt: 1_700_000_000_010,
  id: "notification-2",
};

describe("flat host notification entry schema", () => {
  it("parses complete needs-action and failure entries", () => {
    expect(hostNotificationEntrySchema.parse(APPROVAL_ENTRY)).toEqual(
      APPROVAL_ENTRY,
    );
    expect(hostNotificationEntrySchema.parse(STOPPED_ENTRY)).toEqual(
      STOPPED_ENTRY,
    );
    expect(
      hostNotificationEntrySchema.parse(WORKSPACE_OPERATION_FAILED_ENTRY),
    ).toEqual(WORKSPACE_OPERATION_FAILED_ENTRY);
  });

  it("requires unresolved-state metadata on needs-action rows", () => {
    const { resolvedAt: _resolvedAt, ...entryWithoutResolvedAt } =
      APPROVAL_ENTRY;
    expect(() =>
      hostNotificationEntrySchema.parse(entryWithoutResolvedAt),
    ).toThrow();
  });

  it("keeps agent.stalled aligned with the persisted errored outcome", () => {
    expect(
      hostNotificationEntrySchema.parse({
        ...STOPPED_ENTRY,
        id: "notification-3",
        kind: "agent.stalled",
        outcome: "errored",
        payload: { agentId: "agent-1", reason: "provider_throttle" },
      }).outcome,
    ).toBe("errored");
    expect(() =>
      hostNotificationEntrySchema.parse({
        ...STOPPED_ENTRY,
        id: "notification-3",
        kind: "agent.stalled",
        outcome: null,
        payload: { agentId: "agent-1", reason: "provider_throttle" },
      }),
    ).toThrow();
  });

  it("keeps workspace failures aligned with the persisted errored outcome", () => {
    expect(
      hostNotificationEntrySchema.parse(WORKSPACE_OPERATION_FAILED_ENTRY)
        .outcome,
    ).toBe("errored");
    expect(() =>
      hostNotificationEntrySchema.parse({
        ...WORKSPACE_OPERATION_FAILED_ENTRY,
        outcome: null,
      }),
    ).toThrow();
  });
});

describe("host.notifications.list@1.0", () => {
  it("parses the complete entry surface on the one flat version", () => {
    expect(
      hostNotificationsList.responseSchema.parse({
        entries: [APPROVAL_ENTRY, STOPPED_ENTRY],
        nextCursor: null,
      }),
    ).toEqual({ entries: [APPROVAL_ENTRY, STOPPED_ENTRY], nextCursor: null });
  });

  it("accepts matching filter/cursor pairings", () => {
    expect(
      hostNotificationsListRequestSchema.parse({
        filter: "attention",
        limit: 25,
        cursor: ATTENTION_CURSOR,
      }),
    ).toEqual({
      filter: "attention",
      limit: 25,
      cursor: ATTENTION_CURSOR,
    });
    expect(
      hostNotificationsListRequestSchema.parse({
        filter: "recent",
        limit: 25,
        cursor: CHRONOLOGICAL_CURSOR,
      }),
    ).toEqual({
      filter: "recent",
      limit: 25,
      cursor: CHRONOLOGICAL_CURSOR,
    });
    expect(
      hostNotificationsListRequestSchema.parse({
        filter: "unreadRecent",
        limit: 25,
        cursor: CHRONOLOGICAL_CURSOR,
      }),
    ).toEqual({
      filter: "unreadRecent",
      limit: 25,
      cursor: CHRONOLOGICAL_CURSOR,
    });
  });

  it("rejects mismatched filter/cursor pairs and legacy filters", () => {
    expect(
      hostNotificationsListRequestSchema.safeParse({
        filter: "attention",
        limit: 25,
        cursor: CHRONOLOGICAL_CURSOR,
      }).success,
    ).toBe(false);
    expect(
      hostNotificationsListRequestSchema.safeParse({
        filter: "recent",
        limit: 25,
        cursor: ATTENTION_CURSOR,
      }).success,
    ).toBe(false);
    expect(
      hostNotificationsListRequestSchema.safeParse({
        filter: "unreadRecent",
        limit: 25,
        cursor: ATTENTION_CURSOR,
      }).success,
    ).toBe(false);
    expect(
      hostNotificationsListRequestSchema.safeParse({
        filter: "all",
        limit: 25,
      }).success,
    ).toBe(false);
    expect(
      hostNotificationsListRequestSchema.safeParse({
        filter: "unread",
        limit: 25,
      }).success,
    ).toBe(false);
  });
});

describe("host.notifications.summary", () => {
  it("accepts nonnegative counts and rejects negatives", () => {
    expect(hostNotificationsSummarySchema.parse(SUMMARY)).toEqual(SUMMARY);
    expect(
      hostNotificationsSummarySchema.safeParse({
        unreadCount: -1,
        attentionCount: 0,
      }).success,
    ).toBe(false);
    expect(
      hostNotificationsSummarySchema.safeParse({
        unreadCount: 0,
        attentionCount: -1,
      }).success,
    ).toBe(false);
  });
});

describe("host.notifications.markRead@1.0", () => {
  it("uses an explicit ids/entity discriminant", () => {
    expect(
      hostNotificationsMarkRead.requestSchema.parse({
        kind: "ids",
        ids: ["notification-1"],
      }),
    ).toEqual({ kind: "ids", ids: ["notification-1"] });
    expect(
      hostNotificationsMarkRead.requestSchema.parse({
        kind: "entity",
        entity: { epicId: "epic-1" },
      }),
    ).toEqual({ kind: "entity", entity: { epicId: "epic-1" } });
    expect(() =>
      hostNotificationsMarkRead.requestSchema.parse({
        ids: ["notification-1"],
      }),
    ).toThrow();
  });
});

describe("host.notifications.clearAll@1.0", () => {
  it("uses a timestamp boundary so newer notifications survive", () => {
    expect(
      hostNotificationsClearAll.requestSchema.parse({
        beforeUpdatedAt: 1_700_000_000_000,
      }),
    ).toEqual({ beforeUpdatedAt: 1_700_000_000_000 });
  });
});

describe("host.notifications.indicatorState@1.0", () => {
  it("accepts bounded separate epic and chat batches", () => {
    expect(
      hostNotificationsIndicatorState.requestSchema.parse({
        epicIds: ["epic-1"],
        chatIds: ["chat-1"],
      }),
    ).toEqual({ epicIds: ["epic-1"], chatIds: ["chat-1"] });
    expect(
      hostNotificationsIndicatorState.responseSchema.parse({
        epics: {
          "epic-1": {
            pendingApproval: true,
            pendingInterview: false,
            unreadFailure: false,
            unreadDone: false,
          },
        },
        chats: {},
      }),
    ).toBeDefined();
    expect(() =>
      hostNotificationsIndicatorState.requestSchema.parse({
        epicIds: Array.from(
          { length: HOST_NOTIFICATIONS_INDICATOR_BATCH_CAP + 1 },
          (_, index) => `epic-${index}`,
        ),
        chatIds: [],
      }),
    ).toThrow();
  });

  it("rejects the unreleased pendingPrompt response shape", () => {
    expect(
      hostNotificationsIndicatorState.responseSchema.safeParse({
        epics: {
          "epic-1": {
            pendingPrompt: true,
            unreadFailure: false,
            unreadDone: false,
          },
        },
        chats: {},
      }).success,
    ).toBe(false);
  });
});

describe("host.notifications.subscribe@1.0", () => {
  it("parses dual initial limits and rejects the legacy open request", () => {
    expect(
      hostNotificationsSubscribe.openRequestSchema.parse({
        initialAttentionLimit: 50,
        initialRecentLimit: 50,
      }),
    ).toEqual({ initialAttentionLimit: 50, initialRecentLimit: 50 });
    expect(
      hostNotificationsSubscribe.openRequestSchema.safeParse({
        filter: "all",
        initialLimit: 50,
      }).success,
    ).toBe(false);
  });

  it("round-trips the atomic snapshot shape", () => {
    const snapshot = hostNotificationsSubscribeServerFrameSchema.parse({
      kind: "snapshot",
      hasBinaryPayload: false,
      attention: {
        entries: [APPROVAL_ENTRY],
        nextCursor: ATTENTION_CURSOR,
      },
      recent: {
        entries: [STOPPED_ENTRY],
        nextCursor: CHRONOLOGICAL_CURSOR,
      },
      summary: SUMMARY,
    });
    expect(snapshot.kind).toBe("snapshot");
    if (snapshot.kind !== "snapshot") {
      throw new Error("expected snapshot frame");
    }
    expect(snapshot.attention.entries).toEqual([APPROVAL_ENTRY]);
    expect(snapshot.recent.entries).toEqual([STOPPED_ENTRY]);
    expect(snapshot.summary).toEqual(SUMMARY);
  });

  it("round-trips each lifecycle frame with removedIds and summary", () => {
    expect(
      hostNotificationsSubscribeServerFrameSchema.parse({
        kind: "upserted",
        hasBinaryPayload: false,
        entry: STOPPED_ENTRY,
        removedIds: ["pruned-1"],
        summary: SUMMARY,
      }),
    ).toMatchObject({
      kind: "upserted",
      removedIds: ["pruned-1"],
      summary: SUMMARY,
    });

    expect(
      hostNotificationsSubscribeServerFrameSchema.parse({
        kind: "readStateChanged",
        hasBinaryPayload: false,
        ids: ["notification-1"],
        entityRefs: [{ epicId: "epic-1", chatId: "chat-1" }],
        readAt: 1_700_000_000_001,
        resolvedAt: 1_700_000_000_001,
        removedIds: [],
        summary: SUMMARY,
      }).kind,
    ).toBe("readStateChanged");

    const legacyReadState = hostNotificationsSubscribeServerFrameSchema.parse({
      kind: "readStateChanged",
      hasBinaryPayload: false,
      ids: ["legacy-notification-1"],
      entityRefs: [],
      readAt: 1_700_000_000_001,
      resolvedAt: null,
      removedIds: [],
      summary: { unreadCount: 0, attentionCount: 0 },
    });
    if (legacyReadState.kind !== "readStateChanged") {
      throw new Error("expected read-state frame");
    }
    expect(legacyReadState.entityRefs).toEqual([]);

    expect(
      hostNotificationsSubscribeServerFrameSchema.parse({
        kind: "removed",
        hasBinaryPayload: false,
        removedIds: ["pruned-only"],
        summary: { unreadCount: 0, attentionCount: 0 },
      }),
    ).toMatchObject({
      kind: "removed",
      removedIds: ["pruned-only"],
    });

    expect(
      hostNotificationsSubscribeServerFrameSchema.parse({
        kind: "cleared",
        hasBinaryPayload: false,
        beforeUpdatedAt: 1_700_000_000_000,
        removedIds: ["notification-1"],
        summary: { unreadCount: 0, attentionCount: 0 },
      }).kind,
    ).toBe("cleared");
  });

  it("rejects duplicate removedIds and malformed lifecycle frames", () => {
    expect(
      hostNotificationsSubscribeServerFrameSchema.safeParse({
        kind: "upserted",
        hasBinaryPayload: false,
        entry: STOPPED_ENTRY,
        removedIds: ["dup", "dup"],
        summary: SUMMARY,
      }).success,
    ).toBe(false);
    expect(
      hostNotificationsSubscribeServerFrameSchema.safeParse({
        kind: "removed",
        hasBinaryPayload: false,
        removedIds: [],
        summary: SUMMARY,
      }).success,
    ).toBe(false);
    expect(
      hostNotificationsSubscribeServerFrameSchema.safeParse({
        kind: "removed",
        hasBinaryPayload: false,
        removedIds: ["a", "a"],
        summary: SUMMARY,
      }).success,
    ).toBe(false);
    expect(
      hostNotificationsSubscribeServerFrameSchema.safeParse({
        kind: "cleared",
        hasBinaryPayload: false,
        beforeUpdatedAt: 1_700_000_000_000,
        removedIds: ["x", "x"],
        summary: SUMMARY,
      }).success,
    ).toBe(false);
    expect(
      hostNotificationsSubscribeServerFrameSchema.safeParse({
        kind: "snapshot",
        hasBinaryPayload: false,
        entries: [APPROVAL_ENTRY],
      }).success,
    ).toBe(false);
    expect(
      hostNotificationsSubscribeServerFrameSchema.safeParse({
        kind: "upserted",
        hasBinaryPayload: false,
        entry: STOPPED_ENTRY,
      }).success,
    ).toBe(false);
    expect(
      hostNotificationsSubscribeServerFrameSchema.safeParse({
        kind: "readStateChanged",
        hasBinaryPayload: false,
        ids: ["notification-1"],
        entityRefs: [],
        readAt: 1,
        resolvedAt: null,
        summary: { unreadCount: -1, attentionCount: 0 },
        removedIds: [],
      }).success,
    ).toBe(false);
  });

  it("parses emission, presence, and pong frames", () => {
    expect(
      hostNotificationsSubscribeServerFrameSchema.parse({
        kind: "channelEmission",
        hasBinaryPayload: false,
        emissionId: "emission-1",
        channelId: "renderer",
        severity: "failure",
        rows: [STOPPED_ENTRY],
        reason: "new",
      }).kind,
    ).toBe("channelEmission");
    expect(
      hostNotificationsSubscribeClientFrameSchema.parse({
        kind: "presence",
        hasBinaryPayload: false,
        windowId: "window-1",
        focused: true,
        entity: { epicId: "epic-1", chatId: "chat-1" },
        at: 1_700_000_000_030,
      }).kind,
    ).toBe("presence");
    expect(
      hostNotificationsSubscribeServerFrameSchema.parse({
        kind: "pong",
        hasBinaryPayload: false,
      }).kind,
    ).toBe("pong");
  });
});

describe("host.notifications registry membership", () => {
  it("registers one flat unary contract per method", () => {
    expect(
      hostRpcRegistry["host.notifications.list"][1].versions[0].contract,
    ).toBe(hostNotificationsList);
    expect(
      hostRpcRegistry["host.notifications.getConfig"][1].versions[0].contract,
    ).toBe(hostNotificationsGetConfig);
    expect(
      hostRpcRegistry["host.notifications.setConfig"][1].versions[0].contract,
    ).toBe(hostNotificationsSetConfig);
    expect(
      hostRpcRegistry["host.notifications.markRead"][1].versions[0].contract,
    ).toBe(hostNotificationsMarkRead);
    expect(
      hostRpcRegistry["host.notifications.markAllRead"][1].versions[0].contract,
    ).toBe(hostNotificationsMarkAllRead);
    expect(
      hostRpcRegistry["host.notifications.indicatorState"][1].versions[0]
        .contract,
    ).toBe(hostNotificationsIndicatorState);
  });

  it("registers the full stream without colliding with global notifications.subscribe", () => {
    expect(hostStreamRpcRegistry["notifications.subscribe"]).toBeDefined();
    expect(
      hostStreamRpcRegistry["host.notifications.subscribe"][1].versions[0]
        .contract,
    ).toBe(hostNotificationsSubscribe);
  });
});
