import { describe, expect, it } from "vitest";
import {
  hostRpcRegistry,
  hostStreamRpcRegistry,
} from "@traycer/protocol/host/registry";
import {
  hostNotificationEntrySchema,
  hostNotificationsListRequestSchema,
  hostNotificationsListV10,
  hostNotificationsMarkAllReadV10,
  hostNotificationsMarkReadV10,
  hostNotificationsSubscribeClientFrameSchema,
  hostNotificationsSubscribeServerFrameSchema,
  hostNotificationsSubscribeV10,
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

describe("host.notifications registry membership", () => {
  it("registers unary contracts under host.notifications.*", () => {
    expect(hostRpcRegistry["host.notifications.list"][1].latestMinor).toBe(0);
    expect(
      hostRpcRegistry["host.notifications.list"][1].versions[0].contract,
    ).toBe(hostNotificationsListV10);
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
      hostStreamRpcRegistry["host.notifications.subscribe"][1].versions[0]
        .contract,
    ).toBe(hostNotificationsSubscribeV10);
  });
});
