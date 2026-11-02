/**
 * The bot's live activity: `bot.subscribe`'s snapshot
 * carries the whole `activity`, and each `activity` frame replaces or removes
 * one entry. The real `useBotActivity` reads it from the host the Tracy
 * surface is bound to (the real surface store), outside the surface as the
 * Tracy entry does, through the real shared subscription over a stub session the test
 * scripts; only the host's stream client is the stub's.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BotActivity,
  BotSessionActivity,
  BotSubscribeServerFrame,
} from "@traycer/protocol/host/bot/schemas";
import { __resetBotSubscriptionsForTesting } from "@/hooks/bots/use-bot-subscription";
import {
  botWorkingOf,
  failedOn,
  failedOnRequest,
  replyingSessionOf,
  useBotActivity,
} from "@/hooks/bots/use-bot-activity";
import { useTracySurfaceStore } from "@/stores/bots/tracy-surface-store";
import { StubHostStreamClient, StubSession } from "./bot-subscribe-stub-stream";

const stream = vi.hoisted(() => ({
  client: null as StubHostStreamClient | null,
}));

// The host's stream client is the stub's; the subscription is the real one.
vi.mock("@/hooks/bots/use-bot-subscription", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/hooks/bots/use-bot-subscription")>();
  return {
    ...actual,
    useBotSubscriptionForHost: (args: {
      readonly hostId: string;
      readonly botId: string;
      readonly enabled: boolean;
    }) =>
      actual.useBotSubscriptionForClient({
        ...args,
        client: stream.client,
      }),
  };
});

const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const HOST_ID = "host-1";

/** The channel the reader asks about; `null` for none. */
let readBotId: string | null = BOT_ID;

const REPLYING: BotSessionActivity = {
  state: "replying",
  startedAt: 1_760_000_000_000,
  step: "Ran bun test",
  requestId: "req-1",
  reason: null,
};
const FAILED: BotSessionActivity = {
  state: "failed",
  startedAt: null,
  step: null,
  requestId: "req-2",
  reason: null,
};

function snapshot(activity: BotActivity | null): BotSubscribeServerFrame {
  return {
    kind: "snapshot",
    bot: {
      botId: BOT_ID,
      environmentId: "env-1",
      createdByUserId: "user-1",
      title: "Tracy",
      harness: "claude",
      model: "claude-opus-5-5",
      effort: null,
      profile: null,
      trunkChatId: "trunk-1",
      boundHostId: HOST_ID,
      hostEpoch: 0,
      createdAt: 1,
      archivedAt: null,
      directive: null,
      replyMode: "direct",
      appConversationChatId: null,
    },
    tasks: [],
    openRequestCount: 0,
    conversationsRevision: 0,
    notificationSubscriptions: null,
    surfaceActions: null,
    stoppedNotificationWatches: null,
    boundHost: { hostId: HOST_ID, epoch: 0, isThisHost: activity !== null },
    activity,
    hasBinaryPayload: false,
  };
}

function activityFrame(
  target:
    | { readonly kind: "trunk" }
    | { readonly kind: "thread"; readonly threadId: string },
  entry: BotSessionActivity | null,
): BotSubscribeServerFrame {
  return { kind: "activity", target, entry, hasBinaryPayload: false };
}

function mount(): {
  readonly session: StubSession;
  readonly current: () => BotActivity | null;
} {
  const session = new StubSession();
  stream.client = new StubHostStreamClient(session);
  let seen: BotActivity | null = null;

  function Reader(): ReactNode {
    seen = useBotActivity(readBotId);
    return null;
  }

  render(
    <QueryClientProvider client={new QueryClient()}>
      <Reader />
    </QueryClientProvider>,
  );
  return { session, current: () => seen };
}

beforeEach(() => {
  readBotId = BOT_ID;
  useTracySurfaceStore.getState().openSurface(HOST_ID);
});

afterEach(() => {
  cleanup();
  __resetBotSubscriptionsForTesting();
  useTracySurfaceStore.setState(useTracySurfaceStore.getInitialState(), true);
  stream.client = null;
});

describe("useBotActivity", () => {
  it("follows the snapshot and replaces one entry per activity frame", () => {
    const tab = mount();
    expect(tab.current()).toBeNull();

    act(() => tab.session.emit(snapshot({ trunk: null, threads: {} })));
    expect(tab.current()).toEqual({ trunk: null, threads: {} });

    act(() => tab.session.emit(activityFrame({ kind: "trunk" }, REPLYING)));
    act(() =>
      tab.session.emit(
        activityFrame({ kind: "thread", threadId: "thread-1" }, FAILED),
      ),
    );
    expect(tab.current()).toEqual({
      trunk: REPLYING,
      threads: { "thread-1": FAILED },
    });

    act(() =>
      tab.session.emit(
        activityFrame({ kind: "thread", threadId: "thread-1" }, null),
      ),
    );
    act(() =>
      tab.session.emit(
        activityFrame(
          { kind: "trunk" },
          { ...REPLYING, step: "Read src/app.ts" },
        ),
      ),
    );
    expect(tab.current()).toEqual({
      trunk: { ...REPLYING, step: "Read src/app.ts" },
      threads: {},
    });
  });

  it("takes a later snapshot whole, over the entries the frames moved", () => {
    const tab = mount();
    act(() => tab.session.emit(snapshot({ trunk: REPLYING, threads: {} })));
    act(() =>
      tab.session.emit(
        activityFrame({ kind: "thread", threadId: "thread-1" }, FAILED),
      ),
    );

    act(() =>
      tab.session.emit(
        snapshot({ trunk: null, threads: { "thread-2": REPLYING } }),
      ),
    );
    expect(tab.current()).toEqual({
      trunk: null,
      threads: { "thread-2": REPLYING },
    });
  });

  it("keeps the activity while the stream reconnects, and reads nothing once it closed for good", () => {
    const tab = mount();
    act(() => tab.session.emit(snapshot({ trunk: REPLYING, threads: {} })));

    act(() =>
      tab.session.status("closed", {
        kind: "fatalError",
        details: {
          code: "HOST_RESTARTING",
          reason: "The host is restarting.",
          incompatibleMethods: null,
          upgradeGuidance: null,
          retryable: true,
        },
      }),
    );
    expect(tab.current()).toEqual({ trunk: REPLYING, threads: {} });

    act(() =>
      tab.session.status("closed", {
        kind: "fatalError",
        details: {
          code: "BOT_NOT_FOUND",
          reason: "The bot is gone.",
          incompatibleMethods: null,
          upgradeGuidance: null,
          retryable: false,
        },
      }),
    );
    expect(tab.current()).toBeNull();
  });

  it("reads nothing while the surface is closed, and opens no stream", () => {
    useTracySurfaceStore.getState().closeSurface();
    const tab = mount();

    expect(tab.current()).toBeNull();
    expect(stream.client?.opened).toEqual([]);
  });

  it("reads nothing for no channel, and opens no stream", () => {
    readBotId = null;
    const tab = mount();

    expect(tab.current()).toBeNull();
    expect(stream.client?.opened).toEqual([]);
  });

  it("reads nothing from a host that does not run the bot", () => {
    const tab = mount();
    act(() => tab.session.emit(snapshot(null)));
    act(() => tab.session.emit(activityFrame({ kind: "trunk" }, REPLYING)));

    expect(tab.current()).toBeNull();
  });
});

describe("replyingSessionOf and botWorkingOf", () => {
  const IDLE: BotSessionActivity = {
    state: "idle",
    startedAt: null,
    step: null,
    requestId: null,
    reason: null,
  };
  const LATER: BotSessionActivity = {
    ...REPLYING,
    startedAt: 2_000,
    step: "later",
  };
  const EARLIER: BotSessionActivity = {
    ...REPLYING,
    startedAt: 1_000,
    step: "earlier",
  };

  it("names the trunk's turn before a thread's, and the earliest-started of several threads", () => {
    expect(replyingSessionOf({ trunk: LATER, threads: { a: EARLIER } })).toBe(
      LATER,
    );
    expect(
      replyingSessionOf({ trunk: IDLE, threads: { a: LATER, b: EARLIER } }),
    ).toBe(EARLIER);
    expect(
      replyingSessionOf({
        trunk: null,
        threads: { a: { ...REPLYING, startedAt: null }, b: EARLIER },
      }),
    ).toBe(EARLIER);
  });

  it("is null while nothing replies, a failed or parked session included", () => {
    expect(replyingSessionOf(null)).toBeNull();
    expect(
      replyingSessionOf({ trunk: IDLE, threads: { a: FAILED } }),
    ).toBeNull();
  });

  it("says working for any replying session, idle once the trunk is known and none replies, and unknown otherwise", () => {
    expect(botWorkingOf({ trunk: null, threads: { a: EARLIER } })).toBe(true);
    expect(botWorkingOf({ trunk: IDLE, threads: { a: IDLE } })).toBe(false);
    expect(botWorkingOf({ trunk: null, threads: {} })).toBeNull();
    expect(botWorkingOf(null)).toBeNull();
  });
});

describe("failedOn and failedOnRequest", () => {
  const PARKED: BotSessionActivity = {
    state: "parked",
    startedAt: null,
    step: null,
    requestId: "req-3",
    reason: null,
  };

  it.each([
    ["failed", FAILED],
    ["parked", PARKED],
  ])(
    "holds a %s session to the request it carries, and to no other",
    (_state, session) => {
      expect(failedOn(session, session.requestId ?? "")).toBe(session);
      expect(failedOn(session, "req-other")).toBeNull();
    },
  );

  it("offers nothing on a session that is replying, idle, or unknown, even on its request", () => {
    expect(failedOn(REPLYING, "req-1")).toBeNull();
    expect(failedOn({ ...PARKED, state: "idle" }, "req-3")).toBeNull();
    expect(failedOn(null, "req-3")).toBeNull();
  });

  it("offers nothing on a parked session that carries no request", () => {
    const parkedWithNone: BotSessionActivity = { ...PARKED, requestId: null };

    expect(failedOn(parkedWithNone, "req-3")).toBeNull();
    expect(
      failedOnRequest({ trunk: parkedWithNone, threads: {} }, "req-3"),
    ).toBeNull();
  });

  it("finds the session holding a parked request, on the trunk or on any thread", () => {
    expect(failedOnRequest({ trunk: PARKED, threads: {} }, "req-3")).toBe(
      PARKED,
    );
    expect(
      failedOnRequest(
        { trunk: null, threads: { a: REPLYING, b: PARKED } },
        "req-3",
      ),
    ).toBe(PARKED);
    expect(
      failedOnRequest({ trunk: null, threads: { a: FAILED } }, "req-3"),
    ).toBeNull();
    expect(failedOnRequest(null, "req-3")).toBeNull();
  });
});
