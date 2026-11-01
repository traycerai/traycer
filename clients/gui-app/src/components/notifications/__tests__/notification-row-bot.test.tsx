/**
 * A bell row about one of the person's bots shows the bot's picture, a
 * squircle, where other rows show their glyph. The real
 * `NotificationRow` under the real `NotificationBotsProvider`; the row and
 * the host's `bot.list` answer are the boundaries.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { BotListResponse } from "@traycer/protocol/host/bot/schemas";
import type { EnvironmentDescriptor } from "@traycer/protocol/host/environment/contracts";
import type { MergedNotificationRow } from "@/stores/notifications/merged-notifications";
import { avatarShape } from "@/components/bots/__tests__/avatar-shape";
import {
  EMPTY_DIRECTORY_STATE,
  PERSONAL_MAIN_BOT_ID,
  TEAM_MAIN_BOT_ID,
  tracyRecord,
} from "@/lib/home-bots/__tests__/standalone-bots-fixtures";
import { useStandaloneBotsStore } from "@/stores/bots/standalone-bots-store";
import { creatureMark, drawCreatureMark } from "@/lib/bots/creature-mark";

const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";

const mocks = vi.hoisted(() => ({
  row: null as MergedNotificationRow | null,
  bots: undefined as BotListResponse | undefined,
  listEnabled: [] as boolean[],
  environments: [] as EnvironmentDescriptor[],
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
  useHostReachability: () => ({ status: "reachable" }),
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
vi.mock("@/hooks/bots/use-environment-list-query", () => ({
  useEnvironmentListQuery: () => ({
    data: { environments: mocks.environments },
    isFetched: true,
  }),
}));
vi.mock("@/hooks/bots/use-bot-list-changed-subscription", () => ({
  useBotListChangedSubscriptionForHost: () => undefined,
}));
vi.mock("@/hooks/bots/use-reread-environment-list-on-focus", () => ({
  useRereadEnvironmentListOnFocus: () => undefined,
}));
vi.mock("@/hooks/bots/use-team-setups", () => ({
  useTeamSetups: () => ({ settled: true, setups: [] }),
}));
vi.mock("@/hooks/bots/use-bot-list-query", () => ({
  useBotListQuery: (_client: unknown, enabled: boolean) => {
    mocks.listEnabled.push(enabled);
    return { data: enabled ? mocks.bots : undefined, isFetched: enabled };
  },
}));

import { NotificationRow } from "@/components/notifications/notification-row";
import { NotificationBotsProvider } from "@/components/notifications/notification-bots";
import { StandaloneBotsBridge } from "@/components/layout/bridges/standalone-bots-bridge";

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
  useStandaloneBotsStore.setState(EMPTY_DIRECTORY_STATE);
});

function environment(
  environmentId: string,
  label: string,
  ownerKind: EnvironmentDescriptor["ownerKind"],
): EnvironmentDescriptor {
  return {
    environmentId,
    ownerKind,
    ownerId: `owner-${environmentId}`,
    roomId: `room-${environmentId}`,
    label,
  };
}

/** A row of the bot's conversation, as the merged feed projects one. */
function conversationRow(botId: string): MergedNotificationRow {
  return {
    ...verdictRow(botId),
    title: "Tracy",
    payload: {
      kind: "chat",
      epicId: botId,
      chatId: "thread-1",
      bot: { botId, threadId: "thread-1", messageId: "message-1" },
    },
  };
}

describe("<NotificationRow /> title and the environment", () => {
  function titleOf(row: MergedNotificationRow): string | null {
    render(<StandaloneBotsBridge />);
    const entry = renderRow(row);
    return within(entry).getByTestId("notification-title").textContent;
  }

  const PERSONAL = environment("env-me", "Personal", "user");
  const TEAM = environment("env-team", "traycerai", "organization");

  function seeBothMainBots(): void {
    mocks.environments = [PERSONAL, TEAM];
    mocks.bots = {
      bots: [
        tracyRecord(PERSONAL_MAIN_BOT_ID, "env-me"),
        tracyRecord(TEAM_MAIN_BOT_ID, "env-team"),
      ],
      mainBotIds: {
        "env-me": PERSONAL_MAIN_BOT_ID,
        "env-team": TEAM_MAIN_BOT_ID,
      },
    };
  }

  it("places a team's bot by its environment when two main bots are visible", () => {
    seeBothMainBots();

    expect(titleOf(conversationRow(TEAM_MAIN_BOT_ID))).toBe(
      "Tracy · traycerai",
    );
  });

  it("never suffixes the personal bot", () => {
    seeBothMainBots();

    expect(titleOf(conversationRow(PERSONAL_MAIN_BOT_ID))).toBe("Tracy");
  });

  it("keeps a team's bot to its name when it is the only main bot", () => {
    mocks.environments = [TEAM];
    mocks.bots = {
      bots: [tracyRecord(TEAM_MAIN_BOT_ID, "env-team")],
      mainBotIds: { "env-team": TEAM_MAIN_BOT_ID },
    };

    expect(titleOf(conversationRow(TEAM_MAIN_BOT_ID))).toBe("Tracy");
  });

  it("leaves a row about a task's chat alone", () => {
    seeBothMainBots();

    expect(titleOf(verdictRow(TEAM_MAIN_BOT_ID))).toBe("Tracy answered");
  });
});

describe("<NotificationRow /> about a bot", () => {
  it("shows the bot's squircle picture in place of the glyph", () => {
    const entry = renderRow(verdictRow(BOT_ID));

    const avatar = within(entry).getByTestId("bot-avatar");
    expect(avatarShape(avatar)).toBe("squircle");
    expect(
      avatar
        .querySelector('[data-slot="bot-creature"] path')
        ?.getAttribute("d"),
    ).toBe(drawCreatureMark(creatureMark(BOT_ID), 24).path);
    expect(mocks.listEnabled).toContain(true);
  });

  it("keeps the glyph on a row about anything else", () => {
    const entry = renderRow(verdictRow("epic-1"));

    expect(within(entry).queryByTestId("bot-avatar")).toBeNull();
  });
});
