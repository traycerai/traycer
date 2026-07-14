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

describe("flat host notification entry schema", () => {
  it("parses complete needs-action and failure entries", () => {
    expect(hostNotificationEntrySchema.parse(APPROVAL_ENTRY)).toEqual(
      APPROVAL_ENTRY,
    );
    expect(hostNotificationEntrySchema.parse(STOPPED_ENTRY)).toEqual(
      STOPPED_ENTRY,
    );
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

  it("parses all/unread filters and keyset cursors", () => {
    expect(
      hostNotificationsListRequestSchema.parse({
        filter: "unread",
        limit: 25,
        cursor: { updatedAt: 1_700_000_000_000, id: "notification-1" },
      }),
    ).toEqual({
      filter: "unread",
      limit: 25,
      cursor: { updatedAt: 1_700_000_000_000, id: "notification-1" },
    });
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
            pendingPrompt: true,
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
});

describe("host.notifications.subscribe@1.0", () => {
  it("parses the full feed, emission, presence, and entity-bearing state frames", () => {
    expect(
      hostNotificationsSubscribe.openRequestSchema.parse({
        filter: "all",
        initialLimit: 50,
      }),
    ).toEqual({ filter: "all", initialLimit: 50 });
    expect(
      hostNotificationsSubscribeServerFrameSchema.parse({
        kind: "readStateChanged",
        hasBinaryPayload: false,
        ids: ["notification-1"],
        entityRefs: [{ epicId: "epic-1", chatId: "chat-1" }],
        readAt: 1_700_000_000_001,
        resolvedAt: 1_700_000_000_001,
      }).kind,
    ).toBe("readStateChanged");
    const legacyReadState = hostNotificationsSubscribeServerFrameSchema.parse({
      kind: "readStateChanged",
      hasBinaryPayload: false,
      ids: ["legacy-notification-1"],
      entityRefs: [],
      readAt: 1_700_000_000_001,
      resolvedAt: null,
    });
    if (legacyReadState.kind !== "readStateChanged") {
      throw new Error("expected read-state frame");
    }
    expect(legacyReadState.entityRefs).toEqual([]);
    expect(
      hostNotificationsSubscribeServerFrameSchema.parse({
        kind: "cleared",
        hasBinaryPayload: false,
        beforeUpdatedAt: 1_700_000_000_000,
      }).kind,
    ).toBe("cleared");
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
