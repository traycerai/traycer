/**
 * What a member's send is, by where its bot runs (Tracy Bots T249, scope S): a
 * pending row is drawn and a nonce is sent ONLY when the tab's host is the
 * bot's bound host and takes the nonce; a nonce request names the authority
 * it was made under (the bound host and its epoch), which the pending row's id
 * derives with; a refusal that the binding moved sends the app to read the
 * bot again; Retry is offered only under the authority the send was made
 * under; and a held send is drawn by its bot and chat, whichever host the tab
 * is on. The real tab surface, channel and box over a host that holds each
 * send; what is asserted is the host's request log and the page.
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
  tabHostRequester,
} from "@/components/bots/__tests__/bot-sent-post-scene";
import { QueryClient } from "@tanstack/react-query";
import type { RenderResult } from "@testing-library/react";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  endBotTabSurfaceCase,
  resetBotTabSurfaceMocks,
  TAB_HOST,
} from "@/components/bots/__tests__/bot-tab-surface-harness";
import {
  authorityMovedRefusal,
  sendNonceOf,
  unmarkedRefusal,
} from "@/components/bots/__tests__/bot-send-identity-test-support";
import { textOf } from "@/components/bots/__tests__/bot-box-test-support";
import { BOT_CONVERSATION_NONCE_VERSION } from "@/hooks/bots/use-bot-send-version";
import {
  botSendRequestId,
  conversationRequestMessageId,
} from "@traycer/protocol/persistence/epic/messages";
import type {
  BotConversationSendRequest,
  BotSendAuthority,
} from "@traycer/protocol/host/bot/conversation-schemas";
import { rebindUnreachableTracySurface } from "@/stores/bots/tracy-surface-store";
import { useBotPendingSendsStore } from "@/stores/bots/bot-pending-sends-store";
import {
  EARLIER_POST,
  TEXT_A,
  USER_A,
  bindBot,
  channelBox,
  endCase,
  mountSurfaceAs,
  pageDescription,
  pressEnter,
  pressSend,
  redrawSurface,
  setSendLine,
  startCase,
  type BotBinding,
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

/** Other hosts a bot can be bound to, and a tab can be rebound to. */
const ELSEWHERE = "host-elsewhere";
const TEAM_HOST = "host-team";
const OTHER_TAB_HOST = "host-other-tab";

const HERE: BotBinding = { kind: "team", hostId: TAB_HOST, epoch: 1 };

let queryClient: QueryClient;
let view: RenderResult;

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

/** The surface mounted for A, over a bot bound as `binding`. */
async function mountBoundAs(binding: BotBinding): Promise<void> {
  bindBot(binding, "direct");
  view = await mountSurfaceAs(USER_A, queryClient);
}

/** What the surface was told of the bot now, drawn again. */
function bindNow(binding: BotBinding): void {
  bindBot(binding, "direct");
  act(() => redrawSurface(view, queryClient));
}

function loggedSends(): ReadonlyArray<BotConversationSendRequest> {
  return heldHost().sends.map((held) => held.request);
}

/** The request of the send the host holds at `index`. */
function sendAt(index: number): BotConversationSendRequest {
  const send = loggedSends().at(index);
  if (send === undefined) {
    throw new Error(
      `the host was asked for ${String(loggedSends().length)} send(s)`,
    );
  }
  return send;
}

/** The authority a nonce request names, whatever its type says. */
function authorityOf(request: BotConversationSendRequest): unknown {
  return "authority" in request ? request.authority : undefined;
}

/** The pending rows' ids. */
function heldIds(): string[] {
  return Object.keys(useBotPendingSendsStore.getState().entries);
}

/** The channel's rows carrying `text`. */
function rowsOf(text: string): HTMLElement[] {
  return screen
    .queryAllByTestId("bot-member-row")
    .filter((row) => row.textContent.includes(text));
}

/** The id of the row the host will store for `request`, derived under `authority`. */
function rowIdUnder(
  request: BotConversationSendRequest,
  authority: BotSendAuthority,
): string {
  const identity = {
    botId: request.botId,
    conversationId: request.conversationId,
    threadId: request.threadId ?? null,
    announcementId: request.announcementId ?? null,
    senderUserId: USER_A,
    authority,
    nonce: sendNonceOf(request),
  };
  return conversationRequestMessageId(botSendRequestId(identity));
}

/** A presses Send on `text`, and the host holds the request. */
async function aSends(text: string): Promise<void> {
  const before = loggedSends().length;
  pressSend(text);
  await waitFor(() => expect(loggedSends()).toHaveLength(before + 1));
}

/** How many times the surface read the bot again, through its subscription's `resubscribe`. */
function botReadsSoFar(): number {
  return mocks.resubscribe.mock.calls.length;
}

/**
 * The row's Retry, as the row draws it once its send may no longer be sent
 * again: present and disabled, as it is for a row with no retry action.
 * Pressing it sends nothing.
 */
async function expectRetryWithheldAndInert(): Promise<void> {
  const retry = screen.getByRole("button", { name: "Retry" });
  if (!(retry instanceof HTMLButtonElement)) throw new Error("no Retry button");
  // The native property, as the repo's other suites read it: the jest-dom matchers are not loaded.
  expect(
    retry.disabled,
    `Retry is enabled under a binding that moved: ${pageDescription()}`,
  ).toBe(true);
  const sendsBefore = loggedSends().length;
  fireEvent.click(retry);
  await act(async () => {
    await Promise.resolve();
  });
  expect(
    loggedSends(),
    "pressing the withheld Retry sent a request",
  ).toHaveLength(sendsBefore);
}

/** The held send answered with an error that does not say it wrote nothing. */
async function theSendTurnsUncertain(): Promise<void> {
  await act(async () => {
    firstSend().reject(unmarkedRefusal("timed out"));
    await Promise.resolve();
  });
  expect(
    screen.queryAllByText(/not confirmed/i),
    `the send was not drawn unconfirmed: ${pageDescription()}`,
  ).not.toHaveLength(0);
}

describe("a send by where its bot runs", () => {
  it("sends a relayed personal bot's post with no nonce and draws no pending row", async () => {
    await mountBoundAs({ kind: "personal", hostId: ELSEWHERE, epoch: 2 });

    await aSends(TEXT_A);

    expect(
      sendAt(0).sendNonce,
      `a send relayed to the bound host carried a nonce: ${pageDescription()}`,
    ).toBeUndefined();
    expect(heldIds(), "a pending row was held for a relayed send").toEqual([]);
    expect(
      rowsOf(TEXT_A),
      `a relayed send drew a row: ${pageDescription()}`,
    ).toHaveLength(0);
  });

  it("sends a relayed team bot's post, from a member's own host, with no nonce and draws no pending row", async () => {
    await mountBoundAs({ kind: "team", hostId: TEAM_HOST, epoch: 3 });

    await aSends(TEXT_A);

    expect(
      sendAt(0).sendNonce,
      `a send relayed to the team host carried a nonce: ${pageDescription()}`,
    ).toBeUndefined();
    expect(heldIds(), "a pending row was held for a relayed send").toEqual([]);
    expect(
      rowsOf(TEXT_A),
      `a relayed send drew a row: ${pageDescription()}`,
    ).toHaveLength(0);
  });

  it("names the bound host and its epoch on a nonce request, and derives the pending row's id with them", async () => {
    await mountBoundAs({ ...HERE, epoch: 4 });

    await aSends(TEXT_A);

    const authority = { hostId: TAB_HOST, hostEpoch: 4 };
    expect(
      authorityOf(sendAt(0)),
      "the nonce request names no authority",
    ).toEqual(authority);
    expect(
      heldIds(),
      "the pending row's id does not derive from the authority",
    ).toEqual([rowIdUnder(sendAt(0), authority)]);
  });

  it("CONTROL: sends a post through a bound host that takes no nonce with none and draws no pending row", async () => {
    setSendLine(OLD_HOST);
    await mountBoundAs(HERE);

    await aSends(TEXT_A);

    expect(sendAt(0).sendNonce).toBeUndefined();
    expect(heldIds()).toEqual([]);
    expect(rowsOf(TEXT_A)).toHaveLength(0);
  });
});

describe("a send the host refused because the bot's binding moved", () => {
  /** A's first send, refused with E_BOT_AUTHORITY_MOVED: nothing was written. */
  async function theFirstSendIsRefusedAsMoved(): Promise<void> {
    await mountBoundAs(HERE);
    await aSends(TEXT_A);
    expect(
      heldIds(),
      "the first send drew no pending row to refuse",
    ).toHaveLength(1);
    const readsBefore = botReadsSoFar();
    await act(async () => {
      firstSend().reject(authorityMovedRefusal("the bot moved"));
      await Promise.resolve();
    });
    expect(
      textOf(channelBox()),
      "the refused text did not go back to the box",
    ).toBe(TEXT_A);
    expect(
      botReadsSoFar(),
      "the app did not read the bot again after the refusal",
    ).toBeGreaterThan(readsBefore);
  }

  it("gives the text back and reads the bot again", async () => {
    await theFirstSendIsRefusedAsMoved();
  });

  it("sends the next post with no nonce and draws no pending row once the bot reads as bound elsewhere", async () => {
    await theFirstSendIsRefusedAsMoved();
    bindNow({ kind: "team", hostId: ELSEWHERE, epoch: 2 });

    act(() => pressEnter());
    await waitFor(() => expect(loggedSends()).toHaveLength(2));

    expect(
      sendAt(1).sendNonce,
      `the next send carried a nonce after the bot moved: ${pageDescription()}`,
    ).toBeUndefined();
    expect(heldIds()).toEqual([]);
  });

  it("sends the next post with a fresh nonce under the new authority once the bot reads as bound here at a newer epoch", async () => {
    await theFirstSendIsRefusedAsMoved();
    bindNow({ ...HERE, epoch: 5 });

    act(() => pressEnter());
    await waitFor(() => expect(loggedSends()).toHaveLength(2));

    const second = sendAt(1);
    expect(
      authorityOf(second),
      "the next nonce request names the old authority or none",
    ).toEqual({ hostId: TAB_HOST, hostEpoch: 5 });
    expect(
      sendNonceOf(second),
      "the next send reused the refused send's nonce",
    ).not.toBe(sendNonceOf(sendAt(0)));
  });
});

describe("Retry of an unconfirmed send follows the binding it was made under", () => {
  it("CONTROL: sends the same request, nonce included, when the binding is unchanged", async () => {
    await mountBoundAs(HERE);
    await aSends(TEXT_A);
    await theSendTurnsUncertain();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(loggedSends()).toHaveLength(2));

    expect(sendAt(1)).toEqual(sendAt(0));
  });

  it.each<[string, BotBinding]>([
    ["another host", { kind: "team", hostId: ELSEWHERE, epoch: 1 }],
    ["the same host at a newer epoch", { ...HERE, epoch: 2 }],
  ])(
    "offers no Retry, and keeps the row unconfirmed with its text, once the bot is bound to %s, and sends nothing",
    async (_moved, binding) => {
      await mountBoundAs(HERE);
      await aSends(TEXT_A);
      await theSendTurnsUncertain();
      expect(
        screen.queryByRole("button", { name: "Retry" }),
        "Retry was not offered while the binding was unchanged",
      ).not.toBeNull();

      bindNow(binding);

      await expectRetryWithheldAndInert();
      expect(screen.queryAllByText(/not confirmed/i)).not.toHaveLength(0);
      expect(rowsOf(TEXT_A)).toHaveLength(1);
      expect(loggedSends()).toHaveLength(1);
    },
  );
});

describe("a held send when the tab is rebound to another host", () => {
  it("stays drawn in its chat, since a held send is the bot's and the chat's, not the host's", async () => {
    mocks.state.connectable = { hostIds: [OTHER_TAB_HOST], resolved: true };
    await mountBoundAs(HERE);
    await aSends(TEXT_A);
    expect(
      rowsOf(TEXT_A),
      `the held send was not drawn: ${pageDescription()}`,
    ).toHaveLength(1);

    act(() => {
      rebindUnreachableTracySurface(
        OTHER_TAB_HOST,
        (hostId) => hostId !== TAB_HOST,
      );
    });

    expect(
      rowsOf(TEXT_A),
      `the held send vanished when the tab was rebound: ${pageDescription()}`,
    ).toHaveLength(1);
  });
});

describe("a send the host refused as moved, by how many attempts it has made", () => {
  it("CONTROL: gives a first attempt's text back, drops its pending row and reads the bot again when it is answered E_BOT_AUTHORITY_MOVED", async () => {
    await mountBoundAs(HERE);
    await aSends(TEXT_A);
    expect(heldIds(), "the first attempt held no pending row").toHaveLength(1);
    const resubscribes = botReadsSoFar();

    await act(async () => {
      heldHost().sends[0].reject(authorityMovedRefusal("the bot moved"));
      await Promise.resolve();
    });

    expect(
      textOf(channelBox()),
      `the refused first attempt's text did not go back: ${pageDescription()}`,
    ).toBe(TEXT_A);
    expect(heldIds(), "the refused pending row was still held").toEqual([]);
    expect(rowsOf(TEXT_A)).toHaveLength(0);
    expect(botReadsSoFar(), "the bot was not read again").toBeGreaterThan(
      resubscribes,
    );
  });

  it("keeps a retried send unconfirmed when the host answers that the bot's binding moved, giving no text back", async () => {
    await mountBoundAs(HERE);
    await aSends(TEXT_A);
    await theSendTurnsUncertain();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(loggedSends()).toHaveLength(2));
    const resubscribes = botReadsSoFar();

    await act(async () => {
      heldHost().sends[1].reject(authorityMovedRefusal("the bot moved"));
      await Promise.resolve();
    });

    expect(
      Object.values(useBotPendingSendsStore.getState().entries).map(
        (send) => send?.state,
      ),
      "the retried send left the unconfirmed state",
    ).toEqual(["uncertain"]);
    expect(
      rowsOf(TEXT_A),
      `the retried send's row, with its text, was not drawn: ${pageDescription()}`,
    ).toHaveLength(1);
    expect(screen.queryAllByText(/not confirmed/i)).not.toHaveLength(0);
    expect(
      textOf(channelBox()),
      "a retried send's refusal gave its text back to the box",
    ).toBe("");
    expect(
      botReadsSoFar(),
      "the bot was not read again after the refusal",
    ).toBeGreaterThan(resubscribes);

    bindNow({ ...HERE, epoch: 2 });

    await expectRetryWithheldAndInert();
    expect(
      loggedSends(),
      "a send went out after the refusal: only the first attempt and the Retry should be logged",
    ).toHaveLength(2);
  });
});
