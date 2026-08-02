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
  hostNotificationsListV10,
  hostNotificationsListV20,
  hostNotificationsListRequestSchema,
  hostNotificationsListRequestSchemaV10,
  hostNotificationsListResponseSchema,
  hostNotificationsListResponseSchemaV10,
  hostNotificationsListUpgradeV10ToV20,
  hostNotificationsListDowngradeV21ToV10,
  hostNotificationsMarkAllRead,
  hostNotificationsMarkRead,
  hostNotificationsSetConfig,
  hostNotificationsSubscribeV10,
  hostNotificationsFeedSubscribeV10,
  hostNotificationsCloudFeedSubscribeV10,
  hostNotificationsCloudFeedRowSchema,
  hostNotificationsCloudFeedSubscribeServerFrameSchemaV10,
  hostNotificationsCloudFeedEntryRequestSchema,
  hostNotificationsCloudFeedClearAllRequestSchema,
  hostNotificationsCloudFeedMutationResponseSchema,
  hostNotificationsCloudFeedMarkRead,
  hostNotificationsCloudFeedResolve,
  hostNotificationsCloudFeedClear,
  hostNotificationsCloudFeedClearAll,
  hostNotificationsSubscribeClientFrameSchema,
  hostNotificationsSubscribeServerFrameSchema,
  hostNotificationsSubscribeServerFrameSchemaV10,
  hostNotificationsSubscribeOpenRequestSchema,
  hostNotificationsSubscribeOpenRequestSchemaV10,
  hostNotificationsSummarySchema,
} from "@traycer/protocol/host/notifications/contracts";
import {
  buildStreamManifest,
  checkStreamMethodCompatibility,
} from "@traycer/protocol/framework/stream-compat";

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

describe("host.notifications.list@1.0 frozen all/unread surface", () => {
  it("parses the complete entry surface on the flat V10 response", () => {
    expect(
      hostNotificationsListResponseSchemaV10.parse({
        entries: [APPROVAL_ENTRY, STOPPED_ENTRY],
        nextCursor: null,
      }),
    ).toEqual({ entries: [APPROVAL_ENTRY, STOPPED_ENTRY], nextCursor: null });
  });

  it("accepts all/unread filters with flat keyset cursors", () => {
    expect(
      hostNotificationsListRequestSchemaV10.parse({
        filter: "all",
        limit: 25,
        cursor: { updatedAt: 1_700_000_000_000, id: "notification-1" },
      }),
    ).toEqual({
      filter: "all",
      limit: 25,
      cursor: { updatedAt: 1_700_000_000_000, id: "notification-1" },
    });
    expect(
      hostNotificationsListRequestSchemaV10.parse({
        filter: "unread",
        limit: 10,
      }),
    ).toEqual({ filter: "unread", limit: 10 });
  });

  it("rejects native V20 filters on the frozen V10 request", () => {
    expect(
      hostNotificationsListRequestSchemaV10.safeParse({
        filter: "attention",
        limit: 25,
      }).success,
    ).toBe(false);
    expect(
      hostNotificationsListRequestSchemaV10.safeParse({
        filter: "recent",
        limit: 25,
      }).success,
    ).toBe(false);
  });
});

describe("host.notifications.list@2.0 native projections", () => {
  it("parses the complete entry surface on the native response", () => {
    expect(
      hostNotificationsListResponseSchema.parse({
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

describe("host.notifications.list V10↔V20 upgrade/downgrade bridges", () => {
  it("upgrades all/unread requests onto recent/unreadRecent with chronological cursors", () => {
    expect(
      hostNotificationsListUpgradeV10ToV20.upgradeRequest({
        filter: "all",
        limit: 25,
        cursor: { updatedAt: 1_700_000_000_000, id: "notification-1" },
      }),
    ).toEqual({
      filter: "recent",
      limit: 25,
      cursor: {
        kind: "chronological",
        updatedAt: 1_700_000_000_000,
        id: "notification-1",
      },
    });
    expect(
      hostNotificationsListUpgradeV10ToV20.upgradeRequest({
        filter: "unread",
        limit: 10,
      }),
    ).toEqual({ filter: "unreadRecent", limit: 10 });
  });

  it("upgrades flat response cursors onto chronological cursors", () => {
    expect(
      hostNotificationsListUpgradeV10ToV20.upgradeResponse({
        entries: [STOPPED_ENTRY],
        nextCursor: { updatedAt: 1_700_000_000_010, id: "notification-2" },
      }),
    ).toEqual({
      entries: [STOPPED_ENTRY],
      nextCursor: {
        kind: "chronological",
        updatedAt: 1_700_000_000_010,
        id: "notification-2",
      },
    });
    expect(
      hostNotificationsListUpgradeV10ToV20.upgradeResponse({
        entries: [],
        nextCursor: null,
      }),
    ).toEqual({ entries: [], nextCursor: null });
  });

  it("downgrades recent/unreadRecent onto all/unread and strips cursor kind", () => {
    expect(
      hostNotificationsListDowngradeV21ToV10.downgradeRequest({
        filter: "recent",
        limit: 25,
        cursor: CHRONOLOGICAL_CURSOR,
      }),
    ).toEqual({
      ok: true,
      value: {
        filter: "all",
        limit: 25,
        cursor: {
          updatedAt: CHRONOLOGICAL_CURSOR.updatedAt,
          id: CHRONOLOGICAL_CURSOR.id,
        },
      },
    });
    expect(
      hostNotificationsListDowngradeV21ToV10.downgradeRequest({
        filter: "unreadRecent",
        limit: 10,
      }),
    ).toEqual({
      ok: true,
      value: { filter: "unread", limit: 10 },
    });
  });

  it("downgrades response cursors by stripping kind", () => {
    expect(
      hostNotificationsListDowngradeV21ToV10.downgradeResponse({
        entries: [STOPPED_ENTRY],
        nextCursor: CHRONOLOGICAL_CURSOR,
      }),
    ).toEqual({
      ok: true,
      value: {
        entries: [STOPPED_ENTRY],
        nextCursor: {
          updatedAt: CHRONOLOGICAL_CURSOR.updatedAt,
          id: CHRONOLOGICAL_CURSOR.id,
        },
      },
    });
  });

  it("rejects attention downgrade with a structured unsupported error", () => {
    expect(
      hostNotificationsListDowngradeV21ToV10.downgradeRequest({
        filter: "attention",
        limit: 25,
        cursor: ATTENTION_CURSOR,
      }),
    ).toEqual({
      ok: false,
      error: {
        code: "DOWNGRADE_UNSUPPORTED",
        message:
          "The attention projection has no representation in host.notifications.list@1.0",
      },
    });
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
        entity: { epicId: "epic-1", chatId: "chat-1" },
      }),
    ).toEqual({
      kind: "entity",
      entity: { epicId: "epic-1", chatId: "chat-1" },
    });
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
      hostNotificationsIndicatorState.requestSchema.safeParse({
        epicIds: Array.from(
          { length: HOST_NOTIFICATIONS_INDICATOR_BATCH_CAP + 1 },
          (_, i) => `epic-${i}`,
        ),
        chatIds: [],
      }).success,
    ).toBe(false);
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

describe("host.notifications.subscribe@1.0 frozen legacy stream", () => {
  it("parses the released open request and rejects dual-limit feed shape", () => {
    expect(
      hostNotificationsSubscribeOpenRequestSchemaV10.parse({
        filter: "all",
        initialLimit: 50,
      }),
    ).toEqual({ filter: "all", initialLimit: 50 });
    expect(
      hostNotificationsSubscribeOpenRequestSchemaV10.parse({
        filter: "unread",
        initialLimit: 10,
      }),
    ).toEqual({ filter: "unread", initialLimit: 10 });
    expect(
      hostNotificationsSubscribeOpenRequestSchemaV10.safeParse({
        initialAttentionLimit: 50,
        initialRecentLimit: 50,
      }).success,
    ).toBe(false);
  });

  it("round-trips the flat released snapshot and lifecycle frames", () => {
    expect(
      hostNotificationsSubscribeServerFrameSchemaV10.parse({
        kind: "snapshot",
        hasBinaryPayload: false,
        entries: [APPROVAL_ENTRY, STOPPED_ENTRY],
      }),
    ).toMatchObject({
      kind: "snapshot",
      entries: [APPROVAL_ENTRY, STOPPED_ENTRY],
    });
    expect(
      hostNotificationsSubscribeServerFrameSchemaV10.parse({
        kind: "upserted",
        hasBinaryPayload: false,
        entry: STOPPED_ENTRY,
      }),
    ).toMatchObject({ kind: "upserted", entry: STOPPED_ENTRY });
    expect(
      hostNotificationsSubscribeServerFrameSchemaV10.parse({
        kind: "readStateChanged",
        hasBinaryPayload: false,
        ids: ["notification-1"],
        entityRefs: [{ epicId: "epic-1", chatId: "chat-1" }],
        readAt: 1_700_000_000_001,
        resolvedAt: null,
      }).kind,
    ).toBe("readStateChanged");
    expect(
      hostNotificationsSubscribeServerFrameSchemaV10.parse({
        kind: "cleared",
        hasBinaryPayload: false,
        beforeUpdatedAt: 1_700_000_000_000,
      }).kind,
    ).toBe("cleared");
  });

  it("rejects successor partitioned/snapshot and removal-only frames on the frozen schema", () => {
    expect(
      hostNotificationsSubscribeServerFrameSchemaV10.safeParse({
        kind: "snapshot",
        hasBinaryPayload: false,
        attention: { entries: [], nextCursor: null },
        recent: { entries: [], nextCursor: null },
        summary: SUMMARY,
      }).success,
    ).toBe(false);
    expect(
      hostNotificationsSubscribeServerFrameSchemaV10.safeParse({
        kind: "removed",
        hasBinaryPayload: false,
        removedIds: ["pruned-only"],
        summary: SUMMARY,
      }).success,
    ).toBe(false);
    // Zod object schemas strip unknown keys by default. Successor-only
    // fields on an otherwise-valid flat upserted frame must not survive
    // the frozen schema - the released shape is entry-only.
    const strippedUpsert = hostNotificationsSubscribeServerFrameSchemaV10.parse(
      {
        kind: "upserted",
        hasBinaryPayload: false,
        entry: STOPPED_ENTRY,
        removedIds: [],
        summary: SUMMARY,
      },
    );
    expect(strippedUpsert).toEqual({
      kind: "upserted",
      hasBinaryPayload: false,
      entry: STOPPED_ENTRY,
    });
    expect(strippedUpsert).not.toHaveProperty("removedIds");
    expect(strippedUpsert).not.toHaveProperty("summary");
  });
});

describe("host.notifications.feed.subscribe@1.0 successor stream", () => {
  it("parses dual initial limits and rejects the legacy open request", () => {
    expect(
      hostNotificationsSubscribeOpenRequestSchema.parse({
        initialAttentionLimit: 50,
        initialRecentLimit: 50,
      }),
    ).toEqual({ initialAttentionLimit: 50, initialRecentLimit: 50 });
    expect(
      hostNotificationsSubscribeOpenRequestSchema.safeParse({
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

describe("host.notifications.cloudFeed@1.0 immutable-entry surface", () => {
  const CLOUD_ROW = {
    entryId: "0195a1f0-7c2a-7b1e-9f3d-8a4c1e2b6d70",
    originHostId: "host-a",
    coalesceKey: "approval.requested:chat-1",
    entry: APPROVAL_ENTRY,
    presentation: { epicTitle: "Checkout", chatTitle: "Deploy fix" },
  };

  it("carries entryId, originHostId and coalesceKey on a row - and nothing occurrence-shaped", () => {
    const row = hostNotificationsCloudFeedRowSchema.parse(CLOUD_ROW);

    expect(row.entryId).toBe("0195a1f0-7c2a-7b1e-9f3d-8a4c1e2b6d70");
    expect(row.originHostId).toBe("host-a");
    expect(row.coalesceKey).toBe("approval.requested:chat-1");
    // The retired ordered-replication row fields must not survive parsing:
    // an occurrence token or a per-row revision would reintroduce exactly the
    // guards the immutable-entry model exists to delete.
    expect(Object.hasOwn(row, "occurrenceToken")).toBe(false);
    expect(Object.hasOwn(row, "feedRevision")).toBe(false);
    expect(Object.hasOwn(row, "notificationId")).toBe(false);
  });

  it("treats entryId as opaque - any non-empty string parses, no UUID shape imposed on the client", () => {
    expect(
      hostNotificationsCloudFeedRowSchema.parse({
        ...CLOUD_ROW,
        entryId: "migration-minted-id",
      }).entryId,
    ).toBe("migration-minted-id");
    expect(
      hostNotificationsCloudFeedRowSchema.safeParse({
        ...CLOUD_ROW,
        entryId: "",
      }).success,
    ).toBe(false);
  });

  it("admits only snapshot, connectionState and pong server frames", () => {
    const snapshot =
      hostNotificationsCloudFeedSubscribeServerFrameSchemaV10.parse({
        kind: "snapshot",
        hasBinaryPayload: false,
        connectionState: "connected",
        version: 7,
        rows: [CLOUD_ROW],
        summary: { totalCount: 1, unreadCount: 1, attentionCount: 1 },
      });
    expect(snapshot.kind === "snapshot" ? snapshot.version : null).toBe(7);
    expect(
      hostNotificationsCloudFeedSubscribeServerFrameSchemaV10.parse({
        kind: "connectionState",
        hasBinaryPayload: false,
        connectionState: "reconnecting",
      }).kind,
    ).toBe("connectionState");
    // No incremental frames exist. A client that cannot apply a delta cannot
    // apply one out of order, drop one, or double-apply one.
    expect(
      hostNotificationsCloudFeedSubscribeServerFrameSchemaV10.safeParse({
        kind: "changes",
        hasBinaryPayload: false,
        connectionState: "connected",
        version: 8,
        rows: [],
        removals: [],
        summary: { totalCount: 0, unreadCount: 0, attentionCount: 0 },
      }).success,
    ).toBe(false);
  });

  it("addresses a per-entry mutation by entryId alone", () => {
    expect(
      hostNotificationsCloudFeedEntryRequestSchema.parse({
        entryId: "entry-1",
        occurrenceToken: "token-1",
        idempotencyKey: "key-1",
      }),
    ).toEqual({ entryId: "entry-1" });
    expect(
      hostNotificationsCloudFeedEntryRequestSchema.safeParse({}).success,
    ).toBe(false);
  });

  it("bounds clearAll by the observed version, and allows the unbounded null form", () => {
    expect(
      hostNotificationsCloudFeedClearAllRequestSchema.parse({
        observedVersion: 12,
      }).observedVersion,
    ).toBe(12);
    expect(
      hostNotificationsCloudFeedClearAllRequestSchema.parse({
        observedVersion: null,
      }).observedVersion,
    ).toBeNull();
    expect(
      hostNotificationsCloudFeedClearAllRequestSchema.safeParse({
        observedVersion: -1,
      }).success,
    ).toBe(false);
  });

  it("answers a mutation with a status and a version that is null exactly when unavailable", () => {
    expect(
      hostNotificationsCloudFeedMutationResponseSchema.parse({
        status: "applied",
        version: 9,
      }),
    ).toEqual({ status: "applied", version: 9 });
    expect(
      hostNotificationsCloudFeedMutationResponseSchema.parse({
        status: "unavailable",
        version: null,
      }),
    ).toEqual({ status: "unavailable", version: null });
    expect(
      hostNotificationsCloudFeedMutationResponseSchema.safeParse({
        status: "applied",
        version: null,
      }).success,
    ).toBe(false);
    expect(
      hostNotificationsCloudFeedMutationResponseSchema.safeParse({
        status: "unavailable",
        version: 9,
      }).success,
    ).toBe(false);
  });

  it("registers the whole family on the unary registry as optional methods", () => {
    expect(
      hostRpcRegistry["host.notifications.cloudFeed.markRead"][1].versions[0]
        .contract,
    ).toBe(hostNotificationsCloudFeedMarkRead);
    expect(
      hostRpcRegistry["host.notifications.cloudFeed.resolve"][1].versions[0]
        .contract,
    ).toBe(hostNotificationsCloudFeedResolve);
    expect(
      hostRpcRegistry["host.notifications.cloudFeed.clear"][1].versions[0]
        .contract,
    ).toBe(hostNotificationsCloudFeedClear);
    expect(
      hostRpcRegistry["host.notifications.cloudFeed.clearAll"][1].versions[0]
        .contract,
    ).toBe(hostNotificationsCloudFeedClearAll);
    for (const method of [
      "host.notifications.cloudFeed.markRead",
      "host.notifications.cloudFeed.resolve",
      "host.notifications.cloudFeed.clear",
      "host.notifications.cloudFeed.clearAll",
    ] as const) {
      expect(hostRpcRegistry[method].degrade).toEqual({ kind: "unsupported" });
    }
  });
});

describe("host.notifications registry membership", () => {
  it("registers list majors 1 and 2 with the V10↔V20 upgrade/downgrade bridges", () => {
    expect(
      hostRpcRegistry["host.notifications.list"][1].versions[0].contract,
    ).toBe(hostNotificationsListV10);
    expect(
      hostRpcRegistry["host.notifications.list"][2].versions[0].contract,
    ).toBe(hostNotificationsListV20);
    expect(
      hostRpcRegistry["host.notifications.list"][2].versions[0]
        .upgradeFromPreviousVersion,
    ).toBe(hostNotificationsListUpgradeV10ToV20);
    expect(
      hostRpcRegistry["host.notifications.list"][2].downgradePathsFromLatest[1],
    ).toBe(hostNotificationsListDowngradeV21ToV10);
  });

  it("registers one flat unary contract per non-list method", () => {
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

  it("keeps the released feed stream canonical and advertises cloud feed as an optional method", () => {
    expect(hostStreamRpcRegistry["notifications.subscribe"]).toBeDefined();
    expect(
      hostStreamRpcRegistry["host.notifications.subscribe"][1].versions[0]
        .contract,
    ).toBe(hostNotificationsSubscribeV10);
    expect(
      hostStreamRpcRegistry["host.notifications.feed.subscribe"][1].versions[0]
        .contract,
    ).toBe(hostNotificationsFeedSubscribeV10);
    expect(
      Object.hasOwn(hostStreamRpcRegistry["host.notifications.feed.subscribe"], "2"),
    ).toBe(false);
    expect(
      hostStreamRpcRegistry["host.notifications.cloudFeed.subscribe"][1]
        .versions[0].contract,
    ).toBe(hostNotificationsCloudFeedSubscribeV10);
  });

  it("keeps the local-feed method compatible in both directions while cloud feed remains explicitly unsupported by an old peer", () => {
    const currentManifest = buildStreamManifest(hostStreamRpcRegistry);
    const { ["host.notifications.cloudFeed.subscribe"]: _cloudFeed, ...oldManifest } =
      currentManifest;

    expect(
      checkStreamMethodCompatibility(
        hostStreamRpcRegistry,
        currentManifest,
        oldManifest,
        "host",
        "host.notifications.feed.subscribe",
      ),
    ).toEqual({ ok: true });
    expect(
      checkStreamMethodCompatibility(
        hostStreamRpcRegistry,
        oldManifest,
        currentManifest,
        "client",
        "host.notifications.feed.subscribe",
      ),
    ).toEqual({ ok: true });
    expect(
      checkStreamMethodCompatibility(
        hostStreamRpcRegistry,
        currentManifest,
        oldManifest,
        "client",
        "host.notifications.cloudFeed.subscribe",
      ),
    ).toMatchObject({
      ok: false,
      details: { code: "INCOMPATIBLE", upgradeGuidance: { hostShouldUpgrade: true } },
    });
  });
});
