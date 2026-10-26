/**
 * A bell row about one of the person's bots shows the bot's picture, a
 * squircle, where other rows show their glyph (Tracy Bots, T62). The real
 * `NotificationRow` under the real `NotificationBotsProvider`; the row and
 * the host's `bot.list` answer are the boundaries.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { BotListResponse } from "@traycer/protocol/host/bot/schemas";
import type { MergedNotificationRow } from "@/stores/notifications/merged-notifications";
import { avatarShape } from "@/components/bots/__tests__/avatar-shape";

const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";

// The preview-features verdict per feature; a case sets it, every other runs on.
const previewVerdict = vi.hoisted(
  (): { current: Record<"environments" | "sandboxes" | "bots", "on" | "off" | "unread"> } => ({
    current: { environments: "on", sandboxes: "on", bots: "on" },
  }),
);
vi.mock("@/hooks/auth/use-preview-feature", () => ({
  usePreviewFeature: (feature: "environments" | "sandboxes" | "bots") =>
    previewVerdict.current[feature],
}));

const mocks = vi.hoisted(() => ({
  row: null as MergedNotificationRow | null,
  bots: undefined as BotListResponse | undefined,
  listEnabled: [] as boolean[],
}));

vi.mock("@/stores/notifications/merged-notifications", async (importActual) => {
  const actual =
    await importActual<
      typeof import("@/stores/notifications/merged-notifications")
    >();
  return {
    ...actual,
    useMergedNotificationRow: () => mocks.row,
  };
});
vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => null,
}));
vi.mock("@/hooks/host/use-reactive-local-host-entry", () => ({
  useReactiveLocalHostEntry: () => null,
}));
vi.mock("@/hooks/agent/use-host-reachability", () => ({
  useRemoteSessionPollReadiness: () => false,
}));
vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHostOrNull: () => null,
}));
vi.mock("@/hooks/notifications/use-notification-host", () => ({
  useNotificationResolveHost: () => ({
    hostId: "host-1",
    client: { stub: "host-client" },
  }),
}));
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: (_hostId: string | null, method: string) =>
    method === "bot.list",
}));
vi.mock("@/hooks/bots/use-bot-list-query", () => ({
  useBotListQuery: (_client: unknown, enabled: boolean) => {
    mocks.listEnabled.push(enabled);
    return { data: enabled ? mocks.bots : undefined };
  },
}));

import { NotificationRow } from "@/components/notifications/notification-row";
import { NotificationBotsProvider } from "@/components/notifications/notification-bots";

function verdictRow(epicId: string): MergedNotificationRow {
  return {
    feedId: "host:verdict-1",
    source: "host",
    sourceId: "verdict-1",
    createdAt: 1_000,
    readAt: null,
    title: "Tracy answered",
    body: "Your question about the release",
    payload: { kind: "chat", epicId, chatId: "thread-1" },
    hostKind: "host.operation.finished",
    appLocalKind: null,
    globalEntry: null,
    severity: "done",
    outcome: null,
    resolvedAt: null,
    sourceRef: null,
    originHostId: null,
    providerPackAttribution: null,
    category: "task",
  };
}

function renderRow(row: MergedNotificationRow): HTMLElement {
  mocks.row = row;
  render(
    <NotificationBotsProvider>
      <ul>
        <NotificationRow
          feedId={row.feedId}
          highlightRelocation={false}
          onActivate={vi.fn()}
          onAcknowledge={vi.fn()}
        />
      </ul>
    </NotificationBotsProvider>,
  );
  return screen.getByTestId("notification-entry");
}

beforeEach(() => {
  mocks.row = null;
  mocks.listEnabled = [];
  mocks.bots = {
    bots: [
      {
        botId: BOT_ID,
        environmentId: "env-1",
        createdByUserId: "user-1",
        title: "Tracy",
        harness: "claude",
        model: "claude-opus-5-5",
        effort: null,
        profile: null,
        trunkChatId: "trunk-1",
        boundHostId: "host-1",
        hostEpoch: 0,
        createdAt: 1,
        archivedAt: null,
        directive: null,
        replyMode: "direct",
        appConversationChatId: null,
      },
    ],
    mainBotIds: {},
  };
});
afterEach(() => {
  cleanup();
  previewVerdict.current = { environments: "on", sandboxes: "on", bots: "on" };
});

describe("<NotificationRow /> about a bot", () => {
  it("shows the bot's squircle picture in place of the glyph", () => {
    const entry = renderRow(verdictRow(BOT_ID));

    const avatar = within(entry).getByTestId("bot-avatar");
    expect(avatarShape(avatar)).toBe("squircle");
    expect(avatar.textContent).toBe("TR");
    expect(mocks.listEnabled).toContain(true);
  });

  it.each(["off", "unread"] as const)(
    "reads no bot list and keeps the glyph while bots read %s",
    (state) => {
      previewVerdict.current = { environments: state, sandboxes: state, bots: state };
      const entry = renderRow(verdictRow(BOT_ID));

      expect(within(entry).queryByTestId("bot-avatar")).toBeNull();
      expect(mocks.listEnabled.length).toBeGreaterThan(0);
      expect(mocks.listEnabled).not.toContain(true);
    },
  );

  it("keeps the glyph on a row about anything else", () => {
    const entry = renderRow(verdictRow("epic-1"));

    expect(within(entry).queryByTestId("bot-avatar")).toBeNull();
  });
});
