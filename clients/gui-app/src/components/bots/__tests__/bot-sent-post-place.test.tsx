/**
 * A thread opened at Send, on the real Tracy place route (Tracy Bots T249): a
 * first attempt refused before anything was written closes it as an automatic
 * move over the entry its Send pushed; a place restored by Back or a reload
 * whose post the host never had closes its rail once the host has said the row
 * is absent, and only then. The real tab surface, channel, box and thread
 * panel over a host that holds each send, on a memory history.
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

import {
  resetRecordedSends,
  settleSceneSend,
} from "@/components/bots/__tests__/bot-send-settle-test-support";
import { QueryClient } from "@tanstack/react-query";
import type { Message } from "@traycer/protocol/persistence/epic/schemas";
import type { ComponentProps } from "react";
import {
  act,
  cleanup,
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
import { notWrittenRefusal } from "@/components/bots/__tests__/bot-send-identity-test-support";
import { BOT_CONVERSATION_NONCE_VERSION } from "@/hooks/bots/use-bot-send-version";
import {
  EARLIER_POST,
  TEXT_A,
  USER_A,
  endCase,
  heldRail,
  watchThreadRail,
  mountSurfaceOnRouteAs,
  mountSurfaceOnRouteAtEntry,
  type PlaceRoute,
  pressSend,
  routeNames,
  startCase,
} from "@/components/bots/__tests__/bot-sent-post-test-support";
import { memberPost } from "@/components/bots/__tests__/bot-turn-test-support";
import { historyEntryIdentity } from "@/lib/bots/tracy-place-traversal";

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

/** The host line that takes a send's nonce. */
const NONCE_HOST = BOT_CONVERSATION_NONCE_VERSION;

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

/** The stored row of the post sent at Send, under the id the thread was opened on. */
function storedPost(messageId: string): Message {
  return memberPost({
    messageId,
    requestId: "req-stored",
    lines: [TEXT_A],
    timestamp: 1_000,
    resolvedBy: null,
  });
}

/** The host's answer to a cold row of the channel: it has none. */
const ABSENT: LocateAnswer = { status: "missing", cause: "absent" };

/** Send from the mounted surface: the host holds it and the post's thread is open at Send. */
async function sendHeld(): Promise<void> {
  pressSend(TEXT_A);
  await screen.findByTestId("bot-thread-panel");
  await waitFor(() => expect(heldHost().sends).toHaveLength(1));
}

/** The host refused the first attempt before writing anything. */
async function refuseFirstAttempt(): Promise<void> {
  await settleSceneSend(firstSend(), (held) =>
    held.reject(notWrittenRefusal("refused")),
  );
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

async function stepForward({ history }: PlaceRoute): Promise<void> {
  const before = historyEntryIdentity(history.location);
  act(() => {
    history.forward();
  });
  await waitFor(() =>
    expect(historyEntryIdentity(history.location)).not.toBe(before),
  );
}

/** The route's place names no thread. */
function routeNamesNoThread({ history }: PlaceRoute): void {
  expect(history.location.search).not.toContain("thread");
}

/**
 * The route's entry that names the thread opened at Send, behind the person's
 * move on: Send pushed it, the person closed the thread before the answer
 * (a pushed entry), the refusal found the rail no longer showing that send's
 * thread and changed nothing, and Back lands on the Send's entry with the rail
 * restored, `sent` null.
 */
async function backOntoRefusedThread(
  route: PlaceRoute,
): Promise<() => boolean> {
  await sendHeld();
  await routeNames(route, "thread");
  expect(heldRail()?.kind, "no thread rail to close").toBe("thread");
  fireEvent.click(screen.getByTestId("bot-thread-close"));
  await waitFor(() => expect(heldRail()).toBeNull());
  await waitFor(() => routeNamesNoThread(route));
  await refuseFirstAttempt();
  const sawThread = watchThreadRail();
  await stepBack(route);
  return sawThread;
}

function loading(): HTMLElement | null {
  return screen.queryByTestId("bot-thread-loading");
}

describe("a refusal of the first attempt closes the thread opened at Send", () => {
  it("over the entry the Send pushed, so history holds one entry for both", async () => {
    const route = await mountSurfaceOnRouteAs(USER_A, queryClient);
    const before = route.history.length;

    await sendHeld();
    await routeNames(route, "thread");
    expect(route.history.length).toBe(before + 1);
    expect(heldRail()?.kind, "no thread rail to close").toBe("thread");

    await refuseFirstAttempt();
    await waitFor(() => expect(heldRail()).toBeNull());
    await waitFor(() => routeNamesNoThread(route));

    expect(
      route.history.length,
      "the refusal's close was pushed as a step of its own",
    ).toBe(before + 1);
  });
});

describe("a restored place whose post the host never had", () => {
  it("closes its rail over the entry once the locate says the row is absent, and Back does not bring it back (Back)", async () => {
    const route = await mountSurfaceOnRouteAs(USER_A, queryClient);
    scene.locate = ABSENT;
    const sawThread = await backOntoRefusedThread(route);
    const length = route.history.length;

    await waitFor(() => expect(heldRail()).toBeNull());
    expect(sawThread(), "Back restored no thread rail to close").toBe(true);
    expect(loading(), "the thread kept loading forever").toBeNull();
    expect(
      route.history.length,
      "the close was pushed as a step of its own",
    ).toBe(length);
    routeNamesNoThread(route);
  });

  it("closes its rail over the entry the reload starts on", async () => {
    const first = await mountSurfaceOnRouteAs(USER_A, queryClient);
    await sendHeld();
    await routeNames(first, "thread");
    const entry = `/bot/${BOT_ID}${first.history.location.search}`;
    cleanup();
    endBotTabSurfaceCase(queryClient);
    endCase();
    resetBotTabSurfaceMocks();
    startCase(NONCE_HOST, [EARLIER_POST], "thread");
    scene.locate = ABSENT;
    const sawThread = watchThreadRail();

    const route = await mountSurfaceOnRouteAtEntry(USER_A, queryClient, entry);
    const length = route.history.length;

    await waitFor(() => expect(heldRail()).toBeNull());
    expect(sawThread(), "the reload opened no thread rail to close").toBe(true);
    expect(loading(), "the thread kept loading forever").toBeNull();
    expect(
      route.history.length,
      "the close was pushed as a step of its own",
    ).toBe(length);
    routeNamesNoThread(route);
  });

  it.each([
    {
      name: "the locate failed",
      arrange: () => {
        scene.locate = { status: "missing", cause: "failed" };
      },
    },
    {
      name: "the host does not locate rows",
      arrange: () => {
        scene.locate = { status: "missing", cause: "unsupported" };
      },
    },
    {
      name: "the channel's stream is closed",
      arrange: () => {
        scene.locate = ABSENT;
        scene.channelHandle?.store.setState({ connectionStatus: "closed" });
      },
    },
    {
      name: "the locate found the post outside the loaded window",
      arrange: () => {
        scene.locate = { status: "found", ordinal: 7 };
      },
    },
  ])("keeps the rail and its loading when $name", async ({ arrange }) => {
    const route = await mountSurfaceOnRouteAs(USER_A, queryClient);
    arrange();

    await backOntoRefusedThread(route);

    await screen.findByTestId("bot-thread-panel");
    expect(heldRail(), "the rail was closed").not.toBeNull();
  });

  it("keeps the rail while a held send carries the post's id, across a step back and forward", async () => {
    const route = await mountSurfaceOnRouteAs(USER_A, queryClient);
    scene.locate = ABSENT;
    await sendHeld();
    await routeNames(route, "thread");

    await stepBack(route);
    await stepForward(route);

    await screen.findByTestId("bot-thread-panel");
    expect(heldRail(), "the held send's thread was closed").not.toBeNull();
    expect(heldHost().sends).toHaveLength(1);
  });

  it("stays closed, with the post in the channel, when the row arrives after the rail closed", async () => {
    const first = await mountSurfaceOnRouteAs(USER_A, queryClient);
    await sendHeld();
    await routeNames(first, "thread");
    const rail = heldRail();
    const anchorMessageId = rail?.kind === "thread" ? rail.anchorMessageId : "";
    const entry = `/bot/${BOT_ID}${first.history.location.search}`;
    cleanup();
    endBotTabSurfaceCase(queryClient);
    endCase();
    resetBotTabSurfaceMocks();
    startCase(NONCE_HOST, [EARLIER_POST], "thread");
    scene.locate = ABSENT;
    const sawThread = watchThreadRail();
    const route = await mountSurfaceOnRouteAtEntry(USER_A, queryClient, entry);
    await waitFor(() => expect(heldRail()).toBeNull());
    expect(sawThread(), "the reload opened no thread rail to close").toBe(true);

    // The send that was in flight at the reload succeeded: its row arrives.
    act(() => {
      scene.locate = { status: "found", ordinal: 1 };
      scene.channelHandle?.store.setState({
        messages: [EARLIER_POST, storedPost(anchorMessageId)],
      });
    });

    await waitFor(() =>
      expect(
        within(screen.getByTestId("chat-messages-stub")).queryAllByText(TEXT_A),
      ).not.toHaveLength(0),
    );
    expect(heldRail(), "the thread was reopened").toBeNull();
    routeNamesNoThread(route);
  });
});
