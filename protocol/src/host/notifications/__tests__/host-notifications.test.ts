import { describe, expect, it } from "vitest";
import {
  hostRpcRegistry,
  hostStreamRpcRegistry,
} from "@traycer/protocol/host/registry";
import {
  hostNotificationEntryV11Schema,
  hostNotificationEntrySchema,
  hostNotificationsConfigResponseSchema,
  hostNotificationsGetConfigV10,
  hostNotificationsListRequestSchema,
  hostNotificationsListV10,
  hostNotificationsListV11,
  hostNotificationsMarkAllReadV10,
  hostNotificationsMarkReadV10,
  hostNotificationsSetConfigV10,
  hostNotificationsSubscribeClientFrameV11Schema,
  hostNotificationsSubscribeClientFrameSchema,
  hostNotificationsSubscribeServerFrameV11Schema,
  hostNotificationsSubscribeServerFrameSchema,
  hostNotificationsSubscribeV10,
  hostNotificationsSubscribeV11,
} from "@traycer/protocol/host/notifications/contracts";

const ENTRY_FIXTURE = {
  id: "notification-1",
  updatedAt: 1_700_000_000_000,
  readAt: null,
  kind: "approval.requested" as const,
  sourceRef: "approval-1",
  payload: {
    epicId: "epic-1",
    chatId: "chat-1",
    approvalId: "approval-1",
  },
};

const STOPPED_ENTRY_V11_FIXTURE = {
  id: "notification-2",
  updatedAt: 1_700_000_000_010,
  readAt: null,
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

const STALLED_ENTRY_V11_FIXTURE = {
  id: "notification-3",
  updatedAt: 1_700_000_000_020,
  readAt: null,
  kind: "agent.stalled" as const,
  sourceRef: "agent-1",
  severity: "failure" as const,
  outcome: null,
  payload: {
    epicId: "epic-1",
    chatId: "chat-1",
    agentId: "agent-1",
    reason: "provider_throttle",
  },
};

describe("host notification entry schema", () => {
  it("parses the v1 entry shape with an opaque object payload", () => {
    const parsed = hostNotificationEntrySchema.parse(ENTRY_FIXTURE);

    expect(parsed.id).toBe("notification-1");
    expect(parsed.kind).toBe("approval.requested");
    expect(parsed.readAt).toBeNull();
    expect(parsed.payload.approvalId).toBe("approval-1");
  });

  it("rejects unknown host notification kinds", () => {
    expect(() =>
      hostNotificationEntrySchema.parse({
        ...ENTRY_FIXTURE,
        kind: "agent.started",
      }),
    ).toThrow();
  });

  it("rejects non-object payloads", () => {
    expect(() =>
      hostNotificationEntrySchema.parse({
        ...ENTRY_FIXTURE,
        payload: "approval-1",
      }),
    ).toThrow();
  });
});

describe("host notification entry schema v1.1", () => {
  it("parses agent.stopped with outcome and failure details", () => {
    const parsed = hostNotificationEntryV11Schema.parse(
      STOPPED_ENTRY_V11_FIXTURE,
    );

    expect(parsed.kind).toBe("agent.stopped");
    expect(parsed.outcome).toBe("errored");
    expect(parsed.payload.code).toBe("rate_limit");
    expect(parsed.severity).toBe("failure");
  });

  it("parses agent.stalled under v1.1 but rejects it under v1.0", () => {
    expect(hostNotificationEntryV11Schema.parse(STALLED_ENTRY_V11_FIXTURE).kind)
      .toBe("agent.stalled");

    expect(() =>
      hostNotificationEntrySchema.parse({
        id: STALLED_ENTRY_V11_FIXTURE.id,
        updatedAt: STALLED_ENTRY_V11_FIXTURE.updatedAt,
        readAt: STALLED_ENTRY_V11_FIXTURE.readAt,
        kind: STALLED_ENTRY_V11_FIXTURE.kind,
        sourceRef: STALLED_ENTRY_V11_FIXTURE.sourceRef,
        payload: STALLED_ENTRY_V11_FIXTURE.payload,
      }),
    ).toThrow();
  });
});

describe("host.notifications.list@1.0", () => {
  it("parses the first-page request without a cursor", () => {
    expect(
      hostNotificationsListRequestSchema.parse({
        filter: "all",
        limit: 25,
      }),
    ).toEqual({
      filter: "all",
      limit: 25,
    });
  });

  it("parses all/unread filters and keyset cursors", () => {
    expect(
      hostNotificationsListRequestSchema.parse({
        filter: "unread",
        limit: 25,
        cursor: {
          updatedAt: 1_700_000_000_000,
          id: "notification-1",
        },
      }),
    ).toEqual({
      filter: "unread",
      limit: 25,
      cursor: {
        updatedAt: 1_700_000_000_000,
        id: "notification-1",
      },
    });

    expect(
      hostNotificationsListV10.responseSchema.parse({
        entries: [ENTRY_FIXTURE],
        nextCursor: null,
      }),
    ).toEqual({
      entries: [ENTRY_FIXTURE],
      nextCursor: null,
    });
  });

  it("rejects a zero limit", () => {
    expect(() =>
      hostNotificationsListRequestSchema.parse({
        filter: "unread",
        limit: 0,
      }),
    ).toThrow();
  });
});

describe("host.notifications.list@1.1", () => {
  it("parses entries with top-level severity and outcome", () => {
    expect(
      hostNotificationsListV11.responseSchema.parse({
        entries: [STOPPED_ENTRY_V11_FIXTURE, STALLED_ENTRY_V11_FIXTURE],
        nextCursor: null,
      }),
    ).toEqual({
      entries: [STOPPED_ENTRY_V11_FIXTURE, STALLED_ENTRY_V11_FIXTURE],
      nextCursor: null,
    });
  });
});

describe("host.notifications.markRead@1.0", () => {
  it("rejects empty id sets", () => {
    expect(() =>
      hostNotificationsMarkReadV10.requestSchema.parse({
        ids: [],
      }),
    ).toThrow();
  });
});

describe("host.notifications.subscribe@1.0", () => {
  it("parses snapshot, upserted, read-state, pong, and ping frames", () => {
    expect(
      hostNotificationsSubscribeV10.openRequestSchema.parse({
        filter: "all",
        initialLimit: 50,
      }),
    ).toEqual({ filter: "all", initialLimit: 50 });

    expect(
      hostNotificationsSubscribeServerFrameSchema.parse({
        kind: "snapshot",
        hasBinaryPayload: false,
        entries: [ENTRY_FIXTURE],
      }).kind,
    ).toBe("snapshot");

    expect(
      hostNotificationsSubscribeServerFrameSchema.parse({
        kind: "upserted",
        hasBinaryPayload: false,
        entry: ENTRY_FIXTURE,
      }).kind,
    ).toBe("upserted");

    expect(
      hostNotificationsSubscribeServerFrameSchema.parse({
        kind: "readStateChanged",
        hasBinaryPayload: false,
        ids: ["notification-1"],
        readAt: 1_700_000_000_001,
      }).kind,
    ).toBe("readStateChanged");

    expect(
      hostNotificationsSubscribeServerFrameSchema.parse({
        kind: "pong",
        hasBinaryPayload: false,
      }).kind,
    ).toBe("pong");

    expect(
      hostNotificationsSubscribeClientFrameSchema.parse({
        kind: "ping",
        hasBinaryPayload: false,
      }).kind,
    ).toBe("ping");
  });

  it("rejects host notification frames that claim a binary payload", () => {
    expect(() =>
      hostNotificationsSubscribeServerFrameSchema.parse({
        kind: "snapshot",
        hasBinaryPayload: true,
        entries: [],
      }),
    ).toThrow();
  });

  it("rejects a zero initialLimit", () => {
    expect(() =>
      hostNotificationsSubscribeV10.openRequestSchema.parse({
        filter: "all",
        initialLimit: 0,
      }),
    ).toThrow();
  });
});

describe("host.notifications.subscribe@1.1", () => {
  it("parses channelEmission server frames without feed-state semantics", () => {
    const parsed = hostNotificationsSubscribeServerFrameV11Schema.parse({
      kind: "channelEmission",
      hasBinaryPayload: false,
      emissionId: "emission-1",
      channelId: "renderer",
      severity: "failure",
      rows: [STOPPED_ENTRY_V11_FIXTURE],
      reason: "new",
    });

    expect(parsed.kind).toBe("channelEmission");
    if (parsed.kind !== "channelEmission") throw new Error("expected emission");
    expect(parsed.rows[0].kind).toBe("agent.stopped");
    expect(parsed.rows[0].outcome).toBe("errored");
  });

  it("parses presence client frames", () => {
    const parsed = hostNotificationsSubscribeClientFrameV11Schema.parse({
      kind: "presence",
      hasBinaryPayload: false,
      windowId: "window-1",
      focused: true,
      entity: {
        epicId: "epic-1",
        chatId: "chat-1",
      },
      at: 1_700_000_000_030,
    });

    expect(parsed.kind).toBe("presence");
    if (parsed.kind !== "presence") throw new Error("expected presence");
    expect(parsed.entity?.chatId).toBe("chat-1");
  });

  it("accepts null presence entity for windows without a focused artifact", () => {
    expect(
      hostNotificationsSubscribeClientFrameV11Schema.parse({
        kind: "presence",
        hasBinaryPayload: false,
        windowId: "window-1",
        focused: false,
        entity: null,
        at: 1_700_000_000_040,
      }).kind,
    ).toBe("presence");
  });
});

describe("host.notifications config contracts", () => {
  it("parses channel matrix and response state without secret-bearing fields", () => {
    const response = {
      matrix: {
        info: {
          renderer: true,
          webhook: false,
          email: false,
        },
        needs_action: {
          renderer: true,
          webhook: true,
          email: true,
        },
        failure: {
          renderer: true,
          webhook: true,
          email: true,
        },
        done: {
          renderer: true,
          webhook: false,
          email: false,
        },
      },
      channels: {
        renderer: {
          lastError: null,
        },
        webhook: {
          url: "https://example.com/traycer",
          credentialConfigured: true,
          lastError: null,
        },
        email: {
          host: "smtp.example.com",
          port: 587,
          user: "me@example.com",
          from: "Traycer <me@example.com>",
          credentialConfigured: true,
          lastError: "last delivery failed",
        },
      },
    };

    expect(hostNotificationsConfigResponseSchema.parse(response)).toEqual(
      response,
    );
    expect(JSON.stringify(response)).not.toContain("password");
    expect(JSON.stringify(response).toLowerCase()).not.toContain("secret");
  });

  it("allows setConfig to update credentials without echoing them in the response", () => {
    const request = hostNotificationsSetConfigV10.requestSchema.parse({
      matrix: {
        info: {
          renderer: true,
          webhook: false,
          email: false,
        },
        needs_action: {
          renderer: true,
          webhook: true,
          email: true,
        },
        failure: {
          renderer: true,
          webhook: true,
          email: true,
        },
        done: {
          renderer: true,
          webhook: false,
          email: false,
        },
      },
      channels: {
        renderer: {},
        webhook: {
          url: "https://example.com/traycer",
          signingSecret: {
            kind: "set",
            value: "new-webhook-secret",
          },
        },
        email: {
          host: "smtp.example.com",
          port: 587,
          user: "me@example.com",
          password: {
            kind: "set",
            value: "new-smtp-password",
          },
          from: "Traycer <me@example.com>",
        },
      },
    });

    expect(request.channels.webhook.signingSecret.kind).toBe("set");
    expect(request.channels.email.password.kind).toBe("set");
    expect(hostNotificationsGetConfigV10.requestSchema.parse({})).toEqual({});
  });
});

describe("host.notifications registry membership", () => {
  it("registers unary contracts under host.notifications.*", () => {
    expect(hostRpcRegistry["host.notifications.list"][1].latestMinor).toBe(1);
    expect(
      hostRpcRegistry["host.notifications.list"][1].versions[0].contract,
    ).toBe(hostNotificationsListV10);
    expect(
      hostRpcRegistry["host.notifications.list"][1].versions[1].contract,
    ).toBe(hostNotificationsListV11);
    expect(
      hostRpcRegistry["host.notifications.getConfig"][1].versions[0].contract,
    ).toBe(hostNotificationsGetConfigV10);
    expect(
      hostRpcRegistry["host.notifications.setConfig"][1].versions[0].contract,
    ).toBe(hostNotificationsSetConfigV10);
    expect(
      hostRpcRegistry["host.notifications.markRead"][1].versions[0].contract,
    ).toBe(hostNotificationsMarkReadV10);
    expect(
      hostRpcRegistry["host.notifications.markAllRead"][1].versions[0]
        .contract,
    ).toBe(hostNotificationsMarkAllReadV10);
  });

  it("registers the stream without colliding with global notifications.subscribe", () => {
    expect(hostStreamRpcRegistry["notifications.subscribe"]).toBeDefined();
    expect(hostStreamRpcRegistry["host.notifications.subscribe"]).toBeDefined();
    expect(
      hostStreamRpcRegistry["host.notifications.subscribe"][1].latestMinor,
    ).toBe(1);
    expect(
      hostStreamRpcRegistry["host.notifications.subscribe"][1].versions[0]
        .contract,
    ).toBe(hostNotificationsSubscribeV10);
    expect(
      hostStreamRpcRegistry["host.notifications.subscribe"][1].versions[1]
        .contract,
    ).toBe(hostNotificationsSubscribeV11);
  });
});
