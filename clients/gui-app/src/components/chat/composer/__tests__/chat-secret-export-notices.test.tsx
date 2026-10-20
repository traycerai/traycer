import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { SecretsNotificationDetail } from "@/lib/notifications/secrets-notification-detail";
import type { MergedNotificationRow } from "@/stores/notifications/merged-notifications";

const NOW = 1_000_000;

interface NoticeState {
  rows: readonly MergedNotificationRow[];
}

const mocks = vi.hoisted(() => {
  const state: NoticeState = { rows: [] };
  return { state };
});

vi.mock("@/stores/notifications/merged-notifications", () => ({
  useMergedNotificationRows: () => mocks.state.rows,
}));
vi.mock("@/lib/relative-time", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/relative-time")>();
  return { ...actual, useSampledNow: () => 1_000_000 };
});

import { ChatSecretExportNotices } from "@/components/chat/composer/chat-secret-export-notices";

type ExportMintedDetail = Extract<
  SecretsNotificationDetail,
  { kind: "export-minted" }
>;

function exportDetail(
  secretName: string,
  expiresAt: number,
): ExportMintedDetail {
  return {
    kind: "export-minted",
    secretName,
    exportKind: "presigned_url",
    expiresAt,
  };
}

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
    secrets: exportDetail("DEPLOY_KEY", NOW + 60_000),
    hostKind: "secret.export.minted",
    appLocalKind: null,
    globalEntry: null,
    severity: "info",
    outcome: "completed",
    resolvedAt: null,
    sourceRef: "secret-1",
    originHostId: null,
    providerPackAttribution: null,
    category: "task",
    ...overrides,
  };
}

beforeEach(() => {
  mocks.state.rows = [];
});
afterEach(cleanup);

describe("<ChatSecretExportNotices />", () => {
  it("renders nothing when there are no rows", () => {
    const { container } = render(<ChatSecretExportNotices chatId="chat-1" />);
    expect(container.childElementCount).toBe(0);
  });

  it("renders nothing when no row is a live export for this chat", () => {
    mocks.state.rows = [
      buildRow({
        feedId: "host:other-chat",
        payload: { kind: "chat", epicId: "epic-1", chatId: "chat-2" },
      }),
      buildRow({ feedId: "host:read", readAt: NOW - 1 }),
      buildRow({
        feedId: "host:expired",
        secrets: exportDetail("OLD_KEY", NOW),
      }),
    ];
    const { container } = render(<ChatSecretExportNotices chatId="chat-1" />);
    expect(container.childElementCount).toBe(0);
    expect(screen.queryByTestId("chat-secret-export-notices")).toBeNull();
  });

  it("renders one notice for one live export", () => {
    mocks.state.rows = [buildRow({})];
    render(<ChatSecretExportNotices chatId="chat-1" />);
    const list = screen.getByTestId("chat-secret-export-notices");
    const notices = within(list).getAllByTestId("secret-export-notice");
    expect(notices).toHaveLength(1);
    expect(notices[0].textContent).toContain(
      "An agent minted a presigned URL from DEPLOY_KEY.",
    );
  });

  it("renders one notice per live export, in row order, skipping the rest", () => {
    mocks.state.rows = [
      buildRow({
        feedId: "host:a",
        secrets: exportDetail("KEY_A", NOW + 1),
      }),
      buildRow({
        feedId: "host:other",
        secrets: exportDetail("KEY_OTHER", NOW + 1),
        payload: { kind: "chat", epicId: "epic-1", chatId: "chat-2" },
      }),
      buildRow({
        feedId: "host:b",
        secrets: exportDetail("KEY_B", NOW + 1),
      }),
    ];
    render(<ChatSecretExportNotices chatId="chat-1" />);
    const notices = screen.getAllByTestId("secret-export-notice");
    expect(notices).toHaveLength(2);
    expect(notices[0].textContent).toContain("KEY_A");
    expect(notices[1].textContent).toContain("KEY_B");
  });

  it("shows at most three notices", () => {
    mocks.state.rows = ["A", "B", "C", "D"].map((name) =>
      buildRow({
        feedId: `host:${name}`,
        secrets: exportDetail(`KEY_${name}`, NOW + 1),
      }),
    );
    render(<ChatSecretExportNotices chatId="chat-1" />);
    expect(screen.getAllByTestId("secret-export-notice")).toHaveLength(3);
  });
});
