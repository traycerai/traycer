/**
 * A thread opened at Send, wherever the rail holds it by the time the host
 * answers (Tracy Bots T249): on top, behind the memory, behind a pair's log or
 * a search, or behind a log over the memory. The send's refusal or answer
 * settles the thread it opened by identity, never by position: the overlay is
 * left as it is, another bot's thread and another send's thread are left as
 * they are, and a place restored over the removal draws no loading thread. The
 * real tab surface and place route over a host that holds each send.
 */
import { emptyBotMentionHostListsMock } from "@/components/bots/__tests__/bot-mention-host-test-support";
import {
  botListChangedMock,
  botListQueryMock,
  botMemoryMock,
  botMutationsMock,
  botSubscriptionMock,
  cloudEpicTasksMock,
  connectableHostIdsMock,
  environmentListMock,
  environmentMembersMock,
  epicTaskContextsMock,
  hostClientForHostIdMock,
  hostDirectoryListMock,
  hostEnvironmentBindingsMock,
  hostQueriesMock,
  hostSupportsMethodMock,
  mocks,
  notificationHostMock,
  tabHostProviderMock,
  tabNavigationMock,
} from "@/components/bots/__tests__/bot-tab-surface-mocks";
import {
  botConversationListMock,
  botThreadListChannelMock,
  chatLocateRowMock,
  chatSessionRegistryMock,
  firstSend,
  guiHarnessCatalogMock,
  heldHost,
  notificationMarkReadMock,
  resolvedThemeMock,
  scene,
  sendLineScripted,
  type LocateAnswer,
  tabHostRequester,
} from "@/components/bots/__tests__/bot-sent-post-scene";

import { QueryClient } from "@tanstack/react-query";
import type { Message } from "@traycer/protocol/persistence/epic/schemas";
import type { ComponentProps } from "react";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  endBotTabSurfaceCase,
  resetBotTabSurfaceMocks,
  BOT_ID,
} from "@/components/bots/__tests__/bot-tab-surface-harness";
import {
  notWrittenRefusal,
  unmarkedRefusal,
} from "@/components/bots/__tests__/bot-send-identity-test-support";
import { BOT_CONVERSATION_NONCE_VERSION } from "@/hooks/bots/use-bot-send-version";
import {
  EARLIER_POST,
  TEXT_A,
  USER_A,
  endCase,
  heldRail,
  watchThreadRail,
  mountSurfaceOnRouteAs,
  type PlaceRoute,
  pressSend,
  routeNames,
  startCase,
} from "@/components/bots/__tests__/bot-sent-post-test-support";
import { memberPost } from "@/components/bots/__tests__/bot-turn-test-support";
import { historyEntryIdentity } from "@/lib/bots/tracy-place-traversal";
import { currentBotLifetime } from "@/lib/bots/bot-lifetime";
import {
  exchangeRailOver,
  memoryRailOver,
  searchRailOver,
  settleSentThread,
  useBotOpenThreadStore,
  type BotRail,
} from "@/stores/bots/bot-open-thread-store";

// Only `useNavigate` is scripted: the real channel and thread panel read the router's other hooks, bare.
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => mocks.navigate,
}));
vi.mock("@/lib/tab-navigation", async (importOriginal) =>
  tabNavigationMock(
    await importOriginal<typeof import("@/lib/tab-navigation")>(),
  ),
);
vi.mock(
  "@/hooks/epic/use-epic-get-task-contexts-query",
  () => epicTaskContextsMock,
);
vi.mock("@/hooks/epics/use-cloud-epic-tasks-query", async (importOriginal) =>
  cloudEpicTasksMock(
    await importOriginal<
      typeof import("@/hooks/epics/use-cloud-epic-tasks-query")
    >(),
  ),
);
vi.mock("@/hooks/host/use-host-supports-method", () =>
  sendLineScripted(hostSupportsMethodMock),
);
vi.mock(
  "@/hooks/notifications/use-notification-host",
  () => notificationHostMock,
);
vi.mock(
  "@/hooks/host/use-host-client-for-host-id",
  () => hostClientForHostIdMock,
);
vi.mock("@/hooks/host/use-host-queries", () => hostQueriesMock);
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostBinding: () => mocks.binding,
  useHostClient: () => null,
}));
vi.mock("@/hooks/sandboxes/use-sandbox-defaults", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/sandboxes/use-sandbox-defaults")
  >()),
  useSandboxDefaults: (environmentIds: readonly string[]) =>
    new Map(environmentIds.map((id) => [id, mocks.sandboxDefaults])),
}));
vi.mock(
  "@/hooks/bots/use-host-environment-bindings-query",
  () => hostEnvironmentBindingsMock,
);
vi.mock(
  "@/hooks/bots/use-environment-members-query",
  () => environmentMembersMock,
);
vi.mock(
  "@/components/epic-canvas/tab-host-provider",
  () => tabHostProviderMock,
);
// The tab's host client is the one that holds the send and logs every request.
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => tabHostRequester(),
}));
vi.mock(
  "@/components/epic-tabs/pane-visibility-context",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/components/epic-tabs/pane-visibility-context")
    >()),
    usePaneVisible: () => mocks.state.paneVisible,
    usePaneFocused: () => true,
    usePaneFocusProbe: () => () => true,
  }),
);
vi.mock(
  "@/hooks/bots/use-environment-host-lists-query",
  () => emptyBotMentionHostListsMock,
);
vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => null,
}));
vi.mock("@/hooks/bots/use-bot-memory", () => botMemoryMock);
vi.mock("@/hooks/bots/use-bot-subscription", () => botSubscriptionMock);
vi.mock("@/hooks/host/use-connectable-host-ids", () => connectableHostIdsMock);
vi.mock(
  "@/hooks/host/use-host-directory-list-query",
  () => hostDirectoryListMock,
);
vi.mock("@/hooks/bots/use-bot-list-query", () => botListQueryMock);
vi.mock(
  "@/hooks/bots/use-bot-list-changed-subscription",
  () => botListChangedMock,
);
vi.mock("@/hooks/bots/use-environment-list-query", () => environmentListMock);
// Only `bot.open` is scripted: the send mutation is the real one.
vi.mock("@/hooks/bots/use-bot-mutations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/bots/use-bot-mutations")>()),
  ...botMutationsMock,
}));
vi.mock("@/components/bots/bot-channel-sidebar", () => ({
  BotChannelSidebar: () => null,
}));
vi.mock("@/components/bots/bot-session-view", () => ({
  BotSessionView: () => null,
}));
vi.mock("@/components/bots/bot-activity-page", () => ({
  BotActivityPage: () => null,
}));
vi.mock("@/components/bots/bot-threads-view", () => ({
  BotThreadsView: () => null,
}));
vi.mock("@/components/bots/bot-settings-panel", () => ({
  BotChannelSettingsPanel: () => null,
}));
vi.mock(
  "@/hooks/bots/use-bot-thread-list-query",
  () => botThreadListChannelMock,
);
vi.mock("@/lib/registries/chat-session-registry", async (importOriginal) =>
  chatSessionRegistryMock(
    await importOriginal<
      typeof import("@/lib/registries/chat-session-registry")
    >(),
  ),
);
vi.mock(
  "@/hooks/bots/use-bot-conversation-list-query",
  () => botConversationListMock,
);
vi.mock(
  "@/hooks/notifications/use-notification-mark-entity-read-mutation",
  () => notificationMarkReadMock,
);
vi.mock(
  "@/hooks/harnesses/use-gui-harness-catalog",
  () => guiHarnessCatalogMock,
);
vi.mock("@/hooks/chats/use-chat-locate-row", () => chatLocateRowMock);
vi.mock("@/providers/use-resolved-theme", () => resolvedThemeMock);
vi.mock("@/components/chat/chat-messages", async () => {
  const { chatMessagesStubModule } =
    await import("@/components/bots/__tests__/bot-sent-post-chat-stub");
  return chatMessagesStubModule;
});
// The real thread panel and thread origin, wrapped to record what each render was given.
vi.mock("@/components/bots/bot-thread-panel", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/components/bots/bot-thread-panel")>();
  return {
    ...original,
    BotThreadPanel: (props: ComponentProps<typeof original.BotThreadPanel>) => {
      scene.panelKinds.push(props.thread.kind);
      return <original.BotThreadPanel {...props} />;
    },
  };
});
vi.mock("@/lib/bots/reply-row", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/lib/bots/reply-row")>();
  return {
    ...original,
    threadOriginRow: (
      input: Parameters<typeof original.threadOriginRow>[0],
    ) => {
      scene.originSents.push(input.sent);
      return original.threadOriginRow(input);
    },
  };
});

/** The host line that takes a send's nonce. */
const NONCE_HOST = BOT_CONVERSATION_NONCE_VERSION;

let queryClient: QueryClient;

beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  resetBotTabSurfaceMocks();
  startCase(NONCE_HOST, [EARLIER_POST], "thread");
});

afterEach(() => {
  endBotTabSurfaceCase(queryClient);
  endCase();
});

const ABSENT: LocateAnswer = { status: "missing", cause: "absent" };
const TEXT_B = "Did the deploy finish?";
const PEER = "bot-peer";

/** Send from the mounted surface: the host holds it and the post's thread is open at Send. */
async function sendHeld(text: string): Promise<void> {
  const sends = heldHost().sends.length;
  pressSend(text);
  await waitFor(() => expect(heldHost().sends).toHaveLength(sends + 1));
}

async function stepBack({ history }: PlaceRoute): Promise<void> {
  const before = historyEntryIdentity(history.location);
  await act(async () => {
    history.back();
    await Promise.resolve();
  });
  await waitFor(() =>
    expect(historyEntryIdentity(history.location)).not.toBe(before),
  );
}

function setRail(rail: BotRail | null): void {
  act(() =>
    useBotOpenThreadStore
      .getState()
      .setRail(BOT_ID, rail, currentBotLifetime()),
  );
}

/** What the rail shows once every overlay is closed: the thread behind them, or nothing. */
function behindOverlays(rail: BotRail | null): BotRail | null {
  let shown = rail;
  while (shown !== null && shown.kind !== "thread") {
    if (shown.kind === "memory") {
      shown = shown.back === null ? null : { kind: "thread", ...shown.back };
    } else {
      shown = shown.back;
    }
  }
  return shown;
}

interface Position {
  readonly name: string;
  /** What the person opens over the thread, as the rail's own openers build it. */
  readonly over: (thread: BotRail | null) => BotRail;
  /** The route names the overlay as its own entry. */
  readonly fragment: string | null;
  /** The overlay left with no thread behind it. */
  readonly bare: BotRail;
}

const POSITIONS: readonly Position[] = [
  {
    name: "behind the memory",
    over: memoryRailOver,
    fragment: "memory",
    bare: { kind: "memory", back: null },
  },
  {
    name: "behind a pair's log",
    over: (thread) => exchangeRailOver(thread, PEER),
    fragment: "exchange",
    bare: { kind: "exchange", peerBotId: PEER, back: null },
  },
  {
    name: "behind a search",
    over: searchRailOver,
    fragment: null,
    bare: { kind: "search", back: null, showing: { kind: "results" } },
  },
  {
    name: "behind a pair's log over the memory",
    over: (thread) => exchangeRailOver(memoryRailOver(thread), PEER),
    fragment: "exchange",
    bare: {
      kind: "exchange",
      peerBotId: PEER,
      back: { kind: "memory", back: null },
    },
  },
];

const OUTCOMES = [
  {
    name: "the first attempt is refused",
    answer: () => firstSend().reject(notWrittenRefusal("refused")),
    removed: true,
  },
  {
    name: "the bot answers in the channel",
    answer: () => firstSend().resolve(null),
    removed: true,
  },
  {
    name: "the host names the thread",
    answer: () => firstSend().resolve("thread-from-receipt"),
    removed: false,
  },
] as const;

describe("a thread opened at Send, held under an overlay when the host answers", () => {
  describe.each(POSITIONS)("$name", (position) => {
    it.each(OUTCOMES)("when $name", async ({ answer, removed }) => {
      const route = await mountSurfaceOnRouteAs(USER_A, queryClient);
      await sendHeld(TEXT_A);
      await routeNames(route, "thread");
      setRail(position.over(heldRail()));
      if (position.fragment !== null) {
        await routeNames(route, position.fragment);
      }
      const length = route.history.length;
      expect(
        route.history.location.search,
        "the route did not name the thread before the host answered",
      ).toContain("thread");

      await act(async () => {
        answer();
        await Promise.resolve();
      });

      const rail = heldRail();
      if (removed) {
        expect(
          rail,
          "the overlay was not left exactly as it was, with no thread behind it",
        ).toEqual(position.bare);
        expect(behindOverlays(rail)).toBeNull();
        await waitFor(() =>
          expect(route.history.location.search).not.toContain("thread"),
        );
        expect(
          route.history.length,
          "the removal was pushed as a step of its own",
        ).toBe(length);
      } else {
        expect(rail?.kind).toBe(position.over(null).kind);
        const behind = behindOverlays(rail);
        expect(
          behind?.kind === "thread" && behind.sent,
          "the thread behind the overlay was not settled",
        ).toMatchObject({
          threadId: "thread-from-receipt",
          provisional: false,
        });
      }
    });
  });
});

describe("a thread settled by its own send, never by another's", () => {
  it("leaves another bot's provisional thread byte for byte as it was", () => {
    const sentOf = (requestId: string) => ({
      threadId: `thread-${requestId}`,
      requestId,
      text: TEXT_A,
      senderUserId: USER_A,
      sentAt: 1_000,
      delivery: "written" as const,
      provisional: true,
    });
    const threadRail = (requestId: string): BotRail => ({
      kind: "thread",
      anchorMessageId: `post-${requestId}`,
      announcement: false,
      anchorKind: null,
      sent: sentOf(requestId),
    });
    const lifetime = currentBotLifetime();
    const store = useBotOpenThreadStore.getState();
    store.setRail("bot-a", threadRail("req-a"), lifetime);
    store.setRail("bot-b", memoryRailOver(threadRail("req-b")), lifetime);
    const before = JSON.stringify(
      useBotOpenThreadStore.getState().byBotId["bot-b"],
    );

    settleSentThread("bot-a", "req-a", { kind: "refused" }, lifetime);
    settleSentThread(
      "bot-a",
      "req-a",
      { kind: "answered", threadId: "thread-x", delivery: "written" },
      lifetime,
    );

    expect(
      JSON.stringify(useBotOpenThreadStore.getState().byBotId["bot-b"]),
    ).toBe(before);
  });

  it.each([
    {
      name: "refused",
      answer: () => heldHost().sends[2].reject(notWrittenRefusal("refused")),
    },
    {
      name: "answered with a thread",
      answer: () => heldHost().sends[2].resolve("thread-from-receipt"),
    },
    {
      name: "answered in the channel",
      answer: () => heldHost().sends[2].resolve(null),
    },
  ])(
    "leaves the thread of a second Send alone when the first's Retry is $name after it",
    async ({ answer }) => {
      const user = userEvent.setup();
      await mountSurfaceOnRouteAs(USER_A, queryClient);
      await sendHeld(TEXT_A);
      // The first attempt is uncertain, so the box may send again, and the
      // second Send opens its own thread over the first's.
      await act(async () => {
        firstSend().reject(unmarkedRefusal("timed out"));
        await Promise.resolve();
      });
      await screen.findAllByText(/not confirmed/i);
      await sendHeld(TEXT_B);
      await waitFor(() => {
        const rail = heldRail();
        expect(rail?.kind === "thread" && rail.sent?.text).toBe(TEXT_B);
      });
      await user.click(await screen.findByRole("button", { name: "Retry" }));
      await waitFor(() => expect(heldHost().sends).toHaveLength(3));
      const before = JSON.stringify(heldRail());

      await act(async () => {
        answer();
        await Promise.resolve();
      });

      expect(JSON.stringify(heldRail())).toBe(before);
    },
  );

  it("keeps an announcement's thread with the second reply's send when the first is refused", () => {
    const lifetime = currentBotLifetime();
    const second: BotRail = {
      kind: "thread",
      anchorMessageId: "announcement-1",
      announcement: true,
      anchorKind: null,
      sent: {
        threadId: "thread-announcement",
        requestId: "req-second",
        text: TEXT_B,
        senderUserId: USER_A,
        sentAt: 2_000,
        delivery: "written",
        provisional: true,
      },
    };
    useBotOpenThreadStore.getState().setRail(BOT_ID, second, lifetime);

    settleSentThread(BOT_ID, "req-first", { kind: "refused" }, lifetime);

    expect(heldRail()).toEqual(second);
  });
});

describe("a place restored over a thread removed in place", () => {
  it.each([
    { name: "the memory", over: memoryRailOver, fragment: "memory" },
    {
      name: "a pair's log",
      over: (thread: BotRail | null) => exchangeRailOver(thread, PEER),
      fragment: "exchange",
    },
  ])(
    "closes the post's rail with no thread loading when Back lands on the Send's entry past $name",
    async ({ over, fragment }) => {
      const route = await mountSurfaceOnRouteAs(USER_A, queryClient);
      scene.locate = ABSENT;
      await sendHeld(TEXT_A);
      await routeNames(route, "thread");
      setRail(over(heldRail()));
      await routeNames(route, fragment);
      expect(
        route.history.location.search,
        "the route did not name the thread before the host answered",
      ).toContain("thread");
      await act(async () => {
        firstSend().reject(notWrittenRefusal("refused"));
        await Promise.resolve();
      });
      await waitFor(() =>
        expect(route.history.location.search).not.toContain("thread"),
      );

      const sawThread = watchThreadRail();
      await stepBack(route);

      await waitFor(() => expect(heldRail()).toBeNull());
      expect(sawThread(), "Back restored no thread rail to close").toBe(true);
      expect(screen.queryByTestId("bot-thread-loading")).toBeNull();
      expect(route.history.location.search).not.toContain("thread");
    },
  );
});

describe("a place restored after the bot answered in the channel while the memory was over the thread", () => {
  const STORED_TEXT = "Is the nightly build green?";

  /** The stored row of the post, under the id its thread was opened on, in words other than the ones sent. */
  function storedRow(messageId: string): Message {
    const post = memberPost({
      messageId,
      requestId: "req-stored",
      lines: [STORED_TEXT],
      timestamp: 1_000,
      resolvedBy: null,
    });
    // The host stores a post the bot answered in the channel as `direct`.
    return {
      ...post,
      conversationRequest: {
        requestId: "req-stored",
        resolvedAt: null,
        resolvedByMessageId: null,
        direct: true,
      },
    };
  }

  it("opens the box that starts the post's thread, its origin the stored row with no mark and no Retry, and does not close it", async () => {
    const route = await mountSurfaceOnRouteAs(USER_A, queryClient);
    await sendHeld(TEXT_A);
    await routeNames(route, "thread");
    const sent = heldRail();
    const anchorMessageId =
      sent?.kind === "thread" ? sent.anchorMessageId : "no thread";
    setRail(memoryRailOver(sent));
    await routeNames(route, "memory");
    expect(
      route.history.location.search,
      "the route did not name the thread before the host answered",
    ).toContain("thread");
    // The bot answered in the channel: the post's row exists, in other words
    // than the person typed.
    act(() => {
      scene.channelHandle?.store.setState({
        messages: [EARLIER_POST, storedRow(anchorMessageId)],
      });
    });
    await act(async () => {
      firstSend().resolve(null);
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(route.history.location.search).not.toContain("thread"),
    );

    await stepBack(route);

    const panel = await screen.findByTestId("bot-thread-panel");
    const rail = heldRail();
    expect(rail?.kind).toBe("thread");
    expect(rail?.kind === "thread" && rail.anchorMessageId).toBe(
      anchorMessageId,
    );
    expect(
      rail?.kind === "thread" && rail.sent,
      "nothing is provisional once the post's row exists",
    ).toBeNull();
    const origin = within(panel).getByTestId("bot-thread-anchor");
    expect(
      origin.textContent,
      "the origin was drawn from what was sent, not from the stored row",
    ).toContain(STORED_TEXT);
    expect(origin.textContent).not.toContain(TEXT_A);
    expect(within(origin).queryByText(/Not confirmed/)).toBeNull();
    expect(within(origin).queryByRole("button", { name: "Retry" })).toBeNull();
    // The post the bot answered in the channel has no thread: the panel is
    // the post over the box that starts one.
    expect(
      within(panel).getByRole("group", { name: "Reply in a new thread" }),
    ).toBeDefined();
    expect(within(panel).queryByTestId("bot-thread-loading")).toBeNull();
  });
});

describe("a Retry's answer while the thread is under the memory", () => {
  it("settles the thread in place under the memory", async () => {
    const user = userEvent.setup();
    const route = await mountSurfaceOnRouteAs(USER_A, queryClient);
    await sendHeld(TEXT_A);
    await routeNames(route, "thread");
    await act(async () => {
      firstSend().reject(unmarkedRefusal("timed out"));
      await Promise.resolve();
    });
    await screen.findAllByText(/not confirmed/i);
    setRail(memoryRailOver(heldRail()));
    await routeNames(route, "memory");

    await user.click(await screen.findByRole("button", { name: "Retry" }));
    await waitFor(() => expect(heldHost().sends).toHaveLength(2));
    await act(async () => {
      heldHost().sends[1].resolve("thread-from-receipt");
      await Promise.resolve();
    });

    const behind = behindOverlays(heldRail());
    expect(heldRail()?.kind).toBe("memory");
    expect(
      behind?.kind === "thread" && behind.sent,
      "the Retry's answer did not settle the thread under the memory",
    ).toMatchObject({ threadId: "thread-from-receipt", provisional: false });
  });
});
