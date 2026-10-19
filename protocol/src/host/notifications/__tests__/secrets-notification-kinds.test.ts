import { describe, expect, it } from "vitest";
import {
  HOST_NOTIFICATION_PENDING_PROMPT_KINDS,
  HOST_NOTIFICATION_SECRET_EXPORT_KINDS,
  formatHostNotificationPresentation,
  hostNotificationEntrySchemaV22,
  hostNotificationEntrySchemaV23,
  hostNotificationSecretExportMintedPayloadSchema,
  hostNotificationSecretGrantRequestPayloadSchema,
  hostNotificationsListDowngradeV23ToV10,
  hostNotificationsListResponseSchemaV10,
  parseKnownHostNotificationPayloadForKind,
  visibleHostNotificationKinds,
  type HostNotificationKind,
  type HostNotificationsSurface,
} from "@traycer/protocol/host/notifications/contracts";

const ENTRY_BASE = {
  id: "secret-entry-1",
  updatedAt: 1_700_000_000_000,
  readAt: null,
  sourceRef: "request-1",
  epicId: "epic-1",
  chatId: "chat-1",
};

const GRANT_PAYLOAD = {
  kind: "secret_grant_request",
  requestId: "request-1",
  hostId: "host-1",
  secretName: "DB_PASSWORD",
  destination: "db.example.com",
  port: 3306,
  protocol: "mysql",
  reason: "Run the migration",
  sandboxName: "build-box",
  agentId: "agent-1",
  epicId: "epic-1",
  chatId: "chat-1",
};

const MINIMAL_GRANT_PAYLOAD = {
  kind: "secret_grant_request",
  requestId: "request-2",
  hostId: "host-1",
  secretName: null,
  destination: null,
  protocol: null,
  reason: "",
};

const EXPORT_PAYLOAD = {
  kind: "secret_export_minted",
  secretName: "DEPLOY_KEY",
  exportKind: "presigned_url",
  expiresAt: 1_700_000_900_000,
  hostId: "host-1",
};

const GRANT_ENTRY = {
  ...ENTRY_BASE,
  kind: "secret.grant.requested",
  severity: "needs_action",
  outcome: null,
  resolvedAt: null,
  payload: GRANT_PAYLOAD,
};

const EXPORT_ENTRY = {
  ...ENTRY_BASE,
  id: "secret-entry-2",
  kind: "secret.export.minted",
  severity: "info",
  outcome: "completed",
  payload: EXPORT_PAYLOAD,
};

const AGENT_STOPPED_ENTRY = {
  ...ENTRY_BASE,
  id: "agent.stopped:chat-1",
  kind: "agent.stopped",
  severity: "done",
  outcome: "completed",
  payload: { outcome: "completed" },
};

const SECRET_KINDS: readonly HostNotificationKind[] = [
  "secret.grant.requested",
  "secret.export.minted",
];

const LIST: HostNotificationsSurface = { method: "host.notifications.list" };
const FEED: HostNotificationsSurface = {
  method: "host.notifications.feed.subscribe",
};
const CLOUD_FEED: HostNotificationsSurface = {
  method: "host.notifications.cloudFeed.subscribe",
};

describe("secrets notification entry arms", () => {
  it("parses a secret.grant.requested entry with a null resolvedAt", () => {
    const parsed = hostNotificationEntrySchemaV23.parse(GRANT_ENTRY);
    expect(parsed.kind).toBe("secret.grant.requested");
  });

  it("parses a secret.grant.requested entry with a numeric resolvedAt", () => {
    const parsed = hostNotificationEntrySchemaV23.safeParse({
      ...GRANT_ENTRY,
      resolvedAt: 1_700_000_000_500,
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a secret.grant.requested entry that carries an outcome", () => {
    expect(
      hostNotificationEntrySchemaV23.safeParse({
        ...GRANT_ENTRY,
        outcome: "completed",
      }).success,
    ).toBe(false);
  });

  it("parses a secret.export.minted entry with a completed outcome", () => {
    const parsed = hostNotificationEntrySchemaV23.parse(EXPORT_ENTRY);
    expect(parsed.kind).toBe("secret.export.minted");
  });

  it.each([
    ["secret.grant.requested", GRANT_ENTRY],
    ["secret.export.minted", EXPORT_ENTRY],
  ])("@2.2 rejects a %s entry", (_kind, entry) => {
    expect(hostNotificationEntrySchemaV22.safeParse(entry).success).toBe(false);
  });
});

describe("secrets notification visibility", () => {
  it.each([
    ["list 2.3", LIST, { major: 2, minor: 3 }],
    ["feed 1.4", FEED, { major: 1, minor: 4 }],
    ["cloudFeed 1.3", CLOUD_FEED, { major: 1, minor: 3 }],
  ])("includes both secret kinds at %s", (_label, surface, version) => {
    const visible = visibleHostNotificationKinds(surface, version);
    for (const kind of SECRET_KINDS) {
      expect(visible).toContain(kind);
    }
  });

  it.each([
    ["list 2.2", LIST, { major: 2, minor: 2 }],
    ["feed 1.3", FEED, { major: 1, minor: 3 }],
    ["cloudFeed 1.2", CLOUD_FEED, { major: 1, minor: 2 }],
  ])("excludes both secret kinds at %s", (_label, surface, version) => {
    const visible = visibleHostNotificationKinds(surface, version);
    for (const kind of SECRET_KINDS) {
      expect(visible).not.toContain(kind);
    }
  });

  it("lights the pending-prompt glyph for the grant but not the export", () => {
    expect(HOST_NOTIFICATION_PENDING_PROMPT_KINDS).toContain(
      "secret.grant.requested",
    );
    expect(HOST_NOTIFICATION_PENDING_PROMPT_KINDS).not.toContain(
      "secret.export.minted",
    );
  });
});

describe("secrets notification payloads", () => {
  it("parses a full grant request payload", () => {
    const parsed =
      hostNotificationSecretGrantRequestPayloadSchema.parse(GRANT_PAYLOAD);
    expect(parsed.secretName).toBe("DB_PASSWORD");
    expect(parsed.port).toBe(3306);
  });

  it("parses a grant request payload with null names and no optional keys", () => {
    const parsed = hostNotificationSecretGrantRequestPayloadSchema.parse(
      MINIMAL_GRANT_PAYLOAD,
    );
    expect(parsed.secretName).toBeNull();
    expect(parsed.destination).toBeNull();
    expect(parsed.protocol).toBeNull();
  });

  it("parses an export payload with a presigned_url export kind", () => {
    expect(HOST_NOTIFICATION_SECRET_EXPORT_KINDS).toContain("presigned_url");
    const parsed =
      hostNotificationSecretExportMintedPayloadSchema.parse(EXPORT_PAYLOAD);
    expect(parsed.exportKind).toBe("presigned_url");
  });

  it("parses an export payload whose export kind this build does not list", () => {
    expect(HOST_NOTIFICATION_SECRET_EXPORT_KINDS).not.toContain(
      "signed_cookie",
    );
    expect(
      hostNotificationSecretExportMintedPayloadSchema.safeParse({
        ...EXPORT_PAYLOAD,
        exportKind: "signed_cookie",
      }).success,
    ).toBe(true);
  });
});

describe("secrets notification kind-coupled payload parse", () => {
  it("returns the grant payload under its own kind", () => {
    const parsed = parseKnownHostNotificationPayloadForKind(
      "secret.grant.requested",
      GRANT_PAYLOAD,
    );
    expect(parsed?.kind).toBe("secret_grant_request");
  });

  it("returns the export payload under its own kind", () => {
    const parsed = parseKnownHostNotificationPayloadForKind(
      "secret.export.minted",
      EXPORT_PAYLOAD,
    );
    expect(parsed?.kind).toBe("secret_export_minted");
  });

  it("returns null for an export payload under the grant kind", () => {
    expect(
      parseKnownHostNotificationPayloadForKind(
        "secret.grant.requested",
        EXPORT_PAYLOAD,
      ),
    ).toBeNull();
  });

  it("returns null for a grant payload under the export kind", () => {
    expect(
      parseKnownHostNotificationPayloadForKind(
        "secret.export.minted",
        GRANT_PAYLOAD,
      ),
    ).toBeNull();
  });
});

describe("secrets notification presentation", () => {
  it("titles an unresolved grant row and says it waits for a decision", () => {
    const presentation = formatHostNotificationPresentation(
      hostNotificationEntrySchemaV23.parse(GRANT_ENTRY),
    );
    expect(presentation.title).toBe("Secret requested");
    expect(presentation.body.endsWith("Waiting for your decision")).toBe(true);
  });

  it("says Decided once the grant row carries a resolvedAt", () => {
    const presentation = formatHostNotificationPresentation(
      hostNotificationEntrySchemaV23.parse({
        ...GRANT_ENTRY,
        resolvedAt: 1_700_000_000_500,
      }),
    );
    expect(presentation.title).toBe("Secret requested");
    expect(presentation.body.endsWith("Decided")).toBe(true);
  });

  it("titles an export row", () => {
    const presentation = formatHostNotificationPresentation(
      hostNotificationEntrySchemaV23.parse(EXPORT_ENTRY),
    );
    expect(presentation.title).toBe("Secret exported");
  });
});

describe("@2.3 -> @1.0 downgrade with secrets rows", () => {
  it("does not let a secrets entry through to the 1.0 response", () => {
    const result = hostNotificationsListDowngradeV23ToV10.downgradeResponse({
      entries: [
        hostNotificationEntrySchemaV23.parse(GRANT_ENTRY),
        hostNotificationEntrySchemaV23.parse(AGENT_STOPPED_ENTRY),
        hostNotificationEntrySchemaV23.parse(EXPORT_ENTRY),
      ],
      nextCursor: { kind: "chronological", updatedAt: 1, id: "x" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.entries.map((entry) => entry.id)).toEqual([
      AGENT_STOPPED_ENTRY.id,
    ]);
    expect(
      hostNotificationsListResponseSchemaV10.safeParse(result.value).success,
    ).toBe(true);
  });
});
