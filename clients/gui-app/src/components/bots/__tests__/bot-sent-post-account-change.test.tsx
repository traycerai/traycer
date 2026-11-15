/**
 * A member's post at Send, across an account change (Tracy Bots T249): the
 * thread a thread-mode post opens at Send holds the unsent text, document and
 * sender in the window's rail store, and the send itself lives in the pending
 * store and in callbacks. None of it belongs to the next account. The real
 * tab surface, channel, box and thread panel over a host that holds each
 * send; the account moves as `AuthService` moves it (`switchAccount`).
 *
 * What a commit or a render drew is asserted from records, not from the DOM
 * at the end: a `Profiler` reads the page at every commit, before passive
 * effects; the real thread panel and `threadOriginRow` are wrapped by
 * passthroughs that record what they were given on each render.
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
  tabHostRequester,
} from "@/components/bots/__tests__/bot-sent-post-scene";

import { QueryClient } from "@tanstack/react-query";
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
  IMAGE_A,
  TEXT_A,
  USER_A,
  USER_B,
  changeAccount,
  commitsDrawingA,
  endCase,
  heldRail,
  markProbes,
  mountSurfaceAs,
  mountSurfaceOnRouteAs,
  type PlaceRoute,
  originsDrawingSent,
  pageDescription,
  panelsDrawingPosted,
  pasteImage,
  pressSend,
  routeNames,
  setSendLine,
  sendStoresSnapshot,
  startCase,
  switchAccount,
  type ProbeMark,
} from "@/components/bots/__tests__/bot-sent-post-test-support";
import {
  exchangeRailOver,
  memoryRailOver,
  searchRailOver,
  useBotOpenThreadStore,
  type BotRail,
} from "@/stores/bots/bot-open-thread-store";
import { useBotPendingSendsStore } from "@/stores/bots/bot-pending-sends-store";
import { historyEntryIdentity } from "@/lib/bots/tracy-place-traversal";
import { currentBotLifetime } from "@/lib/bots/bot-lifetime";

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

/** The host line that takes a send's nonce, and the one a minor below it. */
const NONCE_HOST = BOT_CONVERSATION_NONCE_VERSION;
const OLD_HOST = { major: NONCE_HOST.major, minor: NONCE_HOST.minor - 1 };

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

/** A, signed in, presses Send on a post to a bot that answers in threads; the host holds it and its thread is open. */
async function aSendsHeldPost(withImage: boolean): Promise<void> {
  await mountSurfaceAs(USER_A, queryClient);
  await sendFromBox(withImage);
}

/** A's Send from the mounted surface: the host holds it, and its thread is open. */
async function sendFromBox(withImage: boolean): Promise<void> {
  if (withImage) {
    pasteImage(IMAGE_A);
    await screen.findByTestId("bot-channel-composer-images");
  }
  pressSend(TEXT_A);
  const panel = await screen.findByTestId("bot-thread-panel");
  expect(within(panel).getAllByText(TEXT_A).length).toBeGreaterThan(0);
  await waitFor(() => expect(heldHost().sends).toHaveLength(1));
}

/** The host answered A's first attempt with an error that does not say it wrote nothing. */
async function aSendTurnsUncertain(): Promise<void> {
  await act(async () => {
    firstSend().reject(unmarkedRefusal("timed out"));
    await Promise.resolve();
  });
  expect(
    screen.queryAllByText(/not confirmed/i),
    `A's post was not drawn as unconfirmed: ${pageDescription()}`,
  ).not.toHaveLength(0);
}

/** A Send of B's to the same bot, which the host holds. */
const TEXT_B = "Did the deploy finish?";

/** What the screen and the records say of A after `mark`: nothing, for each of the four ways A's post could be drawn. */
function expectNoneOfA(mark: ProbeMark): void {
  expect(
    scene.commits.length,
    `the surface committed nothing after the account change: ${pageDescription()}`,
  ).toBeGreaterThan(mark.commits);
  expect(
    commitsDrawingA(mark),
    `a commit drew account A's post (${commitsDrawingA(mark).join("; ")}): ${pageDescription()}`,
  ).toEqual([]);
  expect(
    panelsDrawingPosted(mark),
    `the thread panel was rendered with a held post: ${pageDescription()}`,
  ).toBe(0);
  expect(
    originsDrawingSent(mark),
    `a thread origin was drawn from a post the person sent: ${pageDescription()}`,
  ).toBe(0);
  expect(
    JSON.stringify(useBotOpenThreadStore.getState().byBotId),
    `A's text is still in the rail store: ${pageDescription()}`,
  ).not.toContain(TEXT_A);
}

describe("the rail and the pending sends at the account change", () => {
  it("are empty when the auth write returns, before anything renders", async () => {
    await aSendsHeldPost(false);
    expect(Object.keys(useBotOpenThreadStore.getState().byBotId)).toHaveLength(
      1,
    );
    expect(
      Object.keys(useBotPendingSendsStore.getState().entries),
    ).toHaveLength(1);
    const seen: Array<{ rails: unknown; pending: unknown }> = [];

    act(() => {
      switchAccount(USER_B);
      seen.push({
        rails: useBotOpenThreadStore.getState().byBotId,
        pending: useBotPendingSendsStore.getState().entries,
      });
    });

    expect(seen).toHaveLength(1);
    expect(
      seen[0].rails,
      "A's thread was still in the rail when the account change returned",
    ).toEqual({});
    expect(
      seen[0].pending,
      "A's send was still held when the account change returned",
    ).toEqual({});
  });
});

describe("a thread-mode post held at Send, as the account changes", () => {
  it("draws nothing of A for B: not its text, not its image, no held thread", async () => {
    await aSendsHeldPost(true);
    const mark = markProbes();

    await changeAccount(USER_B);

    expectNoneOfA(mark);
    expect(screen.queryByText(TEXT_A)).toBeNull();
  });

  it("draws nothing of A for B when A's send had ended unconfirmed", async () => {
    await aSendsHeldPost(false);
    await aSendTurnsUncertain();
    const mark = markProbes();

    await changeAccount(USER_B);

    expectNoneOfA(mark);
  });

  it("draws nothing of A when A returns after B: the first lifetime's post does not come back", async () => {
    await aSendsHeldPost(false);
    const mark = markProbes();

    await changeAccount(USER_B);
    await changeAccount(USER_A);

    expectNoneOfA(mark);
  });

  it("draws nothing of A when nobody is signed in", async () => {
    await aSendsHeldPost(false);
    const mark = markProbes();

    await changeAccount(null);

    expectNoneOfA(mark);
  });

  it("draws nothing of A for B in the same team's channel, and the team's own rows stay", async () => {
    await aSendsHeldPost(false);
    const mark = markProbes();

    await changeAccount(USER_B);

    expectNoneOfA(mark);
    expect(screen.getAllByText("Morning.").length).toBeGreaterThan(0);
  });
});

describe("a rail nested over A's thread, once B pops back", () => {
  async function switchThenPop(
    over: (thread: BotRail | null) => BotRail,
    pop: (rail: BotRail | null) => BotRail | null,
  ): Promise<ProbeMark> {
    await aSendsHeldPost(false);
    act(() =>
      useBotOpenThreadStore
        .getState()
        .setRail(BOT_ID, over(heldRail()), currentBotLifetime()),
    );
    const mark = markProbes();
    await changeAccount(USER_B);
    act(() =>
      useBotOpenThreadStore
        .getState()
        .setRail(BOT_ID, pop(heldRail()), currentBotLifetime()),
    );
    return mark;
  }

  /**
   * What closing a memory, a pair's log or the results of a search puts back,
   * as the tab's closers do: a memory gives back the thread it displaced.
   */
  function previousOf(rail: BotRail | null): BotRail | null {
    if (rail === null) return null;
    if (rail.kind === "thread") return rail;
    if (rail.kind === "memory") {
      return rail.back === null ? null : { kind: "thread", ...rail.back };
    }
    return rail.back;
  }

  it("draws none of A's text for a memory opened over the thread", async () => {
    const mark = await switchThenPop(memoryRailOver, previousOf);

    expectNoneOfA(mark);
  });

  it("draws none of A's text for a pair's log opened over that memory, closed twice", async () => {
    const mark = await switchThenPop(
      (thread) => exchangeRailOver(memoryRailOver(thread), "bot_peer"),
      (rail) => previousOf(previousOf(rail)),
    );

    expectNoneOfA(mark);
  });

  it("draws none of A's text for search results opened over the thread", async () => {
    const mark = await switchThenPop(searchRailOver, previousOf);

    expectNoneOfA(mark);
  });

  it("draws none of A's text for a search showing a thread one of its results opened", async () => {
    await aSendsHeldPost(false);
    const thread = heldRail();
    if (thread === null || thread.kind !== "thread") {
      throw new Error("A's thread is not open");
    }
    const { kind: _kind, ...open } = thread;
    act(() =>
      useBotOpenThreadStore.getState().setRail(
        BOT_ID,
        {
          kind: "search",
          back: null,
          showing: { kind: "thread", thread: open },
        },
        currentBotLifetime(),
      ),
    );
    const mark = markProbes();

    await changeAccount(USER_B);

    expectNoneOfA(mark);
  });
});

describe("a route entry naming A's thread anchor, stepped onto", () => {
  /**
   * A sends, so the thread opens, then opens the memory over it: the route
   * (the real place route, over a memory history) holds an entry for each.
   */
  async function aHasThreadThenMemoryOnRoute(): Promise<PlaceRoute> {
    const route = await mountSurfaceOnRouteAs(USER_A, queryClient);
    await sendFromBox(false);
    await routeNames(route, "thread");
    act(() =>
      useBotOpenThreadStore
        .getState()
        .setRail(BOT_ID, memoryRailOver(heldRail()), currentBotLifetime()),
    );
    await routeNames(route, "memory");
    return route;
  }

  /** A step back, as the person's back button makes it, onto an entry that names A's thread. */
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

  it("restores the place for B with none of A's post", async () => {
    const route = await aHasThreadThenMemoryOnRoute();
    await changeAccount(USER_B);
    const mark = markProbes();

    await stepBack(route);

    expectNoneOfA(mark);
    expect(
      heldRail(),
      "B's arrival on the anchor did not open its thread",
    ).not.toBeNull();
  });

  it("CONTROL: keeps the post it was sent with when the same account steps back onto its thread", async () => {
    const route = await aHasThreadThenMemoryOnRoute();

    await stepBack(route);

    const rail = heldRail();
    expect(rail?.kind === "thread" && rail.sent?.text).toBe(TEXT_A);
  });
});

describe("A's late callbacks, once B is signed in", () => {
  it("leave B's rail without A's post when the host accepted A's send after the change", async () => {
    await aSendsHeldPost(false);
    await changeAccount(USER_B);
    const mark = markProbes();
    const before = sendStoresSnapshot();

    await act(async () => {
      firstSend().resolve("thread-from-late-receipt");
      await Promise.resolve();
    });

    expect(
      sendStoresSnapshot(),
      "A's accepted answer changed the rail or the pending sends of B's window",
    ).toBe(before);
    expect(commitsDrawingA(mark)).toEqual([]);
    expect(
      JSON.stringify(useBotOpenThreadStore.getState().byBotId),
    ).not.toContain(TEXT_A);
  });

  // A control: a host that takes no nonce draws nothing at Send, and A's box is
  // gone when the answer comes, so there is no rail entry for it to fill.
  it("CONTROL: leave B's rail without A's post when a host that takes no nonce answered A's send after the change", async () => {
    setSendLine(OLD_HOST);
    await mountSurfaceAs(USER_A, queryClient);
    pressSend(TEXT_A);
    await waitFor(() => expect(heldHost().sends).toHaveLength(1));
    await changeAccount(USER_B);
    const mark = markProbes();

    await act(async () => {
      firstSend().resolve("thread-from-old-host");
      await Promise.resolve();
    });

    expect(
      JSON.stringify(useBotOpenThreadStore.getState().byBotId),
      "A's accepted answer opened a thread with A's text in B's rail",
    ).not.toContain(TEXT_A);
    expect(commitsDrawingA(mark)).toEqual([]);
    expect(panelsDrawingPosted(mark)).toBe(0);
  });

  // A control: after the change the late refusal finds its pending entry gone,
  // so the channel's `onRefused` never runs; nothing here can close B's thread.
  it("CONTROL: leave the rail B opened as it is when the host refused A's send after the change", async () => {
    await aSendsHeldPost(false);
    await changeAccount(USER_B);
    // What a click on a thread line does for B, on a post of its own.
    act(() =>
      useBotOpenThreadStore.getState().setRail(
        BOT_ID,
        {
          kind: "thread",
          anchorMessageId: EARLIER_POST.messageId,
          announcement: false,
          anchorKind: null,
          sent: null,
        },
        currentBotLifetime(),
      ),
    );
    expect(heldRail()?.kind, "B's thread did not open").toBe("thread");

    await act(async () => {
      firstSend().reject(notWrittenRefusal("refused"));
      await Promise.resolve();
    });

    expect(
      heldRail()?.kind,
      "A's late refusal closed the thread B opened",
    ).toBe("thread");
  });

  // Red today only through the leak (A's text is still in B's rail): the late
  // settle itself changes nothing, as the stores' snapshot shows.
  it("change nothing of B's when A's Retry settles after the change", async () => {
    const user = userEvent.setup();
    await aSendsHeldPost(false);
    await aSendTurnsUncertain();
    await user.click(screen.getAllByRole("button", { name: "Retry" })[0]);
    await waitFor(() => expect(heldHost().sends).toHaveLength(2));
    await changeAccount(USER_B);
    const before = sendStoresSnapshot();

    await act(async () => {
      heldHost().sends[1].resolve("thread-from-retry");
      await Promise.resolve();
    });

    expect(
      sendStoresSnapshot(),
      "A's retry changed the rail or the pending sends of B's window",
    ).toBe(before);
    expect(
      JSON.stringify(useBotOpenThreadStore.getState().byBotId),
    ).not.toContain(TEXT_A);
  });
});

describe("what the account change must leave alone", () => {
  it("CONTROL: keeps B's own send, made after the change, through the bridge's transition", async () => {
    await mountSurfaceAs(USER_A, queryClient);
    await changeAccount(USER_B);
    await screen.findByRole("group", { name: "Message Release Bot" });

    pressSend(TEXT_B);
    await waitFor(() => expect(heldHost().sends).toHaveLength(1));
    await act(async () => {
      await Promise.resolve();
    });

    expect(heldHost().sends[0].sentBy).toBe(USER_B);
    expect(
      Object.keys(useBotPendingSendsStore.getState().entries),
    ).toHaveLength(1);
    expect(screen.queryAllByText(TEXT_B)).not.toHaveLength(0);
  });

  it("CONTROL: closing a thread opened at Send, under the account that sent it, clears it", async () => {
    const user = userEvent.setup();
    await aSendsHeldPost(false);

    await user.click(await screen.findByTestId("bot-thread-close"));

    expect(heldRail()).toBeNull();
  });

  it("CONTROL: settles the thread opened at Send with the thread the host names, under the account that sent it", async () => {
    await aSendsHeldPost(false);

    await act(async () => {
      firstSend().resolve("thread-from-receipt");
      await Promise.resolve();
    });

    const rail = heldRail();
    expect(rail?.kind === "thread" && rail.sent?.threadId).toBe(
      "thread-from-receipt",
    );
    expect(rail?.kind === "thread" && rail.sent?.provisional).toBe(false);
  });
});
