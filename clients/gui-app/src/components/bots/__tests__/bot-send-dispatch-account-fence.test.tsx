/**
 * A member's send at the edge of the wire, across an account change (Tracy
 * Bots T249): the real tab surface, channel, box and `bot.conversation.send`
 * mutation over a host that holds each send and logs every request it is
 * asked. A send leaves only under the account that pressed Send, in the
 * lifetime it was pressed in: the case switches account inside the same act
 * as the press, before the mutation's function has run, and what is asserted
 * is the host's request log alone.
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
  sendLineScripted,
  sendRequestsLogged,
  tabHostRequester,
} from "@/components/bots/__tests__/bot-sent-post-scene";

import { QueryClient } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  endBotTabSurfaceCase,
  resetBotTabSurfaceMocks,
  BOT_ID,
} from "@/components/bots/__tests__/bot-tab-surface-harness";
import { unmarkedRefusal } from "@/components/bots/__tests__/bot-send-identity-test-support";
import { useBotPendingSendsStore } from "@/stores/bots/bot-pending-sends-store";
import { BOT_CONVERSATION_NONCE_VERSION } from "@/hooks/bots/use-bot-send-version";
import {
  EARLIER_POST,
  TEXT_A,
  USER_A,
  USER_B,
  endCase,
  mountSurfaceAs,
  pressEnter,
  pressSend,
  typeText,
  setSendLine,
  startCase,
  switchAccount,
} from "@/components/bots/__tests__/bot-sent-post-test-support";

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

/** The host line that takes a send's nonce, and the one a minor below it. */
const NONCE_HOST = BOT_CONVERSATION_NONCE_VERSION;
const OLD_HOST = { major: NONCE_HOST.major, minor: NONCE_HOST.minor - 1 };

let queryClient: QueryClient;

beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  resetBotTabSurfaceMocks();
  startCase(NONCE_HOST, [EARLIER_POST], "direct");
});

afterEach(() => {
  endBotTabSurfaceCase(queryClient);
  endCase();
});

/** What a send had started when the account changed under it. */
interface Started {
  readonly pending: number;
  /** The held sends with an attempt out. */
  readonly attemptsOut: number;
  readonly mutating: number;
}

/**
 * Presses, then changes account in the same act: the press has run, its
 * mutation has started and its pending row (where the host takes a nonce) is
 * held when the account changes, and nothing has rendered or flushed yet.
 */
function pressThenSwitch(press: () => void, change: () => void): Started {
  const seen: Started[] = [];
  act(() => {
    press();
    seen.push({
      pending: Object.keys(useBotPendingSendsStore.getState().entries).length,
      attemptsOut: Object.values(
        useBotPendingSendsStore.getState().entries,
      ).filter((entry) => entry?.inFlight === true).length,
      mutating: queryClient.isMutating(),
    });
    change();
  });
  const started = seen.at(0);
  if (started === undefined) throw new Error("the press did not run");
  return started;
}

/**
 * The send has either left (the host holds it) or has settled without
 * leaving (its mutation is no longer pending): both ends of the same wait,
 * so a send that is refused and one that is dispatched are both seen.
 */
async function sendLeftOrSettled(): Promise<void> {
  await waitFor(() =>
    expect(heldHost().sends.length > 0 || queryClient.isMutating() === 0).toBe(
      true,
    ),
  );
}

describe("a send pressed under one account while another signs in", () => {
  it("sends nothing carrying A's text or nonce when the account changed before the first send left", async () => {
    await mountSurfaceAs(USER_A, queryClient);

    typeText(TEXT_A);
    const started = pressThenSwitch(pressEnter, () => switchAccount(USER_B));
    await sendLeftOrSettled();

    expect(started.mutating, "Send started no mutation before the change").toBe(
      1,
    );
    expect(started.pending, "Send drew no pending row before the change").toBe(
      1,
    );
    expect(
      sendRequestsLogged(),
      "a send carrying A's text left the client after the account changed",
    ).toEqual([]);
  });

  it("sends nothing when the account came back before the send left: the lifetime moved though the account matches again", async () => {
    await mountSurfaceAs(USER_A, queryClient);

    typeText(TEXT_A);
    const started = pressThenSwitch(pressEnter, () => {
      switchAccount(USER_B);
      switchAccount(USER_A);
    });
    await sendLeftOrSettled();

    expect(started.mutating, "Send started no mutation before the change").toBe(
      1,
    );
    expect(started.pending, "Send drew no pending row before the change").toBe(
      1,
    );
    expect(
      sendRequestsLogged(),
      "a send of A's first lifetime left under A's second",
    ).toEqual([]);
  });

  it("sends nothing from a host that takes no nonce when the account changed before the send left", async () => {
    setSendLine(OLD_HOST);
    await mountSurfaceAs(USER_A, queryClient);

    typeText(TEXT_A);
    const started = pressThenSwitch(pressEnter, () => switchAccount(USER_B));
    await sendLeftOrSettled();

    expect(started.mutating, "Send started no mutation before the change").toBe(
      1,
    );
    expect(
      sendRequestsLogged(),
      "a nonce-less send carrying A's text left the client after the account changed",
    ).toEqual([]);
  });

  it("sends nothing when Retry of an unconfirmed send is pressed and the account changes before it leaves", async () => {
    await mountSurfaceAs(USER_A, queryClient);
    pressSend(TEXT_A);
    await waitFor(() => expect(heldHost().sends).toHaveLength(1));
    await act(async () => {
      firstSend().reject(unmarkedRefusal("timed out"));
      await Promise.resolve();
    });
    expect(
      screen.getByText(/not confirmed/i),
      "A's post was not drawn as unconfirmed",
    ).toBeTruthy();
    const rowsOfPost = screen
      .queryAllByTestId("bot-member-row")
      .filter((row) => row.textContent.includes(TEXT_A));
    expect(
      rowsOfPost,
      `A's one send was drawn as ${String(rowsOfPost.length)} rows; the text appears ${rowsOfPost.map((row) => String(row.textContent.split(TEXT_A).length - 1)).join(", ")} time(s) in them`,
    ).toHaveLength(1);
    const retry = screen.getByRole("button", { name: "Retry" });

    const started = pressThenSwitch(
      () => fireEvent.click(retry),
      () => switchAccount(USER_B),
    );
    await sendLeftOrSettled();

    expect(
      started.attemptsOut,
      "pressing Retry put no second attempt out before the change",
    ).toBe(1);
    expect(
      started.mutating,
      "Retry started no mutation before the change",
    ).toBe(1);
    expect(
      sendRequestsLogged(),
      "the retry of A's send left the client after the account changed",
    ).toHaveLength(1);
  });

  it("CONTROL: sends exactly one request carrying the exact request when the account does not change", async () => {
    await mountSurfaceAs(USER_A, queryClient);

    pressSend(TEXT_A);
    expect(
      Object.keys(useBotPendingSendsStore.getState().entries),
      "Send drew no pending row: the box did not take the send",
    ).toHaveLength(1);
    await waitFor(() => expect(heldHost().sends).toHaveLength(1));

    expect(sendRequestsLogged()).toEqual([firstSend().request]);
    expect(firstSend().request).toMatchObject({
      botId: BOT_ID,
      text: TEXT_A,
    });
  });
});
