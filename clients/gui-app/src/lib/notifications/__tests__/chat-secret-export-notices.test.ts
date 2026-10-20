import { describe, expect, it } from "vitest";
import {
  CHAT_SECRET_EXPORT_NOTICE_LIMIT,
  chatSecretExportNotices,
} from "@/lib/notifications/chat-secret-export-notices";
import type { SecretsNotificationDetail } from "@/lib/notifications/secrets-notification-detail";
import type { MergedNotificationRow } from "@/stores/notifications/merged-notifications";

const NOW = 1_000_000;

type ExportMintedDetail = Extract<
  SecretsNotificationDetail,
  { kind: "export-minted" }
>;
type GrantRequestDetail = Extract<
  SecretsNotificationDetail,
  { kind: "grant-request" }
>;

function exportDetail(expiresAt: number): ExportMintedDetail {
  return {
    kind: "export-minted",
    secretName: "DEPLOY_KEY",
    exportKind: "presigned_url",
    expiresAt,
  };
}

const GRANT_DETAIL: GrantRequestDetail = {
  kind: "grant-request",
  requestId: "request-1",
  secretName: "DB_PASSWORD",
  destination: "db.example.com",
  port: null,
  protocol: null,
  reason: "Run the migration",
  sandboxName: null,
  environmentId: null,
  teamName: null,
  decision: null,
  decidedBy: null,
};

function buildRow(
  overrides: Partial<MergedNotificationRow>,
): MergedNotificationRow {
  return {
    feedId: "host:secret-1",
    source: "host",
    sourceId: "secret-1",
    createdAt: 1_000,
    readAt: null,
    title: "Secret exported",
    body: "",
    payload: { kind: "chat", epicId: "epic-1", chatId: "chat-1" },
    secrets: exportDetail(NOW + 60_000),
    hostKind: "secret.export.minted",
    appLocalKind: null,
    globalEntry: null,
    severity: "info",
    outcome: "completed",
    resolvedAt: null,
    sourceRef: "secret-1",
    originHostId: "host-a",
    providerPackAttribution: null,
    category: "task",
    ...overrides,
  };
}

function feedIds(
  rows: readonly MergedNotificationRow[],
  chatId: string,
): string[] {
  return chatSecretExportNotices(rows, chatId, NOW).map(
    (notice) => notice.feedId,
  );
}

describe("chatSecretExportNotices", () => {
  it("returns a live, unread export for this chat with its detail", () => {
    const detail = exportDetail(NOW + 60_000);
    expect(
      chatSecretExportNotices(
        [buildRow({ feedId: "host:a", secrets: detail })],
        "chat-1",
        NOW,
      ),
    ).toEqual([{ feedId: "host:a", detail }]);
  });

  it("drops grant-request rows and rows without secrets", () => {
    expect(
      feedIds(
        [
          buildRow({ feedId: "host:grant", secrets: GRANT_DETAIL }),
          buildRow({ feedId: "host:none", secrets: null }),
          buildRow({ feedId: "host:absent", secrets: undefined }),
          buildRow({ feedId: "host:keep" }),
        ],
        "chat-1",
      ),
    ).toEqual(["host:keep"]);
  });

  it("drops a row that has been read", () => {
    expect(
      feedIds([buildRow({ feedId: "host:read", readAt: NOW - 1 })], "chat-1"),
    ).toEqual([]);
  });

  it("drops an export that has expired, including exactly at its expiry", () => {
    expect(
      feedIds(
        [
          buildRow({ feedId: "host:past", secrets: exportDetail(NOW - 1) }),
          buildRow({ feedId: "host:at", secrets: exportDetail(NOW) }),
          buildRow({ feedId: "host:next", secrets: exportDetail(NOW + 1) }),
        ],
        "chat-1",
      ),
    ).toEqual(["host:next"]);
  });

  it("drops rows for another chat", () => {
    expect(
      feedIds(
        [
          buildRow({
            feedId: "host:other",
            payload: { kind: "chat", epicId: "epic-1", chatId: "chat-2" },
          }),
        ],
        "chat-1",
      ),
    ).toEqual([]);
  });

  it("drops rows with a null or non-chat payload", () => {
    expect(
      feedIds(
        [
          buildRow({ feedId: "host:null", payload: null }),
          buildRow({
            feedId: "host:epic",
            payload: { kind: "epic", epicId: "epic-1" },
          }),
        ],
        "chat-1",
      ),
    ).toEqual([]);
  });

  it("keeps the order of the rows it is given", () => {
    expect(
      feedIds(
        [
          buildRow({ feedId: "host:c" }),
          buildRow({ feedId: "host:a" }),
          buildRow({ feedId: "host:b" }),
        ],
        "chat-1",
      ),
    ).toEqual(["host:c", "host:a", "host:b"]);
  });

  it("stops at the notice limit, keeping the first rows", () => {
    const rows = Array.from(
      { length: CHAT_SECRET_EXPORT_NOTICE_LIMIT + 2 },
      (_, index) => buildRow({ feedId: `host:n${index}` }),
    );
    expect(feedIds(rows, "chat-1")).toEqual(
      rows.slice(0, CHAT_SECRET_EXPORT_NOTICE_LIMIT).map((row) => row.feedId),
    );
    expect(CHAT_SECRET_EXPORT_NOTICE_LIMIT).toBe(3);
  });

  it("counts only qualifying rows toward the limit", () => {
    const rows = [
      buildRow({ feedId: "host:read", readAt: 1 }),
      buildRow({ feedId: "host:1" }),
      buildRow({ feedId: "host:2" }),
      buildRow({ feedId: "host:3" }),
      buildRow({ feedId: "host:4" }),
    ];
    expect(feedIds(rows, "chat-1")).toEqual(["host:1", "host:2", "host:3"]);
  });
});
