import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import type { IHostDirectoryService } from "@traycer-clients/shared/host-client/host-runtime";

type ActivationResultSpy = Mock<(outcome: "success" | "failure") => void>;

const navigateSpy = vi.hoisted(() =>
  vi.fn<(options: unknown) => Promise<void>>(),
);

/** What the landing store held when each navigation ran: a navigation that never commits its channel releases its landing straight after. */
const landingAtNavigation = vi.hoisted(() => ({
  seen: [] as Array<Record<string, unknown>>,
}));

/** What the host answers, by method: a case sets each, and may hold one. */
interface HostAnswers {
  [method: string]: ((params: unknown) => Promise<unknown>) | undefined;
}

const host = vi.hoisted(() => ({
  answers: {} as HostAnswers,
  requests: [] as Array<{ readonly method: string; readonly params: unknown }>,
}));

interface StubHostClient {
  readonly getActiveHostId: () => string | null;
  readonly createRequesterForHostId: (hostId: string | null) => StubHostClient;
  readonly request: (method: string, params: unknown) => Promise<unknown>;
  readonly requestWithSignal: (
    method: string,
    params: unknown,
  ) => Promise<unknown>;
  readonly requestWithSignalRequiringHostMethodVersion: (
    method: string,
    params: unknown,
  ) => Promise<unknown>;
}

const bindingState = vi.hoisted<{
  current: {
    readonly hostClient: StubHostClient;
    readonly directory: IHostDirectoryService;
  } | null;
}>(() => ({ current: null }));

vi.mock("@tanstack/react-router", async (importActual) => {
  const actual = await importActual<typeof import("@tanstack/react-router")>();
  return { ...actual, useNavigate: () => navigateSpy };
});

vi.mock("@/lib/host", () => ({
  useHostBinding: () => bindingState.current,
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

import { useNotificationActivation } from "@/hooks/notifications/use-notification-activation";
import {
  __resetTabNavigationControllerForTesting,
  __resetTabNavigationHydrationForTesting,
  navigateToTabIntent,
  tabNavigationController,
} from "@/lib/tab-navigation";
import {
  __resetTabSyncCoordinatorForTesting,
  installTabSyncCoordinator,
} from "@/lib/tab-sync/tab-sync-coordinator";
import { botMember } from "@/components/notifications/__tests__/notification-bot-members-test-support";
import { homeTabIntent } from "@/lib/tab-navigation/intents";
import type { NotificationPayload } from "@/lib/notifications/payload";
import {
  rowFromHostEntry,
  type MergedNotificationRow,
} from "@/stores/notifications/merged-notifications";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useBotTabLandingStore } from "@/stores/bots/bot-tab-landing-store";
import { useTracySurfaceStore } from "@/stores/bots/tracy-surface-store";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";

/**
 * A bot row opens the bot's channel only where the host's own answers say the
 * row's destination is the bot's main channel, or a thread of it. The real
 * activation hook runs over a host that answers `bot.read` (the bot's main
 * channel) and `bot.thread.list` (the authorized thread summaries); a case
 * holds one answer to see that nothing is staged, navigated or acknowledged
 * before it arrives.
 */

const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const MAIN = "conversation-main";
const SIDE = "conversation-side";
const HOST_ID = "host-1";

function botRecord(main: string | null): unknown {
  return {
    bot: {
      botId: BOT_ID,
      title: "Tracy",
      appConversationChatId: main,
      trunkChatId: `trunk-${BOT_ID}`,
      archivedAt: null,
    },
  };
}

interface Summary {
  readonly threadId: string;
  readonly conversationId: string;
  readonly anchor: { readonly messageId: string } | null;
}

function threadList(summaries: ReadonlyArray<Summary>): unknown {
  return {
    threads: summaries.map((summary) => ({
      ...summary,
      sessionChatId: `session-${summary.threadId}`,
      replyCount: 1,
      lastReplyAt: 2_000,
      openRequestCount: 0,
      costUsd: null,
      anchor:
        summary.anchor === null
          ? null
          : {
              messageId: summary.anchor.messageId,
              requestId: `req-${summary.threadId}`,
              senderUserId: "user-other",
              sentAt: 1_000,
              resolvedAt: null,
              excerpt: null,
            },
    })),
    trunkCostUsd: null,
    threadAnchors: null,
    nextCursor: null,
    total: summaries.length,
  };
}

const MAIN_POST = rowOf({ conversationId: MAIN, threadId: null });

/** The feed row of a post or reply, as the producer writes it, in `conversationId` and `threadId`. */
function rowOfMessage(
  input: {
    readonly conversationId: string;
    readonly threadId: string | null;
  },
  messageId: string,
): MergedNotificationRow {
  const entry = botMember(messageId, 100, "A message", {
    event: input.threadId === null ? "post" : "reply",
    severity: input.threadId === null ? "info" : "done",
    conversationId: input.conversationId,
    threadId: input.threadId,
    messageId,
  });
  return rowFromHostEntry(entry);
}

function rowOf(input: {
  readonly conversationId: string;
  readonly threadId: string | null;
}): MergedNotificationRow {
  return rowOfMessage(input, "message-1");
}

function legacyVerdictRow(threadId: string): MergedNotificationRow {
  return rowFromHostEntry({
    id: "verdict-1",
    updatedAt: 100,
    readAt: null,
    kind: "host.operation.finished",
    sourceRef: "verdict-1",
    severity: "done",
    outcome: "completed",
    epicId: BOT_ID,
    chatId: threadId,
    payload: {
      kind: "bot_thread_verdict",
      operation: "bot.thread.verdict",
      title: "Tracy answered",
      message: "A verdict",
      botId: BOT_ID,
      threadId,
      replyMessageId: "message-1",
    },
  });
}

function bindHost(): void {
  const answer = (method: string, params: unknown): Promise<unknown> => {
    host.requests.push({ method, params });
    const handler = host.answers[method];
    if (handler === undefined) return Promise.resolve({});
    return handler(params);
  };
  const hostClient: StubHostClient = {
    getActiveHostId: () => HOST_ID,
    createRequesterForHostId: () => hostClient,
    request: answer,
    requestWithSignal: answer,
    requestWithSignalRequiringHostMethodVersion: answer,
  };
  const entries: readonly never[] = [];
  bindingState.current = {
    hostClient,
    directory: {
      list: () => Promise.resolve(entries),
      findById: () => null,
      refresh: () => Promise.resolve(entries),
      refreshForEra: () => Promise.resolve(entries),
      invalidateInFlightRefresh: () => undefined,
    },
  };
}

/** A host answer that stays pending until the case releases it. */
function held<T>(): {
  readonly answer: () => Promise<T>;
  readonly release: (value: T) => void;
  readonly fail: (error: Error) => void;
} {
  let release: (value: T) => void = () => undefined;
  let fail: (error: Error) => void = () => undefined;
  const pending = new Promise<T>((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
  return { answer: () => pending, release, fail };
}

function wrapper(props: { readonly children: ReactNode }): ReactNode {
  return createElement(
    QueryClientProvider,
    { client: new QueryClient() },
    props.children,
  );
}

/** Waits for the host to have been asked `method`: the event a held case acts on. */
async function requested(method: string): Promise<void> {
  await waitFor(() => {
    expect(host.requests.map((request) => request.method)).toContain(method);
  });
}

/** Waits for the activation to have reported its outcome. */
async function reported(onResult: ActivationResultSpy): Promise<void> {
  await waitFor(() => {
    expect(onResult).toHaveBeenCalled();
  });
}

/**
 * That an activation never navigated is only proved once later work has gone
 * through: a valid activation of another message completes, and the
 * navigations seen are then that one's alone.
 */
async function laterActivationCompletes(messageId: string): Promise<void> {
  const before = navigateSpy.mock.calls.length;
  host.answers["bot.read"] = () => Promise.resolve(botRecord(MAIN));
  activateRow(
    rowOfMessage({ conversationId: MAIN, threadId: null }, messageId),
    vi.fn(),
  );
  await waitFor(() => {
    expect(navigateSpy.mock.calls.length).toBe(before + 1);
  });
}

function landedMessages(): ReadonlyArray<unknown> {
  return landingAtNavigation.seen.map((landing) => {
    const entry = landing[BOT_ID];
    return typeof entry === "object" && entry !== null && "messageId" in entry
      ? entry.messageId
      : undefined;
  });
}

function activatePayload(
  payload: NotificationPayload,
  feedId: string,
  onResult: (outcome: "success" | "failure") => void,
): { readonly unmount: () => void } {
  const hook = renderHook(() => useNotificationActivation(), { wrapper });
  act(() => {
    hook.result.current.activate({
      payload,
      receivedAt: 2_000,
      feedId,
      originHostId: null,
      onResult,
    });
  });
  return { unmount: hook.unmount };
}

function activateRow(
  row: MergedNotificationRow,
  onResult: (outcome: "success" | "failure") => void,
): { readonly unmount: () => void } {
  const { payload } = row;
  if (payload === null) throw new Error("the bot row carried no payload");
  return activatePayload(payload, row.feedId, onResult);
}

/** Nothing opened, staged or acknowledged: the surface stays shut and the row unread. */
function expectRefusedInPlace(onResult: ActivationResultSpy): void {
  expect(navigateSpy).not.toHaveBeenCalled();
  expect(useTracySurfaceStore.getState().open).toBe(false);
  expect(useBotTabLandingStore.getState().byBotId).toEqual({});
  expect(onResult.mock.calls).toEqual([["failure"]]);
  expect(host.requests.map((request) => request.method)).not.toContain(
    "host.notifications.markRead",
  );
}

beforeEach(async () => {
  __resetTabNavigationControllerForTesting();
  __resetTabSyncCoordinatorForTesting();
  installTabSyncCoordinator({ readyPromise: Promise.resolve() });
  await Promise.resolve();
  await Promise.resolve();
  useTracySurfaceStore.setState(useTracySurfaceStore.getInitialState(), true);
  useSelectionAuthorityStore.setState({ effectiveHostId: HOST_ID });
  useBotTabLandingStore.setState({ byBotId: {} });
  navigateSpy.mockReset();
  landingAtNavigation.seen = [];
  navigateSpy.mockImplementation(() => {
    landingAtNavigation.seen.push(useBotTabLandingStore.getState().byBotId);
    return Promise.resolve();
  });
  host.answers = {
    "bot.read": () => Promise.resolve(botRecord(MAIN)),
    "bot.thread.list": () => Promise.resolve(threadList([])),
  };
  host.requests = [];
  bindHost();
  useAuthStore
    .getState()
    .setSignedIn(
      { userId: "user-a", userName: "A", email: "a@example.com" },
      { userId: "user-a", username: "A" },
      [],
    );
});

afterEach(() => {
  cleanup();
  useAuthStore.getState().setSignedOut();
  bindingState.current = null;
});

describe("a bot row whose destination is not the bot's main channel", () => {
  it("opens nothing, stages nothing and leaves the row unread", async () => {
    const onResult = vi.fn();

    activateRow(rowOf({ conversationId: SIDE, threadId: null }), onResult);
    await reported(onResult);

    expectRefusedInPlace(onResult);
  });

  it.each([
    ["has no main channel", () => Promise.resolve(botRecord(null))],
    [
      "is refused by the host",
      () => Promise.reject(new Error("not authorized")),
    ],
  ])("refuses in place when the bot %s", async (_name, answer) => {
    host.answers["bot.read"] = answer;
    const onResult = vi.fn();

    activateRow(MAIN_POST, onResult);
    await reported(onResult);

    expectRefusedInPlace(onResult);
  });
});

describe("a bot row waiting for the host to say which channel is the bot's main", () => {
  it("opens and stages nothing until the answer arrives, then opens the main channel on the message without reporting success", async () => {
    const metadata = held<unknown>();
    host.answers["bot.read"] = metadata.answer;
    const onResult = vi.fn();

    activateRow(MAIN_POST, onResult);
    await requested("bot.read");

    expect(navigateSpy).not.toHaveBeenCalled();
    expect(useTracySurfaceStore.getState().open).toBe(false);
    expect(useBotTabLandingStore.getState().byBotId).toEqual({});
    expect(onResult).not.toHaveBeenCalled();

    metadata.release(botRecord(MAIN));
    await waitFor(() => {
      expect(navigateSpy).toHaveBeenCalledTimes(1);
    });

    expect(landedMessages()).toEqual(["message-1"]);
    // Routing the row is not showing the message: no acknowledgment yet.
    expect(onResult.mock.calls).not.toContainEqual(["success"]);
  });

  it("opens nothing when the answer is that the channel is another one", async () => {
    const metadata = held<unknown>();
    host.answers["bot.read"] = metadata.answer;
    const onResult = vi.fn();

    activateRow(MAIN_POST, onResult);
    await requested("bot.read");
    metadata.release(botRecord(SIDE));
    await reported(onResult);

    expectRefusedInPlace(onResult);
  });

  it("still opens the main channel when the popover that started it closes before the answer arrives", async () => {
    const metadata = held<unknown>();
    host.answers["bot.read"] = metadata.answer;
    const onResult = vi.fn();
    const first = activateRow(MAIN_POST, onResult);
    await requested("bot.read");

    first.unmount();
    metadata.release(botRecord(MAIN));
    await waitFor(() => {
      expect(navigateSpy).toHaveBeenCalledTimes(1);
    });

    expect(landedMessages()).toEqual(["message-1"]);
  });

  it("opens nothing when the Tracy surface is closed before the answer arrives", async () => {
    useTracySurfaceStore.getState().openSurface(HOST_ID);
    const metadata = held<unknown>();
    host.answers["bot.read"] = metadata.answer;
    activateRow(MAIN_POST, vi.fn());
    await requested("bot.read");

    act(() => {
      useTracySurfaceStore.getState().closeSurface();
    });
    metadata.release(botRecord(MAIN));
    await laterActivationCompletes("message-later");

    expect(landedMessages()).toEqual(["message-later"]);
  });

  it("opens nothing for the previous account when another signs in before the answer arrives", async () => {
    const metadata = held<unknown>();
    host.answers["bot.read"] = metadata.answer;
    activateRow(MAIN_POST, vi.fn());
    await requested("bot.read");

    act(() => {
      useAuthStore
        .getState()
        .setSignedIn(
          { userId: "user-b", userName: "B", email: "b@example.com" },
          { userId: "user-b", username: "B" },
          [],
        );
    });
    metadata.release(botRecord(MAIN));
    await laterActivationCompletes("message-later");

    expect(landedMessages()).toEqual(["message-later"]);
  });

  it("lets a later activation replace the one still waiting, and the first answer arriving after changes nothing", async () => {
    const firstAnswer = held<unknown>();
    const secondAnswer = held<unknown>();
    host.answers["bot.read"] = firstAnswer.answer;
    activateRow(MAIN_POST, vi.fn());
    await requested("bot.read");
    host.answers["bot.read"] = secondAnswer.answer;
    activateRow(
      rowOfMessage({ conversationId: MAIN, threadId: null }, "message-2"),
      vi.fn(),
    );
    await waitFor(() => {
      expect(
        host.requests.filter((request) => request.method === "bot.read"),
      ).toHaveLength(2);
    });

    secondAnswer.release(botRecord(MAIN));
    await waitFor(() => {
      expect(navigateSpy).toHaveBeenCalledTimes(1);
    });
    firstAnswer.release(botRecord(MAIN));
    await laterActivationCompletes("message-later");

    expect(landedMessages()).toEqual(["message-2", "message-later"]);
  });
});

describe("a bot row waiting for the host while the reader goes to another tab", () => {
  it("opens nothing, stages nothing and reads nothing when the answer arrives, and a later notification still opens its own message", async () => {
    const metadata = held<unknown>();
    host.answers["bot.read"] = metadata.answer;
    const onResult: ActivationResultSpy = vi.fn();
    activateRow(MAIN_POST, onResult);
    await requested("bot.read");

    act(() => {
      void navigateToTabIntent(navigateSpy, homeTabIntent(), undefined);
    });
    metadata.release(botRecord(MAIN));
    await laterActivationCompletes("message-later");

    expect(landedMessages().filter((message) => message !== undefined)).toEqual(
      ["message-later"],
    );
    expect(onResult.mock.calls).toEqual([["failure"]]);
    expect(host.requests.map((request) => request.method)).not.toContain(
      "host.notifications.markRead",
    );
  });
});

describe("a bot thread row", () => {
  const ANCHORED: Summary = {
    threadId: "thread-1",
    conversationId: MAIN,
    anchor: { messageId: "anchor-1" },
  };

  function threadsAre(summaries: ReadonlyArray<Summary>): void {
    host.answers["bot.thread.list"] = () =>
      Promise.resolve(threadList(summaries));
  }

  it("opens the main channel's thread on the message when the authorized summary, the row and the main channel agree, without reporting success", async () => {
    threadsAre([ANCHORED]);
    const onResult = vi.fn();

    activateRow(
      rowOf({ conversationId: MAIN, threadId: "thread-1" }),
      onResult,
    );
    await waitFor(() => {
      expect(navigateSpy).toHaveBeenCalledTimes(1);
    });

    expect(landedMessages()).toEqual(["message-1"]);
    expect(onResult.mock.calls).not.toContainEqual(["success"]);
    // The authorized summaries are the whole list, not a page of it.
    expect(
      host.requests.filter((request) => request.method === "bot.thread.list"),
    ).toEqual([
      {
        method: "bot.thread.list",
        params: { botId: BOT_ID, limit: null, cursor: null },
      },
    ]);
  });

  it.each([
    [
      "a thread of another conversation than the main channel",
      [{ ...ANCHORED, conversationId: SIDE }],
      { conversationId: SIDE, threadId: "thread-1" },
    ],
    [
      "a row that names another parent than the summary does",
      [ANCHORED],
      { conversationId: SIDE, threadId: "thread-1" },
    ],
    [
      "a thread with no anchor",
      [{ ...ANCHORED, anchor: null }],
      { conversationId: MAIN, threadId: "thread-1" },
    ],
    [
      "a thread the host does not list",
      [],
      { conversationId: MAIN, threadId: "thread-1" },
    ],
  ] as const)("refuses in place for %s", async (_name, summaries, row) => {
    threadsAre(summaries);
    const onResult = vi.fn();

    activateRow(rowOf(row), onResult);
    await reported(onResult);

    expectRefusedInPlace(onResult);
  });

  it("takes the parent of a legacy verdict from the authorized summary, and opens it where that is the main channel", async () => {
    threadsAre([ANCHORED]);

    activateRow(legacyVerdictRow("thread-1"), vi.fn());
    await waitFor(() => {
      expect(navigateSpy).toHaveBeenCalledTimes(1);
    });
  });

  it("refuses a legacy verdict whose authorized summary is not in the main channel", async () => {
    threadsAre([{ ...ANCHORED, conversationId: SIDE }]);
    const onResult = vi.fn();

    activateRow(legacyVerdictRow("thread-1"), onResult);
    await reported(onResult);

    expectRefusedInPlace(onResult);
  });
});

describe("a bot channel row that names no conversation", () => {
  it("refuses in place even where the bot has a main channel, rather than guessing the main", async () => {
    const onResult = vi.fn();

    activatePayload(
      {
        kind: "chat",
        epicId: BOT_ID,
        chatId: undefined,
        bot: { botId: BOT_ID, threadId: null, messageId: "message-1" },
      },
      "host:no-identity",
      onResult,
    );
    await reported(onResult);

    expectRefusedInPlace(onResult);
  });
});

describe("an activation validated while the tabs were still hydrating", () => {
  /** The tabs have not hydrated: a navigation is queued until the case hydrates them. */
  function holdHydration(): { readonly release: () => void } {
    __resetTabNavigationHydrationForTesting();
    return {
      release: () =>
        tabNavigationController.setHydrationReady(true, navigateSpy),
    };
  }

  /** The validated activation has opened the surface and is queued behind the hydration. */
  async function activateAndQueue(): Promise<ActivationResultSpy> {
    const onResult = vi.fn();
    activateRow(MAIN_POST, onResult);
    await requested("bot.read");
    await waitFor(() => {
      expect(useTracySurfaceStore.getState().open).toBe(true);
    });
    expect(navigateSpy).not.toHaveBeenCalled();
    return onResult;
  }

  it("navigates to the validated message once hydration finishes when nothing departed", async () => {
    const hydration = holdHydration();
    await activateAndQueue();

    act(() => {
      hydration.release();
    });
    await waitFor(() => {
      expect(navigateSpy).toHaveBeenCalledTimes(1);
    });

    expect(landedMessages()).toEqual(["message-1"]);
  });

  it.each([
    [
      "the account changes",
      () => {
        useAuthStore
          .getState()
          .setSignedIn(
            { userId: "user-b", userName: "B", email: "b@example.com" },
            { userId: "user-b", username: "B" },
            [],
          );
      },
    ],
    [
      "the Tracy surface closes",
      () => {
        useTracySurfaceStore.getState().closeSurface();
      },
    ],
  ])(
    "navigates nowhere once hydration finishes if %s first, and a later activation still opens its own message",
    async (_name, depart) => {
      const hydration = holdHydration();
      const onResult = await activateAndQueue();

      act(depart);
      await reported(onResult);
      act(() => {
        hydration.release();
      });
      await laterActivationCompletes("message-later");

      expect(landedMessages()).toEqual(["message-later"]);
    },
  );
});
