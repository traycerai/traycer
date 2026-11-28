/**
 * A post's thread restored by a place, a reload or a Back, before any thread
 * of it exists (Tracy Bots T536): the post the bot answered in the channel
 * (`direct`), or a bot row with no thread yet, opens as the box that starts
 * its thread, and a post whose thread the list has not named yet waits for the
 * list. The real tab surface and place route over a host that holds each send
 * and a thread list the case moves.
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
  threadListChanged,
  guiHarnessCatalogMock,
  heldHost,
  notificationMarkReadMock,
  resolvedThemeMock,
  scene,
  sendLineScripted,
  tabHostRequester,
} from "@/components/bots/__tests__/bot-sent-post-scene";

import {
  resetRecordedSends,
  settleSceneSend,
} from "@/components/bots/__tests__/bot-send-settle-test-support";
import { QueryClient } from "@tanstack/react-query";
import type { Message } from "@traycer/protocol/persistence/epic/schemas";
import type { ComponentProps } from "react";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
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
  markReadable,
  mountSurfaceOnRouteAs,
  mountSurfaceOnRouteAtEntry,
  type PlaceRoute,
  pressSend,
  routeNames,
  startCase,
} from "@/components/bots/__tests__/bot-sent-post-test-support";
import {
  botAnnouncement,
  botQuestion,
  botReply,
  memberPost,
} from "@/components/bots/__tests__/bot-turn-test-support";
import {
  textOf,
  typeInto,
} from "@/components/bots/__tests__/bot-box-test-support";
import {
  BOT_THREAD_ANCHOR_MESSAGE,
  type BotThreadSummary,
} from "@traycer/protocol/host/bot/conversation-schemas";
import { botThreadIdFor } from "@traycer/protocol/persistence/epic/messages";
import {
  hostFailure,
  transportFailure,
} from "@/lib/host/test-support/cloud-failure-reads";
import { historyEntryIdentity } from "@/lib/bots/tracy-place-traversal";
import { currentBotLifetime } from "@/lib/bots/bot-lifetime";
import {
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
vi.mock("@/hooks/bots/use-bot-mutations", async (importOriginal) => {
  const { withRecordedSends } =
    await import("@/components/bots/__tests__/bot-send-settle-test-support");
  return {
    ...withRecordedSends(
      await importOriginal<typeof import("@/hooks/bots/use-bot-mutations")>(),
    ),
    ...botMutationsMock,
  };
});
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

const NONCE_HOST = BOT_CONVERSATION_NONCE_VERSION;
const POST = "post-direct";
const TEXT_B = "Did the deploy finish?";
const NEW_THREAD_BOX = "Reply in a new thread";

let queryClient: QueryClient;

beforeEach(() => {
  resetRecordedSends();
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

/** A post of the person's that the bot answered in the channel: the host stores it `direct`. */
function directPost(messageId: string, text: string): Message {
  const post = memberPost({
    messageId,
    requestId: "req-stored",
    lines: [text],
    timestamp: 1_000,
    resolvedBy: null,
  });
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

/** A top-level post the host gave a thread at acceptance: its row has no `direct`. */
function plainPost(messageId: string, text: string): Message {
  return memberPost({
    messageId,
    requestId: "req-stored",
    lines: [text],
    timestamp: 1_000,
    resolvedBy: null,
  });
}

/** The channel's rows, as its stream carries them. */
function setChannel(...rows: ReadonlyArray<Message>): void {
  scene.channelHandle?.store.setState({ messages: [EARLIER_POST, ...rows] });
}

/** What the host's thread list says of the thread under `postId`. */
function threadFor(postId: string): BotThreadSummary {
  return {
    threadId: botThreadIdFor(BOT_ID, postId),
    conversationId: "conversation-app",
    sessionChatId: "session-1",
    anchor: {
      messageId: postId,
      requestId: "req-stored",
      senderUserId: null,
      sentAt: 1_000,
      resolvedAt: null,
      excerpt: null,
    },
    replyCount: 1,
    lastReplyAt: 2_000,
    openRequestCount: 0,
    costUsd: null,
  };
}

function listNames(postId: string): void {
  act(() => {
    scene.threads = [threadFor(postId)];
    threadListChanged();
  });
}

function placeOf(anchorMessageId: string): string {
  return `/bot/${BOT_ID}?view=messages&thread=${anchorMessageId}`;
}

async function sendHeld(text: string): Promise<void> {
  pressSend(text);
  await screen.findByTestId("bot-thread-panel");
  await waitFor(() => expect(heldHost().sends).toHaveLength(1));
}

async function stepBack({ history }: PlaceRoute): Promise<void> {
  const before = historyEntryIdentity(history.location);
  act(() => {
    history.back();
  });
  await waitFor(() =>
    expect(historyEntryIdentity(history.location)).not.toBe(before),
  );
}

function panelKind(): string | undefined {
  return scene.panelKinds.at(-1);
}

/** The panel is the stored post over the box that starts its thread: no loading line. */
async function expectUnopened(): Promise<HTMLElement> {
  const panel = await screen.findByTestId("bot-thread-panel");
  const box = await within(panel).findByRole("group", { name: NEW_THREAD_BOX });
  expect(within(panel).queryByTestId("bot-thread-loading")).toBeNull();
  expect(within(panel).getByTestId("bot-thread-composer")).toBeDefined();
  return box;
}

/** The panel waits for the list: the loading line, and no box. */
async function expectPending(): Promise<void> {
  const panel = await screen.findByTestId("bot-thread-panel");
  await within(panel).findByTestId("bot-thread-loading");
  expect(within(panel).queryByTestId("bot-thread-composer")).toBeNull();
  expect(
    within(panel).queryByRole("group", { name: NEW_THREAD_BOX }),
  ).toBeNull();
}

async function typeReply(box: HTMLElement, text: string): Promise<void> {
  typeInto(
    box.querySelector<HTMLElement>("[data-composer-editor]") ?? box,
    `${text}{Enter}`,
  );
  await waitFor(() => expect(heldHost().sends).toHaveLength(1));
}

describe("a restored place naming a post the bot answered in the channel", () => {
  it("opens the box that starts its thread, over the stored post, after a reload", async () => {
    setChannel(directPost(POST, TEXT_A));
    await mountSurfaceOnRouteAtEntry(USER_A, queryClient, placeOf(POST));

    const box = await expectUnopened();

    const panel = screen.getByTestId("bot-thread-panel");
    expect(
      within(panel).getByTestId("bot-thread-anchor").textContent,
    ).toContain(TEXT_A);
    expect(box).toBeDefined();
  });

  it("sends the first reply with the post as its announcement, and moves from posted to listed once the list names the thread", async () => {
    setChannel(directPost(POST, TEXT_A));
    await mountSurfaceOnRouteAtEntry(USER_A, queryClient, placeOf(POST));
    const box = await expectUnopened();

    await typeReply(box, TEXT_B);

    expect(firstSend().request).toMatchObject({
      announcementId: POST,
      threadId: null,
    });
    await settleSceneSend(firstSend(), (held) =>
      held.resolve(botThreadIdFor(BOT_ID, POST)),
    );
    await waitFor(() => expect(scene.panelKinds).toContain("posted"));
    listNames(POST);
    await waitFor(() => expect(panelKind()).toBe("listed"));
  });

  it("stays the box that starts the thread, with the text back in it and the route untouched, when the first reply is refused before it wrote", async () => {
    setChannel(directPost(POST, TEXT_A));
    const route = await mountSurfaceOnRouteAtEntry(
      USER_A,
      queryClient,
      placeOf(POST),
    );
    const box = await expectUnopened();
    const length = route.history.length;
    const search = route.history.location.search;
    await typeReply(box, TEXT_B);

    await settleSceneSend(firstSend(), (held) =>
      held.reject(notWrittenRefusal("refused")),
    );

    const again = await expectUnopened();
    await waitFor(() =>
      expect(
        textOf(
          again.querySelector<HTMLElement>("[data-composer-editor]") ?? again,
        ),
      ).toBe(TEXT_B),
    );
    expect(route.history.length).toBe(length);
    expect(route.history.location.search).toBe(search);
  });

  it("moves to the thread the list names for the post, as if another member replied", async () => {
    setChannel(directPost(POST, TEXT_A));
    await mountSurfaceOnRouteAtEntry(USER_A, queryClient, placeOf(POST));
    await expectUnopened();

    listNames(POST);

    await waitFor(() => expect(panelKind()).toBe("listed"));
  });

  it("opens that box after Back onto the entry of a thread opened at Send, once the bot answered in the channel", async () => {
    const route = await mountSurfaceOnRouteAs(USER_A, queryClient);
    await sendHeld(TEXT_A);
    await routeNames(route, "thread");
    const rail = heldRail();
    const anchor = rail?.kind === "thread" ? rail.anchorMessageId : "";
    expect(rail?.kind, "no thread rail to close").toBe("thread");
    fireEvent.click(screen.getByTestId("bot-thread-close"));
    await waitFor(() => expect(heldRail()).toBeNull());
    setChannel(directPost(anchor, TEXT_A));
    await settleSceneSend(firstSend(), (held) => held.resolve(null));

    await stepBack(route);

    await expectUnopened();
  });
});

describe("a restored place the list has not caught up with", () => {
  it("waits for the list for a post that has its own thread, then lists it", async () => {
    setChannel(plainPost(POST, TEXT_A));
    await mountSurfaceOnRouteAtEntry(USER_A, queryClient, placeOf(POST));
    await expectPending();

    listNames(POST);

    await waitFor(() => expect(panelKind()).toBe("listed"));
  });

  it("waits while the list is still loading, with no box flashed", async () => {
    scene.threadListLoaded = false;
    setChannel(directPost(POST, TEXT_A));
    await mountSurfaceOnRouteAtEntry(USER_A, queryClient, placeOf(POST));

    await expectPending();
  });

  it("opens the box under a bot row that needs no anchor kind, and its first reply lands in the row's own thread", async () => {
    setChannel(
      botQuestion({
        messageId: "question-1",
        timestamp: 700,
        item: {
          text: "Ship it?",
          options: [],
          allowFreeText: true,
          multiSelect: false,
          settlement: null,
        },
      }),
    );
    await mountSurfaceOnRouteAtEntry(
      USER_A,
      queryClient,
      placeOf("question-1"),
    );
    const box = await expectUnopened();

    await typeReply(box, TEXT_B);

    expect(firstSend().request).toMatchObject({
      announcementId: "question-1",
      threadId: null,
    });
    const existing = botThreadIdFor(BOT_ID, "question-1");
    await settleSceneSend(firstSend(), (held) => held.resolve(existing));
    await waitFor(() => {
      const rail = heldRail();
      expect(rail?.kind === "thread" && rail.sent?.threadId).toBe(existing);
    });
  });

  it("keeps waiting under a bot row whose anchor kind the binding does not name, with no box drawn", async () => {
    setChannel({
      ...botReply({ messageId: "answer-1", text: "Yes.", timestamp: 700 }),
      repliesTo: "post-earlier",
    });
    await mountSurfaceOnRouteAtEntry(USER_A, queryClient, placeOf("answer-1"));

    await expectPending();
  });
});

describe("a restored place whose thread list then fails to refresh", () => {
  it.each([
    {
      name: "a server error",
      error: () => hostFailure("RPC_ERROR", "bot.thread.list"),
    },
    {
      name: "a cloud drop",
      error: () => hostFailure("E_CLOUD_UNREACHABLE", "bot.thread.list"),
    },
    {
      name: "a silent host",
      error: () => transportFailure("bot.thread.list"),
    },
  ])(
    "keeps the box that starts the post's thread, over the list's retry line, after $name",
    async ({ error }) => {
      setChannel(directPost(POST, TEXT_A));
      await mountSurfaceOnRouteAtEntry(USER_A, queryClient, placeOf(POST));
      await expectUnopened();
      const answer = await markReadable({
        threads: [] as BotThreadSummary[],
        threadAnchors: null,
      });

      act(() => {
        scene.threadListData = answer;
        scene.threadListError = error();
        threadListChanged();
      });

      const panel = screen.getByTestId("bot-thread-panel");
      await within(panel).findByTestId("bot-thread-stale");
      expect(
        within(panel).queryByTestId("bot-thread-error"),
        "the panel drew the list's failure in place of the post",
      ).toBeNull();
      await expectUnopened();
    },
  );
});

describe("a thread opened at Send whose post the host then stores", () => {
  /** The thread opened at Send, its first attempt uncertain, and the history length at that point. */
  async function uncertainSend(): Promise<{
    readonly route: PlaceRoute;
    readonly anchor: string;
    readonly length: number;
  }> {
    const route = await mountSurfaceOnRouteAs(USER_A, queryClient);
    await sendHeld(TEXT_A);
    await routeNames(route, "thread");
    const rail = heldRail();
    const anchor = rail?.kind === "thread" ? rail.anchorMessageId : "";
    await settleSceneSend(firstSend(), (held) =>
      held.reject(unmarkedRefusal("timed out")),
    );
    await screen.findAllByText(/not confirmed/i);
    return { route, anchor, length: route.history.length };
  }

  it("removes the thread, over the Send's entry, when the stored row is a post the bot answered in the channel", async () => {
    const { route, anchor, length } = await uncertainSend();

    expect(heldRail()?.kind, "no thread rail to remove").toBe("thread");

    act(() => setChannel(directPost(anchor, TEXT_A)));

    await waitFor(() => expect(heldRail()).toBeNull());
    expect(route.history.length).toBe(length);
    expect(screen.queryByTestId("bot-thread-panel")).toBeNull();
    expect(
      within(screen.getByTestId("chat-messages-stub")).queryAllByText(TEXT_A),
    ).not.toHaveLength(0);
  });

  it("GUARD: keeps the thread, still provisional and posted, when the stored row has its own thread", async () => {
    const { anchor } = await uncertainSend();

    act(() => setChannel(plainPost(anchor, TEXT_A)));

    await waitFor(() =>
      expect(
        within(screen.getByTestId("chat-messages-stub")).queryAllByText(TEXT_A),
      ).not.toHaveLength(0),
    );
    const rail = heldRail();
    expect(rail?.kind === "thread" && rail.sent?.provisional).toBe(true);
    expect(panelKind()).toBe("posted");
  });

  it("GUARD: removes nothing from an announcement's thread carrying the first reply's provisional send", async () => {
    const route = await mountSurfaceOnRouteAs(USER_A, queryClient);
    const announcementThread: BotRail = {
      kind: "thread",
      anchorMessageId: "announcement-1",
      announcement: true,
      anchorKind: BOT_THREAD_ANCHOR_MESSAGE,
      sent: {
        threadId: botThreadIdFor(BOT_ID, "announcement-1"),
        requestId: "req-first",
        text: TEXT_B,
        senderUserId: USER_A,
        sentAt: 2_000,
        delivery: "written",
        provisional: true,
      },
    };
    act(() =>
      useBotOpenThreadStore
        .getState()
        .setRail(BOT_ID, announcementThread, currentBotLifetime()),
    );
    await routeNames(route, "thread");

    act(() =>
      setChannel(
        botAnnouncement({
          messageId: "announcement-1",
          text: "The nightly is red.",
          timestamp: 700,
        }),
      ),
    );
    await screen.findAllByText("The nightly is red.");

    expect(heldRail()).toEqual(announcementThread);
  });
});
