import { describe, expect, it } from "vitest";
import {
  hostRpcRegistry,
  hostStreamRpcRegistry,
} from "@traycer/protocol/host/registry";
import {
  formatHostNotificationPresentation,
  hiddenHostNotificationKinds,
  hostNotificationCloudEntrySchemaV26,
  hostNotificationEntrySchemaV25,
  hostNotificationEntrySchemaV26,
  hostNotificationHooksRemovedPayloadSchema,
  hostNotificationHooksSaveV20,
  hostNotificationsCloudFeedSubscribeServerFrameSchemaV15,
  hostNotificationsCloudFeedSubscribeServerFrameSchemaV16,
  hostNotificationsListDowngradeV25ToV10,
  hostNotificationsListResponseSchemaV10,
  hostNotificationsListResponseSchemaV24,
  hostNotificationsListResponseSchemaV25,
  hostNotificationsSubscribeServerFrameSchemaV16,
  hostNotificationsSubscribeServerFrameSchemaV17,
  hostNotificationHooksSave,
  notificationHooksRemovedMessage,
  notificationHooksSaveRequestSchema,
  notificationHooksSaveRequestSchemaV20,
  notificationHooksSaveRequestSchemaV10,
  notificationHooksStatusResponseSchema,
  notificationHooksStatusResponseSchemaV10,
  visibleHostNotificationKinds,
  type HostNotificationsSurface,
  type NotificationHookConfig,
  type NotificationHooksStatusResponse,
} from "@traycer/protocol/host/notifications/contracts";

const REMOVED = "notification.hooks.removed";

const COMMAND_HOOK: NotificationHookConfig = {
  id: "hook-1",
  name: "Pager",
  enabled: true,
  severities: null,
  action: { type: "command", command: "/bin/echo", args: ["hi"] },
};
const HTTP_HOOK: NotificationHookConfig = {
  id: "hook-2",
  name: "Webhook",
  enabled: true,
  severities: ["failure"],
  action: {
    type: "http",
    url: "https://hooks.example.com/a",
    headers: { "X-Tag": "t" },
  },
};

const saveLine = hostRpcRegistry["host.notificationHooks.save"];
const statusLine = hostRpcRegistry["host.notificationHooks.status"];

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new Error("expected the registry to install this path");
  }
  return value;
}

/** A frozen request carried up to the latest line, as a new host receives it. */
function upgradeSaveV10ToLatest(legacy: {
  hooks: NotificationHookConfig[];
}): unknown {
  const toV2 = required(saveLine[2].versions[0].upgradeFromPreviousVersion);
  const toV3 = required(saveLine[3].versions[0].upgradeFromPreviousVersion);
  return toV3.upgradeRequest(
    toV2.upgradeRequest(notificationHooksSaveRequestSchemaV10.parse(legacy)),
  );
}

function latestStatus(): NotificationHooksStatusResponse {
  return {
    configPath: "/home/me/.traycer/notification-hooks.json",
    configError: null,
    hooks: [
      { ...COMMAND_HOOK, lastResult: null, localOnly: true },
      { ...HTTP_HOOK, lastResult: null, localOnly: null },
    ],
    configurationRevision: "rev-7",
    pendingRemovalNotices: [
      {
        id: "receipt-1",
        hostId: "host-1",
        hostName: "Work laptop",
        count: 2,
        occurredAt: 1_700_000_000_000,
      },
    ],
  };
}

describe("hook saves from released clients", () => {
  it("carries a frozen save@1 template add to the latest line with no revision", () => {
    const upgraded = upgradeSaveV10ToLatest({ hooks: [COMMAND_HOOK] });

    expect(upgraded).toEqual({
      hooks: [COMMAND_HOOK],
      executableWriteGrant: null,
      configurationRevision: null,
    });
    expect(notificationHooksSaveRequestSchema.safeParse(upgraded).success).toBe(
      true,
    );
  });

  it("carries a frozen save@1 edit of an existing id unchanged", () => {
    const edited = { ...HTTP_HOOK, name: "Renamed" };
    const upgraded = upgradeSaveV10ToLatest({
      hooks: [COMMAND_HOOK, edited],
    });

    expect(upgraded).toMatchObject({
      hooks: [COMMAND_HOOK, edited],
      configurationRevision: null,
    });
  });

  it("keeps a save@2 grant and still supplies no revision", () => {
    const v2 = notificationHooksSaveRequestSchemaV20.parse({
      hooks: [COMMAND_HOOK],
      executableWriteGrant: "grant-token",
    });
    const upgraded = required(
      saveLine[3].versions[0].upgradeFromPreviousVersion,
    ).upgradeRequest(v2);

    expect(upgraded).toEqual({
      hooks: [COMMAND_HOOK],
      executableWriteGrant: "grant-token",
      configurationRevision: null,
    });
  });

  it("never lets a direct latest caller leave the revision out or send an empty one", () => {
    const base = { hooks: [COMMAND_HOOK], executableWriteGrant: null };

    expect(notificationHooksSaveRequestSchema.safeParse(base).success).toBe(
      false,
    );
    expect(
      notificationHooksSaveRequestSchema.safeParse({
        ...base,
        configurationRevision: "",
      }).success,
    ).toBe(false);
    expect(
      notificationHooksSaveRequestSchema.safeParse({
        ...base,
        configurationRevision: "rev-7",
      }).success,
    ).toBe(true);
  });

  it("drops the revision when a current client saves to a released host", () => {
    const request = notificationHooksSaveRequestSchema.parse({
      hooks: [COMMAND_HOOK],
      executableWriteGrant: "grant-token",
      configurationRevision: "rev-7",
    });
    const toV2 = required(saveLine[3].downgradePathsFromLatest[2]);
    const toV1 = required(saveLine[3].downgradePathsFromLatest[1]);

    const v2 = toV2.downgradeRequest(request);
    const v1 = toV1.downgradeRequest(request);

    expect(v2).toEqual({
      ok: true,
      value: { hooks: [COMMAND_HOOK], executableWriteGrant: "grant-token" },
    });
    expect(v1).toEqual({ ok: true, value: { hooks: [COMMAND_HOOK] } });
    // Both released request schemas are strict: a stray revision would refuse.
    expect(
      hostNotificationHooksSaveV20.requestSchema.safeParse(
        v2.ok ? v2.value : null,
      ).success,
    ).toBe(true);
    expect(
      hostNotificationHooksSave.requestSchema.safeParse(v1.ok ? v1.value : null)
        .success,
    ).toBe(true);
  });
});

describe("hook status on either side of a release", () => {
  it.each([
    ["status", () => required(statusLine[2].downgradePathsFromLatest[1])],
    [
      "save@3 to save@2",
      () => required(saveLine[3].downgradePathsFromLatest[2]),
    ],
    [
      "save@3 to save@1",
      () => required(saveLine[3].downgradePathsFromLatest[1]),
    ],
  ])(
    "strips revision, notices and local-only marks from %s for a released peer",
    (_label, path) => {
      const downgraded = path().downgradeResponse(latestStatus());

      expect(downgraded.ok).toBe(true);
      if (!downgraded.ok) return;
      expect(downgraded.value).toEqual({
        configPath: "/home/me/.traycer/notification-hooks.json",
        configError: null,
        hooks: [
          { ...COMMAND_HOOK, lastResult: null },
          { ...HTTP_HOOK, lastResult: null },
        ],
      });
      expect(
        notificationHooksStatusResponseSchemaV10.safeParse(downgraded.value)
          .success,
      ).toBe(true);
    },
  );

  it("bridges a released host's status with explicit nulls, never an invented revision", () => {
    const released = notificationHooksStatusResponseSchemaV10.parse({
      configPath: "/home/me/.traycer/notification-hooks.json",
      configError: null,
      hooks: [{ ...COMMAND_HOOK, lastResult: null }],
    });
    const upgraded = required(
      statusLine[2].versions[0].upgradeFromPreviousVersion,
    ).upgradeResponse(released);

    expect(upgraded).toEqual({
      configPath: "/home/me/.traycer/notification-hooks.json",
      configError: null,
      hooks: [{ ...COMMAND_HOOK, lastResult: null, localOnly: null }],
      configurationRevision: null,
      pendingRemovalNotices: [],
    });
    expect(
      notificationHooksStatusResponseSchema.safeParse(upgraded).success,
    ).toBe(true);
  });

  it("bridges a save@2 response the same way when a current client saves to an older host", () => {
    const released = notificationHooksStatusResponseSchemaV10.parse({
      configPath: "/p",
      configError: null,
      hooks: [],
    });
    const upgraded = required(
      saveLine[3].versions[0].upgradeFromPreviousVersion,
    ).upgradeResponse(released);

    expect(upgraded.configurationRevision).toBeNull();
    expect(upgraded.pendingRemovalNotices).toEqual([]);
  });

  it("refuses a status response that carries unknown fields", () => {
    expect(
      notificationHooksStatusResponseSchema.safeParse({
        ...latestStatus(),
        restored: [HTTP_HOOK],
      }).success,
    ).toBe(false);
    expect(
      notificationHooksStatusResponseSchemaV10.safeParse(latestStatus())
        .success,
    ).toBe(false);
  });

  it("carries only a count, a label and an id in a pending notice", () => {
    const notice = latestStatus().pendingRemovalNotices[0];
    for (const extra of [
      { url: "https://hooks.example.com/a" },
      { headers: { Authorization: "Bearer x" } },
      { hooks: [HTTP_HOOK] },
    ]) {
      expect(
        notificationHooksStatusResponseSchema.safeParse({
          ...latestStatus(),
          pendingRemovalNotices: [{ ...notice, ...extra }],
        }).success,
      ).toBe(false);
    }
    expect(
      notificationHooksStatusResponseSchema.safeParse({
        ...latestStatus(),
        pendingRemovalNotices: [{ ...notice, count: 0 }],
      }).success,
    ).toBe(false);
  });
});

const ENTRY_BASE = {
  id: "receipt-1",
  updatedAt: 1_700_000_000_000,
  readAt: null,
  sourceRef: "hook-removal:receipt-1",
  epicId: null,
  chatId: null,
  severity: "info",
  outcome: "completed",
};

function removalEntry(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return { ...ENTRY_BASE, kind: REMOVED, payload };
}

const REMOVAL_PAYLOAD = {
  kind: "notification_hooks_removed",
  hostId: "host-1",
  hostName: "Work laptop",
  count: 2,
};

const SANDBOX_ENTRY = {
  ...ENTRY_BASE,
  id: "sandbox-1",
  kind: "sandbox.notice",
  payload: {
    kind: "sandbox_notice",
    sandboxId: "sbx-1",
    sandboxName: "box",
    notice: { kind: "resting_destroyed" },
  },
};

const LIST: HostNotificationsSurface = { method: "host.notifications.list" };
const FEED: HostNotificationsSurface = {
  method: "host.notifications.feed.subscribe",
};
const CLOUD: HostNotificationsSurface = {
  method: "host.notifications.cloudFeed.subscribe",
};

function feedUpsert(entry: Record<string, unknown>): Record<string, unknown> {
  return {
    kind: "upserted",
    hasBinaryPayload: false,
    entry,
    removedIds: [],
    summary: { unreadCount: 1, attentionCount: 0 },
  };
}

function cloudSnapshot(
  entry: Record<string, unknown>,
): Record<string, unknown> {
  return {
    kind: "snapshot",
    hasBinaryPayload: false,
    connectionState: "connected",
    version: 1,
    rows: [
      {
        entryId: "0195a1f0-0001-7000-8000-00000000000a",
        originHostId: "host-1",
        coalesceKey: "hook-removal:receipt-1",
        entry,
        presentation: { epicTitle: null, chatTitle: null },
      },
    ],
    summary: { totalCount: 1, unreadCount: 1, attentionCount: 0 },
  };
}

describe("the removal notice on each negotiated version", () => {
  it("is carried by list @2.5, feed @1.7 and cloudFeed @1.6", () => {
    const entry = removalEntry(REMOVAL_PAYLOAD);

    expect(
      hostNotificationsListResponseSchemaV25.safeParse({
        entries: [entry],
        nextCursor: null,
      }).success,
    ).toBe(true);
    expect(
      hostNotificationsSubscribeServerFrameSchemaV17.safeParse(
        feedUpsert(entry),
      ).success,
    ).toBe(true);
    expect(
      hostNotificationsCloudFeedSubscribeServerFrameSchemaV16.safeParse(
        cloudSnapshot(entry),
      ).success,
    ).toBe(true);
  });

  it("is rejected by list @2.4, feed @1.6 and cloudFeed @1.5, whose peers cannot parse it", () => {
    const entry = removalEntry(REMOVAL_PAYLOAD);

    expect(
      hostNotificationsListResponseSchemaV24.safeParse({
        entries: [entry],
        nextCursor: null,
      }).success,
    ).toBe(false);
    expect(
      hostNotificationsSubscribeServerFrameSchemaV16.safeParse(
        feedUpsert(entry),
      ).success,
    ).toBe(false);
    expect(
      hostNotificationsCloudFeedSubscribeServerFrameSchemaV15.safeParse(
        cloudSnapshot(entry),
      ).success,
    ).toBe(false);
    expect(hostNotificationEntrySchemaV25.safeParse(entry).success).toBe(false);
  });

  it.each([
    ["list @2.4", LIST, { major: 2, minor: 4 }],
    ["feed @1.6", FEED, { major: 1, minor: 6 }],
    ["cloudFeed @1.5", CLOUD, { major: 1, minor: 5 }],
  ])("excludes it centrally at %s", (_label, surface, version) => {
    expect(visibleHostNotificationKinds(surface, version)).not.toContain(
      REMOVED,
    );
    expect(hiddenHostNotificationKinds(surface, version)).toContain(REMOVED);
  });

  it.each([
    ["list @2.5", LIST, { major: 2, minor: 5 }],
    ["feed @1.7", FEED, { major: 1, minor: 7 }],
    ["cloudFeed @1.6", CLOUD, { major: 1, minor: 6 }],
  ])(
    "carries it at %s but hides it from reads, as a retired kind",
    (_label, surface, version) => {
      expect(visibleHostNotificationKinds(surface, version)).toContain(REMOVED);
      expect(hiddenHostNotificationKinds(surface, version)).toContain(REMOVED);
    },
  );

  it("keeps sandbox notices on the cloud feed only", () => {
    const sandboxFrame = cloudSnapshot(SANDBOX_ENTRY);

    expect(
      visibleHostNotificationKinds(CLOUD, { major: 1, minor: 5 }),
    ).toContain("sandbox.notice");
    expect(
      visibleHostNotificationKinds(CLOUD, { major: 1, minor: 6 }),
    ).toContain("sandbox.notice");
    expect(
      visibleHostNotificationKinds(LIST, { major: 2, minor: 5 }),
    ).not.toContain("sandbox.notice");
    expect(
      hostNotificationsCloudFeedSubscribeServerFrameSchemaV16.safeParse(
        sandboxFrame,
      ).success,
    ).toBe(true);
    expect(
      hostNotificationsListResponseSchemaV25.safeParse({
        entries: [SANDBOX_ENTRY],
        nextCursor: null,
      }).success,
    ).toBe(false);
  });

  it("is dropped, not passed through, when a released v1 caller reads list @2.5", () => {
    const removal = hostNotificationEntrySchemaV26.parse(
      removalEntry(REMOVAL_PAYLOAD),
    );
    const agent = hostNotificationEntrySchemaV26.parse({
      ...ENTRY_BASE,
      id: "agent-1",
      kind: "agent.stopped",
      severity: "done",
      payload: { outcome: "completed" },
    });
    const result = hostNotificationsListDowngradeV25ToV10.downgradeResponse({
      entries: [removal, agent],
      nextCursor: null,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.entries.map((entry) => entry.id)).toEqual(["agent-1"]);
    expect(
      hostNotificationsListResponseSchemaV10.safeParse(result.value).success,
    ).toBe(true);
  });

  it("is registered on the latest line of each surface", () => {
    expect(hostRpcRegistry["host.notifications.list"][2].latestMinor).toBe(5);
    expect(
      hostStreamRpcRegistry["host.notifications.feed.subscribe"][1].latestMinor,
    ).toBe(7);
    expect(
      hostStreamRpcRegistry["host.notifications.cloudFeed.subscribe"][1]
        .latestMinor,
    ).toBe(6);
  });
});

describe("removal notice payload and copy", () => {
  it("is exact: no hook configuration, URL or header can ride along", () => {
    expect(
      hostNotificationHooksRemovedPayloadSchema.safeParse(REMOVAL_PAYLOAD)
        .success,
    ).toBe(true);
    for (const extra of [
      { url: "https://hooks.example.com/a" },
      { headers: { Authorization: "Bearer x" } },
      { hooks: [HTTP_HOOK] },
      { hookIds: ["hook-2"] },
    ]) {
      expect(
        hostNotificationHooksRemovedPayloadSchema.safeParse({
          ...REMOVAL_PAYLOAD,
          ...extra,
        }).success,
      ).toBe(false);
    }
    expect(
      hostNotificationHooksRemovedPayloadSchema.safeParse({
        ...REMOVAL_PAYLOAD,
        count: 0,
      }).success,
    ).toBe(false);
  });

  it("states the plural sentence exactly", () => {
    expect(notificationHooksRemovedMessage("Work laptop", 2)).toBe(
      "Removed 2 notification hooks from Work laptop because they could send its private data.",
    );
  });

  it("states the singular sentence exactly", () => {
    expect(notificationHooksRemovedMessage("Work laptop", 1)).toBe(
      "Removed 1 notification hook from Work laptop because it could send its private data.",
    );
  });

  it("formats an entry with the same sentence and the notice title", () => {
    const entry = hostNotificationCloudEntrySchemaV26.parse(
      removalEntry(REMOVAL_PAYLOAD),
    );

    expect(formatHostNotificationPresentation(entry)).toEqual({
      title: "Notification hooks removed",
      body: "Removed 2 notification hooks from Work laptop because they could send its private data.",
    });
  });

  it("falls back to generic copy that echoes nothing from a payload it does not recognise", () => {
    const entry = hostNotificationCloudEntrySchemaV26.parse(
      removalEntry({
        ...REMOVAL_PAYLOAD,
        url: "https://hooks.example.com/secret-path",
      }),
    );
    const presentation = formatHostNotificationPresentation(entry);

    expect(presentation).toEqual({
      title: "Notification hooks removed",
      body: "Review notification hooks on the affected computer.",
    });
    expect(JSON.stringify(presentation)).not.toContain("secret-path");
  });
});
