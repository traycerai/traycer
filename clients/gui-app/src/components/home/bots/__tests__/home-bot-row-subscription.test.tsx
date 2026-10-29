/**
 * A Home bot row reads its activity through the real `bot.subscribe` stream:
 * a replying snapshot says Working, and once the stream closes for good or the
 * bot is deleted the row says nothing, since no frame will move the last
 * snapshot the cache keeps. A retryable reconnect is not a close.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BotRecord,
  BotSessionActivity,
  BotSubscribeServerFrame,
} from "@traycer/protocol/host/bot/schemas";
import { __resetBotSubscriptionsForTesting } from "@/hooks/bots/use-bot-subscription";
import {
  StubHostStreamClient,
  StubSession,
} from "@/hooks/bots/__tests__/bot-subscribe-stub-stream";

const stream = vi.hoisted(() => ({
  client: null as StubHostStreamClient | null,
}));

// The app-wide stream client is the stub's; the subscription is the real one.
vi.mock("@/hooks/bots/use-bot-subscription", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/hooks/bots/use-bot-subscription")>();
  return {
    ...actual,
    useBotSubscription: (args: {
      readonly hostId: string | null;
      readonly botId: string;
      readonly enabled: boolean;
    }) =>
      actual.useBotSubscriptionForClient({ ...args, client: stream.client }),
  };
});
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@/hooks/host/use-effective-host-id", () => ({
  useEffectiveHostId: () => "host-effective",
}));

import { HomeBotRow } from "@/components/home/bots/home-bot-row";

const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const OWN = "host-own";

const BOT: BotRecord = {
  botId: BOT_ID,
  environmentId: "env-team",
  createdByUserId: "user-1",
  title: "Release Bot",
  harness: "claude",
  model: "opus",
  effort: null,
  profile: null,
  trunkChatId: "trunk-1",
  boundHostId: OWN,
  hostEpoch: 1,
  createdAt: 1_000,
  archivedAt: null,
  directive: null,
  replyMode: "thread",
  appConversationChatId: null,
};

const REPLYING: BotSessionActivity = {
  state: "replying",
  startedAt: 5_000,
  step: "bun test",
  requestId: null,
  reason: null,
};

const REPLYING_SNAPSHOT: BotSubscribeServerFrame = {
  kind: "snapshot",
  bot: BOT,
  tasks: [],
  openRequestCount: 0,
  conversationsRevision: 0,
  notificationSubscriptions: null,
  stoppedNotificationWatches: null,
  boundHost: { hostId: OWN, epoch: 1, isThisHost: false },
  activity: { trunk: REPLYING, threads: {} },
  hasBinaryPayload: false,
};

function closedWith(retryable: boolean): {
  readonly kind: "fatalError";
  readonly details: {
    readonly code: string;
    readonly reason: string;
    readonly incompatibleMethods: null;
    readonly upgradeGuidance: null;
    readonly retryable: boolean;
  };
} {
  return {
    kind: "fatalError",
    details: {
      code: "BOT_STREAM_CLOSED",
      reason: "The stream closed.",
      incompatibleMethods: null,
      upgradeGuidance: null,
      retryable,
    },
  };
}

function mountReplyingRow(): StubSession {
  const session = new StubSession();
  stream.client = new StubHostStreamClient(session);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <HomeBotRow
        bot={BOT}
        hostReach={{
          directoryHostIds: new Set([OWN]),
          connectableHostIds: new Set([OWN]),
          connectableResolved: true,
          personalHostIds: new Set(),
        }}
        environmentHostIds={new Set()}
        environmentOwnerKind="organization"
        createdBy={null}
        isMain={false}
        entryLocked={false}
      />
    </QueryClientProvider>,
  );
  act(() => session.emit(REPLYING_SNAPSHOT));
  expect(screen.getByTestId("home-bot-state").textContent).toBe("Working");
  return session;
}

beforeEach(() => {
  __resetBotSubscriptionsForTesting();
});

afterEach(() => {
  cleanup();
  __resetBotSubscriptionsForTesting();
  stream.client = null;
});

describe("<HomeBotRow /> live activity", () => {
  it("keeps Working through a retryable reconnect", () => {
    const session = mountReplyingRow();

    act(() => session.status("closed", closedWith(true)));

    expect(screen.getByTestId("home-bot-state").textContent).toBe("Working");
  });

  it("drops the badge once the stream closes for good", () => {
    const session = mountReplyingRow();

    act(() => session.status("closed", closedWith(false)));

    expect(screen.queryByTestId("home-bot-state")).toBeNull();
  });

  it("drops the badge once the bot is deleted", () => {
    const session = mountReplyingRow();

    act(() => session.emit({ kind: "deleted", hasBinaryPayload: false }));

    expect(screen.queryByTestId("home-bot-state")).toBeNull();
  });
});
