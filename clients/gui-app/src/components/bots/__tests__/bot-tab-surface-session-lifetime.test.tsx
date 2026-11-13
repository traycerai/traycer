/**
 * The Tracy surface (Tracy Bots): the surface asks `bot.open` through its own
 * host and follows the answer - serving, or paused with a reason - and never
 * names the machine a bot runs on or moves to it.
 * Also: the stream's states, the re-subscribe and re-open when the pane comes
 * back into view, the surface forgetting a channel's state and selecting the
 * default when the bot is gone from `bot.list`, and a team's main bot still
 * to be set up (T67): a channel on its id shows the channel where the team is
 * set up, with nothing opened, subscribed or forgotten (the real hook, over a
 * scripted `bot.onboarding.read`). Its Enable cloud
 * runs the real sandbox reads and create over a scripted control plane.
 * The three views and the bot's session view are replaced by stubs
 * that expose their props, so what the surface PASSES them is what is
 * asserted. The tab strip's Activity count reads the real
 * `useBotActiveTasks` over the real agent-activity store and the real
 * notification-indicator hooks (the host answers `indicatorState`).
 */
import {
  botListChangedMock,
  botListQueryMock,
  botMemoryMock,
  botMutationsMock,
  botSubscriptionMock,
  botThreadListQueryMock,
  connectableHostIdsMock,
  environmentListMock,
  environmentMembersMock,
  hostDirectoryListMock,
  hostEnvironmentBindingsMock,
  cloudEpicTasksMock,
  epicTaskContextsMock,
  hostClientForHostIdMock,
  hostQueriesMock,
  hostSupportsMethodMock,
  mocks,
  notificationHostMock,
  tabHostClientMock,
  tabHostProviderMock,
  tabNavigationMock,
} from "./bot-tab-surface-mocks";
import { BotMentionsContext } from "@/components/bots/bot-mentions-context";

import { KEYBOARD_FOCUS_OWNER_PROPS } from "@/hooks/ui/use-keyboard-focus-layout";
import { setPhoneLayoutOnly } from "@/lib/mobile-app";
import {
  holdScreenLandscape,
  IPHONE_17,
  lowerNativeKeyboard,
  raiseNativeKeyboard,
  restoreKeyboardEnvironment,
} from "../../../../__tests__/short-keyboard-viewport-harness";
import {
  installShellForm,
  SHELL_WIDTH_MENU,
  type ShellFormHarness,
} from "../../../../__tests__/mobile-level2-form-harness";
import { StrictMode, useContext, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  render,
  screen,
  within,
  type RenderResult,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  BotThreadSummary,
  BotTurnRef,
} from "@traycer/protocol/host/bot/conversation-schemas";
import type { BotChannelLanding } from "@/components/bots/bot-channel-view";

import type { BotOpenSession } from "@/components/bots/bot-session-view";
import type {
  BotOpenMemory,
  BotOpenThread,
  BotSessionOpen,
  BotTurnOpen,
} from "@/stores/bots/bot-open-thread-store";
import {
  BOT,
  BOT_ID,
  endBotTabSurfaceCase,
  NEEDS_HOST_SETUP,
  OTHER_BOT_ID,
  resetBotTabSurfaceMocks,
  SETUP_BOT_ID,
  TAB_HOST,
} from "./bot-tab-surface-harness";

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
}));
vi.mock("@/lib/tab-navigation", async (importOriginal) =>
  tabNavigationMock(
    await importOriginal<typeof import("@/lib/tab-navigation")>(),
  ),
);
// The tasks a bot's channel can name come from two host reads, scripted here:
// the titles of the stream's tasks, and Home's task list.
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
vi.mock("@/hooks/host/use-host-supports-method", () => hostSupportsMethodMock);
// The Activity count reads the notification indicators through the notification
// host; the query transport below answers them.
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
vi.mock("@/hooks/host/use-tab-host-client", () => tabHostClientMock);
vi.mock(
  "@/components/epic-tabs/pane-visibility-context",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/components/epic-tabs/pane-visibility-context")
    >()),
    usePaneVisible: () => mocks.state.paneVisible,
  }),
);
// The card's memory row is driven in `bot-memory-pane.test.tsx`.
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
vi.mock("@/hooks/bots/use-bot-mutations", () => botMutationsMock);
vi.mock("@/components/bots/bot-channel-sidebar", () => ({
  BotChannelSidebar: (props: {
    activeBotId: string | null;
    hostId: string;
    threadsView: {
      shown: boolean;
      onShow: () => void;
      onLeave: () => void;
    } | null;
    onChannelOpened: () => void;
  }) => (
    <div
      data-testid="stub-sidebar"
      data-active-bot-id={props.activeBotId ?? "none"}
      data-host-id={props.hostId}
      data-threads-shown={String(props.threadsView?.shown ?? "none")}
    >
      <button
        type="button"
        data-testid="stub-sidebar-pick"
        onClick={props.onChannelOpened}
      />
      <button
        type="button"
        data-testid="stub-sidebar-threads"
        onClick={props.threadsView?.onShow}
      />
      <button
        type="button"
        data-testid="stub-sidebar-own-channel"
        onClick={props.threadsView?.onLeave}
      />
    </div>
  ),
}));
/** What the tab hands its content to mention (`BotMentionsContext`), as the stub channel sees it. */
function MentionsProbe(): ReactNode {
  const mentionable = useContext(BotMentionsContext);
  if (mentionable === null) return null;
  return (
    <output
      data-testid="stub-mentionable"
      data-bots={
        mentionable.bots === null
          ? "unread"
          : mentionable.bots.map((target) => target.name).join("|")
      }
      data-tasks={mentionable.tasks.map((target) => target.name).join("|")}
    />
  );
}

vi.mock("@/components/bots/bot-channel-view", () => ({
  BotChannelView: (props: {
    botId: string;
    hostId: string;
    boundHostId: string | null;
    botTitle: string;
    appConversationChatId: string | null;
    openThread: BotOpenThread | null;
    landOn: BotChannelLanding | null;
    trunkChatId: string;
    openMemory: BotOpenMemory | null;
    onOpenMemory: (open: BotOpenMemory | null) => void;
    onOpenTurn: BotTurnOpen;
    onOpenSession: BotSessionOpen;
    resolveMember: (
      userId: string,
    ) => { displayName: string | null; avatarUrl: string | null } | null;
    setupHistory: ReactNode;
    tiles: number | null;
  }) => (
    <div
      data-testid="stub-channel"
      data-tiles={String(props.tiles)}
      data-host-id={props.hostId}
      data-bound-host-id={props.boundHostId ?? "none"}
      data-bot-title={props.botTitle}
      data-app-conversation-chat-id={props.appConversationChatId ?? "none"}
      data-open-thread={props.openThread?.anchorMessageId ?? "none"}
      data-land-on={props.landOn?.messageId ?? "none"}
      data-land-on-thread={props.landOn?.threadId ?? "none"}
      data-open-memory={String(props.openMemory !== null)}
      data-trunk-chat-id={props.trunkChatId}
      data-teammate-name={
        props.resolveMember("user-teammate")?.displayName ?? "unresolved"
      }
    >
      <button
        type="button"
        data-testid="stub-channel-open-memory"
        onClick={() => props.onOpenMemory({ back: null })}
      />
      <button
        type="button"
        data-testid="stub-channel-open-turn"
        onClick={() => props.onOpenTurn(REPLY_TURN, null)}
      />
      <button
        type="button"
        data-testid="stub-channel-open-thread-session"
        onClick={() =>
          props.onOpenSession({
            chatId: "session-thread-1",
            threadId: "thread-1",
            messageId: null,
            sendPostId: null,
          })
        }
      />
      {props.setupHistory}
      <MentionsProbe />
      {/* The two boxes' places in the real view: the channel's own, and one
          inside the thread panel, which the header tells apart by its marker. */}
      <div {...KEYBOARD_FOCUS_OWNER_PROPS}>
        <textarea aria-label="Channel box" />
      </div>
      <section data-bot-thread-panel="">
        <div {...KEYBOARD_FOCUS_OWNER_PROPS}>
          <textarea aria-label="Thread box" />
        </div>
      </section>
    </div>
  ),
}));
// The session view is driven in `bot-session-view.test.tsx`; here, what the
// tab hands it and what its links do to the tab.
vi.mock("@/components/bots/bot-session-view", () => ({
  BotSessionView: (props: {
    session: BotOpenSession;
    onClose: () => void;
    onOpenChannel: (messageId: string | null) => void;
    onOpenThread: (threadId: string, messageId: string | null) => void;
  }) => (
    <div
      data-testid="stub-session"
      data-chat-id={props.session.chatId}
      data-thread-id={props.session.threadId ?? "none"}
      data-land-on={props.session.landOn?.messageId ?? "none"}
      data-visit={String(props.session.landOn?.visit ?? "none")}
    >
      <button
        type="button"
        data-testid="stub-session-back"
        onClick={props.onClose}
      />
      <button
        type="button"
        data-testid="stub-session-channel"
        onClick={() => props.onOpenChannel(null)}
      />
      <button
        type="button"
        data-testid="stub-session-post"
        onClick={() => props.onOpenChannel("post-1")}
      />
      <button
        type="button"
        data-testid="stub-session-thread"
        onClick={() => props.onOpenThread("thread-1", null)}
      />
      <button
        type="button"
        data-testid="stub-session-thread-post"
        onClick={() => props.onOpenThread("thread-1", "thread-reply-9")}
      />
    </div>
  ),
}));
// The Activity page takes whether this host runs the bot, and the list the
// tab's count is read from: its rows are what the page would draw.
vi.mock("@/components/bots/bot-activity-page", () => ({
  BotActivityPage: (props: {
    boundHere: boolean;
    active: { rows: ReadonlyArray<{ task: { taskId: string } }> };
  }) => (
    <div
      data-testid="stub-activity"
      data-is-this-host={String(props.boundHere)}
      data-row-ids={props.active.rows.map((row) => row.task.taskId).join(",")}
    />
  ),
}));
vi.mock("@/components/bots/bot-threads-view", () => ({
  BotThreadsView: (props: {
    hostId: string;
    channelTitle: string;
    onBack: () => void;
  }) => (
    <div
      data-testid="stub-threads"
      data-host-id={props.hostId}
      data-channel-title={props.channelTitle}
    >
      <button
        type="button"
        data-testid="stub-threads-back"
        onClick={props.onBack}
      />
    </div>
  ),
}));
vi.mock("@/hooks/bots/use-bot-thread-list-query", () => botThreadListQueryMock);
// The panel takes the bot, whether its environment is a person's own, its
// channel, its environment's bots and how to close, and nothing else: no prop
// says which host serves the tab, so no control can be gated on it. The stub lists the props it was given.
vi.mock("@/components/bots/bot-settings-panel", () => ({
  BotChannelSettingsPanel: (props: {
    personal: boolean;
    channelId: string | null;
    onClose: () => void;
    onDeleted: () => void;
  }) => (
    <div
      data-testid="stub-settings"
      data-personal={String(props.personal)}
      data-channel-id={props.channelId ?? "none"}
    >
      <button
        type="button"
        data-testid="stub-settings-close"
        onClick={props.onClose}
      />
      <button
        type="button"
        data-testid="stub-settings-deleted"
        onClick={props.onDeleted}
      />
    </div>
  ),
}));

import {
  parseNotificationPayload,
  routeNotificationForHost,
} from "@/lib/notifications/payload";
import { BotTabSurface } from "@/components/bots/bot-tab-surface";
import { useTracySurfaceStore } from "@/stores/bots/tracy-surface-store";

import { useBotTabLandingStore } from "@/stores/bots/bot-tab-landing-store";
import { openChatSearchResult } from "@/lib/chat-search/open-chat-search-result";
import { rowFromHostEntry } from "@/stores/notifications/merged-notifications";
import { useBotDraftsStore } from "@/stores/bots/bot-drafts-store";
import { useBotOpenThreadStore } from "@/stores/bots/bot-open-thread-store";
import { useTracyPlaceStore } from "@/stores/bots/tracy-place-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { isHistoryEntryDead } from "@/lib/history-navigation/liveness";
import { isHistoryEntryEligible } from "@/lib/history-navigation/eligibility";

/** The trunk's turn behind a reply in the channel. */
const REPLY_TURN: BotTurnRef = {
  chatId: "trunk-1",
  turnIds: ["turn-reply"],
  userMessageId: "prompt-reply",
  threadId: null,
  startedAt: 1_000,
  endedAt: 2_000,
  summary: null,
  messageIds: ["reply-1"],
  requestIds: [],
};

let queryClient = new QueryClient();

function surfaceFor(botId: string | null): ReactNode {
  return (
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <BotTabSurface botId={botId} hostId={TAB_HOST} />
      </QueryClientProvider>
    </StrictMode>
  );
}

function surface(): ReactNode {
  return surfaceFor(BOT_ID);
}

/**
 * Whether the surface still keeps `botId`'s per-channel state: the unsent
 * draft `openSurfaceOn` left in its thread box, which the surface clears when
 * it forgets the bot.
 */
function isKept(botId: string): boolean {
  return useBotDraftsStore.getState().threadBoxes[botId] !== undefined;
}

beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  resetBotTabSurfaceMocks();
});

afterEach(() => {
  endBotTabSurfaceCase(queryClient);
});

describe("<BotTabSurface /> a bot's session in place of its channel", () => {
  function sessionShown(): HTMLElement {
    return screen.getByTestId("stub-session");
  }

  it("opens a reply's turn from the channel, each open a new visit, and its channel link brings Messages back where the channel was", async () => {
    const user = userEvent.setup();
    render(surface());

    await user.click(screen.getByTestId("stub-channel-open-turn"));
    expect(sessionShown().dataset.landOn).toBe("prompt-reply");
    const firstVisit = sessionShown().dataset.visit;
    await user.click(screen.getByTestId("stub-session-back"));
    await user.click(screen.getByTestId("stub-channel-open-turn"));
    expect(sessionShown().dataset.visit).not.toBe(firstVisit);

    await user.click(screen.getByTestId("stub-session-channel"));

    expect(screen.queryByTestId("stub-session")).toBeNull();
    expect(
      screen.getByTestId("stub-channel").getAttribute("data-land-on"),
    ).toBe("none");
  });

  it("shows the channel on the post a send followed, and the next session's back leaves it where it was", async () => {
    const user = userEvent.setup();
    render(surface());
    await user.click(screen.getByTestId("stub-channel-open-turn"));

    await user.click(screen.getByTestId("stub-session-post"));

    expect(
      screen.getByTestId("bot-tab-view-messages").getAttribute("aria-selected"),
    ).toBe("true");
    expect(
      screen.getByTestId("stub-channel").getAttribute("data-land-on"),
    ).toBe("post-1");

    await user.click(screen.getByTestId("stub-channel-open-turn"));
    await user.click(screen.getByTestId("stub-session-back"));

    expect(
      screen.getByTestId("stub-channel").getAttribute("data-land-on"),
    ).toBe("none");
  });

  it("lands the channel on a send's post once: leaving Messages by the Activity tab and coming back does not land again", async () => {
    const user = userEvent.setup();
    render(surface());
    await user.click(screen.getByTestId("stub-channel-open-turn"));
    await user.click(screen.getByTestId("stub-session-post"));
    expect(
      screen.getByTestId("stub-channel").getAttribute("data-land-on"),
    ).toBe("post-1");

    await user.click(screen.getByTestId("bot-tab-view-activity"));
    expect(screen.queryByTestId("stub-channel")).toBeNull();
    await user.click(screen.getByTestId("bot-tab-view-messages"));

    expect(
      screen.getByTestId("stub-channel").getAttribute("data-land-on"),
    ).toBe("none");
  });

  it("opens a thread's session from its panel, and shows that thread beside the channel by its post from the session", async () => {
    const user = userEvent.setup();
    mocks.state.threads = [
      {
        threadId: "thread-1",
        conversationId: "conversation-app",
        sessionChatId: "session-thread-1",
        anchor: {
          messageId: "post-7",
          requestId: "req-7",
          senderUserId: "user-1",
          sentAt: 1_000,
          resolvedAt: 1_001,
          excerpt: null,
        },
        replyCount: 1,
        lastReplyAt: 2_000,
        openRequestCount: 0,
        costUsd: null,
      },
    ];
    render(surface());

    await user.click(screen.getByTestId("stub-channel-open-thread-session"));
    expect(sessionShown().dataset.chatId).toBe("session-thread-1");
    expect(sessionShown().dataset.threadId).toBe("thread-1");
    expect(sessionShown().dataset.landOn).toBe("none");

    await user.click(screen.getByTestId("stub-session-thread"));

    expect(screen.queryByTestId("stub-session")).toBeNull();
    expect(
      screen.getByTestId("stub-channel").getAttribute("data-open-thread"),
    ).toBe("post-7");
  });

  it("shows a thread beside the channel landed on the post a session's send wrote in it", async () => {
    const user = userEvent.setup();
    mocks.state.threads = [
      {
        threadId: "thread-1",
        conversationId: "conversation-app",
        sessionChatId: "session-thread-1",
        anchor: {
          messageId: "post-7",
          requestId: "req-7",
          senderUserId: "user-1",
          sentAt: 1_000,
          resolvedAt: 1_001,
          excerpt: null,
        },
        replyCount: 1,
        lastReplyAt: 2_000,
        openRequestCount: 0,
        costUsd: null,
      },
    ];
    render(surface());

    await user.click(screen.getByTestId("stub-channel-open-thread-session"));
    await user.click(screen.getByTestId("stub-session-thread-post"));

    const channel = screen.getByTestId("stub-channel");
    expect(channel.getAttribute("data-open-thread")).toBe("post-7");
    expect(channel.getAttribute("data-land-on")).toBe("thread-reply-9");
    expect(channel.getAttribute("data-land-on-thread")).toBe("thread-1");
  });

  describe("an unrelated thread open beside the channel", () => {
    const OTHER_THREAD_RAIL = {
      kind: "thread",
      anchorMessageId: "post-other",
      announcement: false,
      anchorKind: null,
      sent: null,
    } as const;

    beforeEach(() => {
      useBotOpenThreadStore.getState().setRail(BOT_ID, OTHER_THREAD_RAIL);
      useBotTabLandingStore.setState({ byBotId: {} });
    });

    function openThreadBeside(): string | null {
      return screen
        .getByTestId("stub-channel")
        .getAttribute("data-open-thread");
    }

    it("is closed when a session opens a row of the channel, and kept when it goes back to the channel", async () => {
      const user = userEvent.setup();
      render(surface());
      expect(openThreadBeside()).toBe("post-other");

      await user.click(screen.getByTestId("stub-channel-open-thread-session"));
      await user.click(screen.getByTestId("stub-session-channel"));
      expect(openThreadBeside()).toBe("post-other");

      await user.click(screen.getByTestId("stub-channel-open-thread-session"));
      await user.click(screen.getByTestId("stub-session-post"));
      expect(openThreadBeside()).toBe("none");
    });

    it("is closed when a session opens a thread the list does not name", async () => {
      const user = userEvent.setup();
      mocks.state.threads = [];
      render(surface());

      await user.click(screen.getByTestId("stub-channel-open-thread-session"));
      await user.click(screen.getByTestId("stub-session-thread"));

      expect(openThreadBeside()).toBe("none");
    });

    it("is closed by a requested landing on a row of the channel", () => {
      mocks.state.threads = [];
      useBotTabLandingStore.getState().request(BOT_ID, {
        kind: "thread",
        threadId: null,
        messageId: "post-1",
      });
      render(surface());

      expect(openThreadBeside()).toBe("none");
    });

    it("is closed by a tapped push of the channel itself, from its payload through its route to the surface", () => {
      mocks.state.threads = [];
      const payload = parseNotificationPayload({
        kind: "chat",
        epicId: BOT_ID,
        chatId: "conversation-app",
        botId: BOT_ID,
      });
      expect(payload).toMatchObject({
        kind: "chat",
        bot: { botId: BOT_ID, threadId: null, messageId: null },
      });
      if (payload === null) throw new Error("the payload did not parse");

      expect(
        routeNotificationForHost(vi.fn(), payload, 1_000, {
          originHostId: null,
          effectiveHostId: "host-1",
        }),
      ).toBe(true);
      expect(useBotTabLandingStore.getState().byBotId[BOT_ID]).toEqual({
        kind: "thread",
        threadId: null,
        messageId: null,
      });
      render(surface());

      expect(useBotTabLandingStore.getState().byBotId).toEqual({});
      expect(openThreadBeside()).toBe("none");
    });

    it("is closed by a requested landing on a thread the list does not name", () => {
      mocks.state.threads = [];
      useBotTabLandingStore.getState().request(BOT_ID, {
        kind: "thread",
        threadId: "thread-gone",
        messageId: "reply-3",
      });
      render(surface());

      expect(openThreadBeside()).toBe("none");
    });
  });

  describe("a landing requested from outside, as a tapped push does", () => {
    const LISTED_THREAD: BotThreadSummary = {
      threadId: "thread-1",
      conversationId: "conversation-app",
      sessionChatId: "session-thread-1",
      anchor: {
        messageId: "post-7",
        requestId: "req-7",
        senderUserId: "user-1",
        sentAt: 1_000,
        resolvedAt: 1_001,
        excerpt: null,
      },
      replyCount: 1,
      lastReplyAt: 2_000,
      openRequestCount: 0,
      costUsd: null,
    };

    beforeEach(() => {
      useBotTabLandingStore.setState({ byBotId: {} });
    });

    it("opens the listed thread beside the channel on the row, and is spent, so a later render does not land it again", () => {
      mocks.state.threads = [LISTED_THREAD];
      useBotTabLandingStore.getState().request(BOT_ID, {
        kind: "thread",
        threadId: "thread-1",
        messageId: "reply-3",
      });
      const { rerender } = render(surface());

      const channel = screen.getByTestId("stub-channel");
      expect(channel.getAttribute("data-open-thread")).toBe("post-7");
      expect(channel.getAttribute("data-land-on")).toBe("reply-3");
      expect(channel.getAttribute("data-land-on-thread")).toBe("thread-1");
      expect(useBotTabLandingStore.getState().byBotId).toEqual({});

      // The person closes the thread; rendering again does not reopen it.
      act(() => useBotOpenThreadStore.getState().setRail(BOT_ID, null));
      rerender(surface());
      expect(
        screen.getByTestId("stub-channel").getAttribute("data-open-thread"),
      ).toBe("none");
    });

    it("shows the channel when the list does not name the thread", () => {
      mocks.state.threads = [LISTED_THREAD];
      useBotTabLandingStore.getState().request(BOT_ID, {
        kind: "thread",
        threadId: "thread-gone",
        messageId: "reply-3",
      });
      render(surface());

      const channel = screen.getByTestId("stub-channel");
      expect(channel.getAttribute("data-open-thread")).toBe("none");
      expect(channel.getAttribute("data-land-on")).toBe("none");
      expect(useBotTabLandingStore.getState().byBotId).toEqual({});
    });
  });

  describe("a chat search hit landing in the bot's tab", () => {
    const LISTED_THREAD: BotThreadSummary = {
      threadId: "thread-1",
      conversationId: "conversation-app",
      sessionChatId: "session-thread-1",
      anchor: {
        messageId: "post-7",
        requestId: "req-7",
        senderUserId: "user-1",
        sentAt: 1_000,
        resolvedAt: 1_001,
        excerpt: null,
      },
      replyCount: 1,
      lastReplyAt: 2_000,
      openRequestCount: 0,
      costUsd: null,
    };

    beforeEach(() => {
      useBotTabLandingStore.setState({ byBotId: {} });
      mocks.state.threads = [LISTED_THREAD];
    });

    function openSearchHit(chatId: string, messageId: string): void {
      openChatSearchResult(
        vi.fn(),
        { epicId: BOT_ID, chatId, hostId: TAB_HOST, messageId },
        { effectiveHostId: TAB_HOST, now: 1_000 },
      );
    }

    function expectNoSession(): void {
      expect(screen.queryByTestId("stub-session")).toBeNull();
    }

    it("lands the channel on the row when the hit is in the channel's chat", () => {
      openSearchHit(BOT.appConversationChatId ?? "", "post-1");
      render(surface());

      const channel = screen.getByTestId("stub-channel");
      expect(channel.getAttribute("data-land-on")).toBe("post-1");
      expect(channel.getAttribute("data-open-thread")).toBe("none");
      expectNoSession();
      expect(useBotTabLandingStore.getState().byBotId).toEqual({});
    });

    it("opens the thread beside the channel on the row when the hit is in a thread's record", () => {
      openSearchHit("thread-1", "reply-3");
      render(surface());

      const channel = screen.getByTestId("stub-channel");
      expect(channel.getAttribute("data-open-thread")).toBe("post-7");
      expect(channel.getAttribute("data-land-on")).toBe("reply-3");
      expect(channel.getAttribute("data-land-on-thread")).toBe("thread-1");
      expectNoSession();
      expect(useBotTabLandingStore.getState().byBotId).toEqual({});
    });

    it("opens the thread's session on the row when the hit is in a thread's session", () => {
      openSearchHit("session-thread-1", "session-row-1");
      render(surface());

      const session = screen.getByTestId("stub-session");
      expect(session.getAttribute("data-chat-id")).toBe("session-thread-1");
      expect(session.getAttribute("data-thread-id")).toBe("thread-1");
      expect(session.getAttribute("data-land-on")).toBe("session-row-1");
      expect(useBotTabLandingStore.getState().byBotId).toEqual({});
    });

    it("opens the trunk session on the row when the hit is in the bot's trunk chat", () => {
      openSearchHit(BOT.trunkChatId, "turn-1");
      render(surface());

      const session = screen.getByTestId("stub-session");
      expect(session.getAttribute("data-chat-id")).toBe(BOT.trunkChatId);
      expect(session.getAttribute("data-thread-id")).toBe("none");
      expect(session.getAttribute("data-land-on")).toBe("turn-1");
      expect(useBotTabLandingStore.getState().byBotId).toEqual({});
    });

    it("lands nowhere, and is spent, when the hit's chat is none of the bot's", () => {
      openSearchHit("chat-unknown", "post-1");
      render(surface());

      const channel = screen.getByTestId("stub-channel");
      expect(channel.getAttribute("data-land-on")).toBe("none");
      expect(channel.getAttribute("data-open-thread")).toBe("none");
      expectNoSession();
      expect(useBotTabLandingStore.getState().byBotId).toEqual({});
    });

    it("shows the thread whose session sent beside the channel, with no session opened, for a sender landing", () => {
      useBotTabLandingStore
        .getState()
        .request(BOT_ID, { kind: "sender", chatId: "session-thread-1" });
      render(surface());

      const channel = screen.getByTestId("stub-channel");
      expect(channel.getAttribute("data-open-thread")).toBe("post-7");
      expect(channel.getAttribute("data-land-on")).toBe("none");
      expectNoSession();
      expect(useBotTabLandingStore.getState().byBotId).toEqual({});
    });

    it("keeps a sender landing while the thread list is read again, and opens the thread the fresh list brings", () => {
      const NEW_THREAD: BotThreadSummary = {
        ...LISTED_THREAD,
        threadId: "thread-2",
        sessionChatId: "session-thread-2",
        anchor: {
          messageId: "post-8",
          requestId: "req-8",
          senderUserId: "user-1",
          sentAt: 3_000,
          resolvedAt: null,
          excerpt: null,
        },
      };
      const { rerender } = render(surface());

      // The held list lacks the sender's thread, and a read of it starts.
      mocks.state.threadsFetching = true;
      rerender(surface());
      act(() =>
        useBotTabLandingStore
          .getState()
          .request(BOT_ID, { kind: "sender", chatId: "session-thread-2" }),
      );

      expect(useBotTabLandingStore.getState().byBotId[BOT_ID]).toEqual({
        kind: "sender",
        chatId: "session-thread-2",
      });
      const channel = screen.getByTestId("stub-channel");
      expect(channel.getAttribute("data-open-thread")).toBe("none");
      expect(channel.getAttribute("data-land-on")).toBe("none");

      // The read answers with the thread.
      mocks.state.threads = [LISTED_THREAD, NEW_THREAD];
      mocks.state.threadsFetching = false;
      rerender(surface());

      expect(
        screen.getByTestId("stub-channel").getAttribute("data-open-thread"),
      ).toBe("post-8");
      expectNoSession();
      expect(useBotTabLandingStore.getState().byBotId).toEqual({});
    });

    it("spends a waiting sender landing unlanded when the person moves the tab, and opens no thread when the list answers", async () => {
      const user = userEvent.setup();
      const NEW_THREAD: BotThreadSummary = {
        ...LISTED_THREAD,
        threadId: "thread-2",
        sessionChatId: "session-thread-2",
        anchor: {
          messageId: "post-8",
          requestId: "req-8",
          senderUserId: "user-1",
          sentAt: 3_000,
          resolvedAt: null,
          excerpt: null,
        },
      };
      const { rerender } = render(surface());

      // The held list lacks the sender's thread, and a read of it starts.
      mocks.state.threadsFetching = true;
      rerender(surface());
      act(() =>
        useBotTabLandingStore
          .getState()
          .request(BOT_ID, { kind: "sender", chatId: "session-thread-2" }),
      );
      expect(useBotTabLandingStore.getState().byBotId[BOT_ID]).toEqual({
        kind: "sender",
        chatId: "session-thread-2",
      });

      // The person opens Activity while the landing waits.
      await user.click(screen.getByRole("tab", { name: /^Activity/ }));

      expect(useBotTabLandingStore.getState().byBotId).toEqual({});
      expect(
        screen.getByRole("tab", { name: /^Activity/, selected: true }),
      ).toBeTruthy();

      // The read answers with the thread.
      mocks.state.threads = [LISTED_THREAD, NEW_THREAD];
      mocks.state.threadsFetching = false;
      rerender(surface());

      expect(
        screen.getByRole("tab", { name: /^Activity/, selected: true }),
      ).toBeTruthy();
      expect(screen.getByTestId("stub-activity")).toBeTruthy();
      expectNoSession();

      await user.click(screen.getByRole("tab", { name: /^Messages/ }));

      const channel = screen.getByTestId("stub-channel");
      expect(channel.getAttribute("data-open-thread")).toBe("none");
      expect(channel.getAttribute("data-land-on")).toBe("none");
      expectNoSession();
    });

    it("spends a waiting sender landing unlanded when the person opens Threads, which stays open when the list answers", async () => {
      const user = userEvent.setup();
      const NEW_THREAD: BotThreadSummary = {
        ...LISTED_THREAD,
        threadId: "thread-2",
        sessionChatId: "session-thread-2",
        anchor: {
          messageId: "post-8",
          requestId: "req-8",
          senderUserId: "user-1",
          sentAt: 3_000,
          resolvedAt: null,
          excerpt: null,
        },
      };
      const { rerender } = render(surface());

      // The held list lacks the sender's thread, and a read of it starts.
      mocks.state.threadsFetching = true;
      rerender(surface());
      act(() =>
        useBotTabLandingStore
          .getState()
          .request(BOT_ID, { kind: "sender", chatId: "session-thread-2" }),
      );
      expect(useBotTabLandingStore.getState().byBotId[BOT_ID]).toEqual({
        kind: "sender",
        chatId: "session-thread-2",
      });

      // The person opens Threads from the column while the landing waits.
      await user.click(screen.getByTestId("stub-sidebar-threads"));

      expect(useBotTabLandingStore.getState().byBotId).toEqual({});
      expect(screen.getByTestId("stub-threads")).toBeTruthy();

      // The read answers with the thread.
      mocks.state.threads = [LISTED_THREAD, NEW_THREAD];
      mocks.state.threadsFetching = false;
      rerender(surface());

      expect(screen.getByTestId("stub-threads")).toBeTruthy();
      expect(
        screen.getByTestId("stub-sidebar").getAttribute("data-threads-shown"),
      ).toBe("true");
      expect(screen.queryByTestId("stub-channel")).toBeNull();
      expectNoSession();
    });

    it("spends a sender landing waiting on the first thread-list read when the person opens Activity, which stays when the list answers", async () => {
      const user = userEvent.setup();
      const NEW_THREAD: BotThreadSummary = {
        ...LISTED_THREAD,
        threadId: "thread-2",
        sessionChatId: "session-thread-2",
        anchor: {
          messageId: "post-8",
          requestId: "req-8",
          senderUserId: "user-1",
          sentAt: 3_000,
          resolvedAt: null,
          excerpt: null,
        },
      };
      // No list is held yet, and its first read is in flight.
      mocks.state.threadsHeld = false;
      mocks.state.threadsFetching = true;
      const view = render(surface());
      act(() =>
        useBotTabLandingStore
          .getState()
          .request(BOT_ID, { kind: "sender", chatId: "session-thread-2" }),
      );
      expect(useBotTabLandingStore.getState().byBotId[BOT_ID]).toEqual({
        kind: "sender",
        chatId: "session-thread-2",
      });

      // The person opens Activity while the landing waits on the first read.
      await user.click(screen.getByRole("tab", { name: /^Activity/ }));

      expect(useBotTabLandingStore.getState().byBotId).toEqual({});
      expect(
        screen.getByRole("tab", { name: /^Activity/, selected: true }),
      ).toBeTruthy();

      // The first read answers with the sender's thread.
      mocks.state.threadsHeld = true;
      mocks.state.threads = [LISTED_THREAD, NEW_THREAD];
      mocks.state.threadsFetching = false;
      view.rerender(surface());

      expect(
        screen.getByRole("tab", { name: /^Activity/, selected: true }),
      ).toBeTruthy();
      expect(screen.getByTestId("stub-activity")).toBeTruthy();
      expectNoSession();
      expect(useBotTabLandingStore.getState().byBotId).toEqual({});

      await user.click(screen.getByRole("tab", { name: /^Messages/ }));

      const channel = screen.getByTestId("stub-channel");
      expect(channel.getAttribute("data-open-thread")).toBe("none");
      expect(channel.getAttribute("data-land-on")).toBe("none");
      expectNoSession();
    });

    it("spends a waiting sender landing unlanded when the person opens the bot's memory, which stays when the list answers", async () => {
      const user = userEvent.setup();
      const NEW_THREAD: BotThreadSummary = {
        ...LISTED_THREAD,
        threadId: "thread-2",
        sessionChatId: "session-thread-2",
        anchor: {
          messageId: "post-8",
          requestId: "req-8",
          senderUserId: "user-1",
          sentAt: 3_000,
          resolvedAt: null,
          excerpt: null,
        },
      };
      const { rerender } = render(surface());

      // The held list lacks the sender's thread, and a read of it starts.
      mocks.state.threadsFetching = true;
      rerender(surface());
      act(() =>
        useBotTabLandingStore
          .getState()
          .request(BOT_ID, { kind: "sender", chatId: "session-thread-2" }),
      );
      expect(useBotTabLandingStore.getState().byBotId[BOT_ID]).toEqual({
        kind: "sender",
        chatId: "session-thread-2",
      });

      // The person opens the bot's memory beside the channel while it waits.
      await user.click(screen.getByTestId("stub-channel-open-memory"));

      expect(useBotTabLandingStore.getState().byBotId).toEqual({});
      expect(
        screen.getByTestId("stub-channel").getAttribute("data-open-memory"),
      ).toBe("true");

      // The read answers with the thread.
      mocks.state.threads = [LISTED_THREAD, NEW_THREAD];
      mocks.state.threadsFetching = false;
      rerender(surface());

      const channel = screen.getByTestId("stub-channel");
      expect(channel.getAttribute("data-open-memory")).toBe("true");
      expect(channel.getAttribute("data-open-thread")).toBe("none");
      expect(channel.getAttribute("data-land-on")).toBe("none");
      expectNoSession();
      expect(useBotTabLandingStore.getState().byBotId).toEqual({});
    });

    it("lands the channel for a sender landing when the first thread-list read fails", async () => {
      const user = userEvent.setup();
      // No list is held, and its first read has failed.
      mocks.state.threadsHeld = false;
      mocks.state.threadsFetching = false;
      mocks.state.threadsError = true;
      render(surface());
      await user.click(screen.getByRole("tab", { name: /^Activity/ }));
      expect(screen.getByTestId("stub-activity")).toBeTruthy();

      act(() =>
        useBotTabLandingStore
          .getState()
          .request(BOT_ID, { kind: "sender", chatId: "session-thread-2" }),
      );

      expect(useBotTabLandingStore.getState().byBotId).toEqual({});
      expect(
        screen.getByRole("tab", { name: /^Messages/, selected: true }),
      ).toBeTruthy();
      const channel = screen.getByTestId("stub-channel");
      expect(channel.getAttribute("data-open-thread")).toBe("none");
      expect(channel.getAttribute("data-land-on")).toBe("none");
      expectNoSession();
    });

    it("lands the channel, with no thread or session, for a sender landing on the trunk chat", () => {
      useBotTabLandingStore
        .getState()
        .request(BOT_ID, { kind: "sender", chatId: BOT.trunkChatId });
      render(surface());

      const channel = screen.getByTestId("stub-channel");
      expect(channel.getAttribute("data-open-thread")).toBe("none");
      expect(channel.getAttribute("data-land-on")).toBe("none");
      expectNoSession();
      expect(useBotTabLandingStore.getState().byBotId).toEqual({});
    });

    it.each([
      ["the trunk session", "trunk-1"],
      ["a thread's session", "session-thread-1"],
    ])(
      "leaves Threads for %s, with the channel under it for Back",
      async (_kind, chatId) => {
        const user = userEvent.setup();
        render(surface());
        await user.click(screen.getByTestId("stub-sidebar-threads"));
        expect(screen.getByTestId("stub-threads")).toBeTruthy();

        act(() => openSearchHit(chatId, "session-row-1"));

        expect(useBotTabLandingStore.getState().byBotId).toEqual({});
        expect(screen.queryByTestId("stub-threads")).toBeNull();
        expect(screen.getByTestId("stub-session").dataset.chatId).toBe(chatId);

        await user.click(screen.getByTestId("stub-session-back"));

        expect(screen.queryByTestId("stub-threads")).toBeNull();
        expect(screen.getByTestId("stub-channel")).toBeTruthy();
      },
    );

    // A row can name a host that has since gone; a surface that opens for it
    // takes the window's host instead, which routes the bot to wherever it is
    // served.
    it.each(["a search hit", "a notification"])(
      "opens the surface on the window's host when %s names a host that is gone",
      (source) => {
        // The surface is closed: an open one keeps its own host.
        useTracySurfaceStore.setState({
          open: false,
          hostId: null,
          botId: null,
          visitedBotIds: [],
        });
        if (source === "a search hit") {
          openChatSearchResult(
            vi.fn(),
            {
              epicId: BOT_ID,
              chatId: BOT.appConversationChatId ?? "",
              hostId: "host-retired",
              messageId: "post-1",
            },
            { effectiveHostId: TAB_HOST, now: 1_000 },
          );
        } else {
          const { payload } = rowFromHostEntry({
            id: "old-agent-stop",
            updatedAt: 10,
            readAt: null,
            kind: "agent.stopped",
            sourceRef: BOT.trunkChatId,
            severity: "done",
            outcome: "completed",
            epicId: BOT_ID,
            chatId: BOT.trunkChatId,
            payload: {
              kind: "chat",
              epicId: BOT_ID,
              chatId: BOT.trunkChatId,
              hostId: "host-retired",
              agentName: "Tracy",
              taskTitle: "Tracy",
              outcome: "completed",
            },
          });
          if (payload === null) throw new Error("the row carried no payload");
          routeNotificationForHost(vi.fn(), payload, 1_000, {
            originHostId: null,
            effectiveHostId: TAB_HOST,
          });
        }

        expect(useTracySurfaceStore.getState()).toMatchObject({
          open: true,
          hostId: TAB_HOST,
        });
        expect(mocks.activateTabIntent).toHaveBeenCalledWith({
          kind: "tracy",
          botId: BOT_ID,
        });
        render(surface());
        expect(
          screen.queryByTestId(
            source === "a search hit" ? "stub-channel" : "stub-session",
          ),
        ).not.toBeNull();
      },
    );
  });

  it("gives the channel the bot's trunk session", () => {
    render(surface());

    expect(
      screen.getByTestId("stub-channel").getAttribute("data-trunk-chat-id"),
    ).toBe("trunk-1");
  });
});

describe("<BotTabSurface /> channel lifetime", () => {
  /**
   * The last bot of a team is deleted: the list no longer carries it and its
   * team has no bot, which is what a team still to be set up looks like. A
   * channel that showed the bot listed is that bot's, so it is forgotten and
   * the default channel is selected - it never shows the setup notice,
   * whatever the host answers about the team's onboarding.
   */
  it.each<readonly [string, () => void]>([
    [
      "the host answers bot.onboarding.read at 1.0",
      () => {
        mocks.state.onboardingVersion = { major: 1, minor: 0 };
      },
    ],
    [
      "the setup read fails",
      () => {
        mocks.reads["env-team"] = "fails";
      },
    ],
  ])(
    "forgets the channel, never showing the setup notice, when bot.list no longer carries the last bot of its team and %s",
    (_name, script) => {
      script();
      const view = render(surface());
      expect(screen.getByTestId("stub-channel")).toBeTruthy();
      expect(isKept(BOT_ID)).toBe(true);

      mocks.state.listedBotIds = [];
      view.rerender(surface());

      expect(isKept(BOT_ID)).toBe(false);
      expect(screen.queryByTestId("bot-tab-error")).toBeNull();
    },
  );

  it("forgets a channel that was never listed, and selects the default, when the list carries another bot of its team", () => {
    mocks.state.listedBotIds = [OTHER_BOT_ID];
    render(surface());

    expect(isKept(BOT_ID)).toBe(false);
    expect(mocks.activateTabIntent).toHaveBeenCalledWith({
      kind: "tracy",
      botId: OTHER_BOT_ID,
    });
  });

  it("keeps the channel while bot.list carries the bot or has not answered", () => {
    mocks.state.listedBotIds = [BOT_ID, OTHER_BOT_ID];
    const view = render(surface());
    expect(isKept(BOT_ID)).toBe(true);

    view.unmount();
    mocks.state.listedBotIds = undefined;
    render(surface());
    expect(isKept(BOT_ID)).toBe(true);
  });

  it("forgets the channel on the stream's deleted frame", () => {
    mocks.state.deleted = true;
    mocks.state.listedBotIds = [BOT_ID, OTHER_BOT_ID];
    render(surface());

    expect(isKept(BOT_ID)).toBe(false);
    expect(mocks.activateTabIntent).toHaveBeenCalledWith({
      kind: "tracy",
      botId: OTHER_BOT_ID,
    });
  });

  it("forgets the channel when the settings panel reports the bot deleted", async () => {
    const user = userEvent.setup();
    mocks.state.listedBotIds = [BOT_ID, OTHER_BOT_ID];
    render(surface());
    await user.click(screen.getByTestId("bot-channel-settings-open"));

    await user.click(screen.getByTestId("stub-settings-deleted"));

    expect(isKept(BOT_ID)).toBe(false);
    expect(mocks.activateTabIntent).toHaveBeenCalledWith({
      kind: "tracy",
      botId: OTHER_BOT_ID,
    });
  });

  it("commits the default channel at once while the surface is out of view, where there is no route to move", () => {
    mocks.state.paneVisible = false;
    mocks.state.listedBotIds = [OTHER_BOT_ID];
    render(surface());

    expect(useTracySurfaceStore.getState().botId).toBe(OTHER_BOT_ID);
    expect(mocks.activateTabIntent).not.toHaveBeenCalled();
  });

  it("keeps the column and the previous channel's state across a switch, opening and subscribing to the new channel", () => {
    mocks.state.listedBotIds = [BOT_ID, OTHER_BOT_ID];
    const view = render(surface());
    const column = screen.getByTestId("stub-sidebar");

    useTracySurfaceStore.getState().selectChannel(OTHER_BOT_ID);
    view.rerender(surfaceFor(OTHER_BOT_ID));

    expect(screen.getByTestId("stub-sidebar")).toBe(column);
    expect(column.getAttribute("data-active-bot-id")).toBe(OTHER_BOT_ID);
    expect(mocks.open).toHaveBeenCalledWith({ botId: OTHER_BOT_ID });
    expect(mocks.subscribed).toContain(OTHER_BOT_ID);
    expect(isKept(BOT_ID)).toBe(true);
  });

  it("forgets an inactive visited channel when the list stops carrying it, leaving the selected one alone", () => {
    mocks.state.listedBotIds = [BOT_ID, OTHER_BOT_ID];
    const view = render(surface());
    useTracySurfaceStore.getState().selectChannel(OTHER_BOT_ID);
    useBotDraftsStore
      .getState()
      .typeThreadBox(OTHER_BOT_ID, "post-1", "unsent", null);
    view.rerender(surfaceFor(OTHER_BOT_ID));
    expect(useTracySurfaceStore.getState().visitedBotIds).toEqual([
      BOT_ID,
      OTHER_BOT_ID,
    ]);

    mocks.state.listedBotIds = [OTHER_BOT_ID];
    view.rerender(surfaceFor(OTHER_BOT_ID));

    expect(isKept(BOT_ID)).toBe(false);
    expect(isKept(OTHER_BOT_ID)).toBe(true);
    expect(mocks.activateTabIntent).not.toHaveBeenCalled();
  });

  it("keeps bot.list current through the change stream on the surface's own host", () => {
    render(surface());

    expect(mocks.useBotListChangedSubscriptionForHost).toHaveBeenLastCalledWith(
      TAB_HOST,
      true,
    );
  });
});

describe("<BotTabSurface /> with no channel selected", () => {
  it("selects the default channel once the lists answer, and shows the column meanwhile", () => {
    mocks.state.listedBotIds = [BOT_ID];
    render(surfaceFor(null));

    expect(
      screen.getByTestId("stub-sidebar").getAttribute("data-active-bot-id"),
    ).toBe("none");
    expect(mocks.activateTabIntent).toHaveBeenCalledWith({
      kind: "tracy",
      botId: BOT_ID,
    });
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it("says there are no bots yet, with the column still drawn, when the team has none", () => {
    mocks.state.listedBotIds = [];
    render(surfaceFor(null));

    expect(screen.getByTestId("bot-tab-no-channel").textContent).toBe(
      "No bots yet. Create one from Home.",
    );
    expect(screen.getByTestId("stub-sidebar")).toBeTruthy();
    expect(mocks.activateTabIntent).not.toHaveBeenCalled();
    expect(mocks.open).not.toHaveBeenCalled();
  });

  describe("level 2 in the installed app", () => {
    let shell: ShellFormHarness;
    beforeEach(() => {
      shell = installShellForm(SHELL_WIDTH_MENU);
    });
    afterEach(() => {
      shell.dispose();
    });

    it("heads the pane with Tracy as the picker, to reach a team still to be set up that the default channel does not see", async () => {
      mocks.state.listedBotIds = [];
      mocks.state.environments = [
        {
          environmentId: "env-new",
          label: "Newco",
          ownerKind: "organization",
          providerHandle: null,
        },
      ];
      mocks.reads["env-new"] = { setup: NEEDS_HOST_SETUP };
      const user = userEvent.setup();
      const view = render(surfaceFor(null));

      expect(screen.queryByTestId("bot-channel-sidebar-pane")).toBeNull();
      expect(screen.getByTestId("bot-tab-no-channel")).toBeTruthy();
      const trigger = screen.getByTestId("bot-channel-picker-trigger");
      expect(screen.getByTestId("bot-tab-title").contains(trigger)).toBe(true);
      expect(trigger.textContent).toBe("Tracy");

      await user.click(trigger);
      const picker = await screen.findByTestId("bot-channel-picker");
      expect(
        within(picker).getByTestId("stub-sidebar").dataset.activeBotId,
      ).toBe("none");
      await user.click(within(picker).getByTestId("stub-sidebar-pick"));
      expect(screen.queryByTestId("bot-channel-picker")).toBeNull();

      // The pick navigates to the setup channel, which the route then shows.
      view.rerender(surfaceFor(SETUP_BOT_ID));
      expect(screen.getByTestId("team-setup-channel")).toBeTruthy();
      expect(screen.queryByTestId("bot-tab-no-channel")).toBeNull();
    });
  });
});

describe("<BotTabSurface /> stream error", () => {
  it("keeps the retained snapshot on screen and puts a retry on top of it", async () => {
    const user = userEvent.setup();
    mocks.state.error = "the stream closed";
    render(surface());

    expect(screen.getByTestId("bot-tab-title").textContent).toBe("Release Bot");
    const alert = screen.getByTestId("bot-tab-error");
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.textContent).toContain("the stream closed");
    expect(screen.getByTestId("stub-channel")).toBeTruthy();

    expect(mocks.resubscribe).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(mocks.resubscribe).toHaveBeenCalledTimes(1);
  });

  it("shows only the error and its retry when no snapshot ever arrived", async () => {
    const user = userEvent.setup();
    mocks.state.snapshot = null;
    mocks.state.error = "the stream closed";
    render(surface());

    expect(screen.getByTestId("bot-tab-error")).toBeTruthy();
    expect(screen.queryByTestId("bot-tab-title")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(mocks.resubscribe).toHaveBeenCalledTimes(1);
  });

  it("shows no error and no connecting state for a healthy stream", () => {
    render(surface());

    expect(screen.queryByTestId("bot-tab-error")).toBeNull();
    expect(screen.queryByTestId("bot-tab-connecting")).toBeNull();
  });

  it("shows the connecting state before the first snapshot", () => {
    mocks.state.snapshot = null;
    render(surface());

    expect(screen.getByTestId("bot-tab-connecting")).toBeTruthy();
  });
});

describe("<BotTabSurface /> header on a short viewport under the keyboard", () => {
  beforeEach(() => {
    setPhoneLayoutOnly(true);
    holdScreenLandscape();
    raiseNativeKeyboard(IPHONE_17);
  });

  afterEach(() => {
    setPhoneLayoutOnly(false);
    restoreKeyboardEnvironment();
  });

  function hiddenAway(element: HTMLElement): boolean {
    return element.closest("[hidden]") !== null;
  }

  it("keeps the name and gives the tabs up while the channel's box has the focus, and restores with the keyboard down", () => {
    render(surface());
    act(() => screen.getByLabelText("Channel box").focus());

    expect(hiddenAway(screen.getByTestId("bot-tab-title"))).toBe(false);
    expect(hiddenAway(screen.getByTestId("bot-tab-view-messages"))).toBe(true);
    expect(hiddenAway(screen.getByTestId("bot-tab-view-activity"))).toBe(true);

    lowerNativeKeyboard();
    expect(hiddenAway(screen.getByTestId("bot-tab-view-messages"))).toBe(false);
  });

  it("keeps the whole header while a thread outside this surface has the focus", () => {
    render(
      <>
        {surface()}
        <section data-bot-thread-panel="">
          <div {...KEYBOARD_FOCUS_OWNER_PROPS}>
            <textarea aria-label="Another pane's thread box" />
          </div>
        </section>
      </>,
    );
    act(() => screen.getByLabelText("Another pane's thread box").focus());

    expect(hiddenAway(screen.getByTestId("bot-tab-title"))).toBe(false);
    expect(hiddenAway(screen.getByTestId("bot-tab-view-messages"))).toBe(false);
  });

  it("gives the whole header up while a thread's box has the focus", () => {
    render(surface());
    act(() => screen.getByLabelText("Thread box").focus());

    expect(hiddenAway(screen.getByTestId("bot-tab-title"))).toBe(true);
    expect(hiddenAway(screen.getByTestId("bot-tab-view-messages"))).toBe(true);
  });
});

describe("<BotTabSurface /> the place store the route reads", () => {
  function placeOfBot(): {
    readonly view: string | undefined;
    readonly threadsShown: boolean;
    readonly session: unknown;
    readonly automaticMoves: number;
  } {
    const place = useTracyPlaceStore.getState();
    return {
      view: place.viewByBotId[BOT_ID],
      threadsShown: place.threadsShown,
      session: place.sessionByBotId[BOT_ID],
      automaticMoves: place.automaticMoves,
    };
  }

  it("records a person's choice of Activity, of Threads and of a session, and counts none of them as an automatic move", async () => {
    const user = userEvent.setup();
    render(surface());

    await user.click(screen.getByTestId("bot-tab-view-activity"));
    expect(placeOfBot()).toEqual({
      view: "activity",
      threadsShown: false,
      session: undefined,
      automaticMoves: 0,
    });

    await user.click(screen.getByTestId("stub-sidebar-threads"));
    expect(placeOfBot()).toMatchObject({
      threadsShown: true,
      automaticMoves: 0,
    });

    await user.click(screen.getByTestId("stub-sidebar-own-channel"));
    await user.click(screen.getByTestId("bot-tab-view-messages"));
    await user.click(screen.getByTestId("stub-channel-open-turn"));
    expect(placeOfBot()).toEqual({
      view: undefined,
      threadsShown: false,
      session: { chatId: "trunk-1", threadId: null },
      automaticMoves: 0,
    });
  });

  it("counts a landing asked of the tab from outside as an automatic move, and the tab moves", () => {
    useBotTabLandingStore.setState({ byBotId: {} });
    useBotTabLandingStore.getState().request(BOT_ID, {
      kind: "chat",
      chatId: BOT.trunkChatId,
      messageId: "turn-1",
      sendPostId: null,
    });
    render(surface());

    expect(screen.getByTestId("stub-session")).toBeTruthy();
    const place = useTracyPlaceStore.getState();
    expect(place.sessionByBotId[BOT_ID]).toEqual({
      chatId: BOT.trunkChatId,
      threadId: null,
    });
    expect(place.automaticMoves).toBeGreaterThan(0);
  });
});

describe("<BotTabSurface /> a bot's deleted frame against the list it was read with", () => {
  const BOT_HREF = `/bot/${BOT_ID}`;
  const OTHER_HREF = `/bot/${OTHER_BOT_ID}`;

  function historyOf(href: string): {
    readonly dead: boolean;
    readonly eligible: boolean;
  } {
    return {
      dead: isHistoryEntryDead(href),
      eligible: isHistoryEntryEligible(href, useEpicCanvasStore.getState()),
    };
  }

  const GONE = { dead: true, eligible: false };
  const ALIVE = { dead: false, eligible: true };

  beforeEach(() => {
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    mocks.state.listedBotIds = [BOT_ID, OTHER_BOT_ID];
  });

  it("keeps the bot gone, through an unrelated re-render, while the list that still carries it is the one it was reported against", () => {
    mocks.state.deleted = true;
    const view = render(surface());

    expect(historyOf(BOT_HREF)).toEqual(GONE);
    expect(historyOf(OTHER_HREF)).toEqual(ALIVE);

    view.rerender(surface());
    view.rerender(surface());

    expect(historyOf(BOT_HREF)).toEqual(GONE);
    expect(historyOf(OTHER_HREF)).toEqual(ALIVE);
  });

  it("takes the bot back once a list that answered later still carries it", () => {
    mocks.state.deleted = true;
    const view = render(surface());
    expect(historyOf(BOT_HREF)).toEqual(GONE);

    mocks.state.deleted = false;
    mocks.state.list = { ...mocks.state.list, dataUpdatedAt: 2_000 };
    view.rerender(surface());

    expect(historyOf(BOT_HREF)).toEqual(ALIVE);
  });

  it("keeps the bot gone when a list that answered later no longer carries it", () => {
    mocks.state.deleted = true;
    const view = render(surface());
    expect(historyOf(BOT_HREF)).toEqual(GONE);

    mocks.state.deleted = false;
    mocks.state.listedBotIds = [OTHER_BOT_ID];
    mocks.state.list = { ...mocks.state.list, dataUpdatedAt: 2_000 };
    view.rerender(surface());

    expect(historyOf(BOT_HREF)).toEqual(GONE);
    expect(historyOf(OTHER_HREF)).toEqual(ALIVE);
  });

  it("does not make a visited bot gone that the list it is read against never carried", () => {
    mocks.state.listedBotIds = [BOT_ID];
    const view = render(surface());
    act(() => useTracySurfaceStore.getState().markVisited(OTHER_BOT_ID));

    view.rerender(surface());

    expect(historyOf(OTHER_HREF)).toEqual(ALIVE);
    expect(historyOf(BOT_HREF)).toEqual(ALIVE);
  });
});

describe("<BotTabSurface /> a bot reported gone is never the default while its report stands", () => {
  const BOT_HREF = `/bot/${BOT_ID}`;
  const REPORTED_AT = 200;

  function answeredAt(time: number): void {
    mocks.state.list = { ...mocks.state.list, dataUpdatedAt: time };
  }

  function chosen(): ReadonlyArray<unknown> {
    return mocks.activateTabIntent.mock.calls.map(([intent]) => intent);
  }

  const CHOSE_BOT = { kind: "tracy", botId: BOT_ID };
  const CHOSE_OTHER = { kind: "tracy", botId: OTHER_BOT_ID };

  /**
   * The model sorts a section by title, so these titles put the bot first: it
   * is the default channel unless something bars it.
   */
  function titleBotFirst(): void {
    mocks.state.listTitles = new Map([
      [BOT_ID, "Alpha"],
      [OTHER_BOT_ID, "Zulu"],
    ]);
  }

  /**
   * The bot is shown deleted by its stream frame against a list that answered
   * at `REPORTED_AT` and carries it first, which is what would make it the
   * default. Returns the view, with the surface now selecting the other bot.
   */
  function reportDeleted(): RenderResult {
    titleBotFirst();
    mocks.state.listedBotIds = [BOT_ID, OTHER_BOT_ID];
    answeredAt(REPORTED_AT);
    mocks.state.deleted = true;
    const view = render(surface());
    expect(useTracySurfaceStore.getState().goneReports).toEqual({
      [BOT_ID]: REPORTED_AT,
    });
    expect(chosen()).toContainEqual(CHOSE_OTHER);
    mocks.activateTabIntent.mockClear();
    mocks.state.deleted = false;
    return view;
  }

  function expectStillGone(): void {
    expect(isHistoryEntryDead(BOT_HREF)).toBe(true);
    expect(
      isHistoryEntryEligible(BOT_HREF, useEpicCanvasStore.getState()),
    ).toBe(false);
    expect(useTracySurfaceStore.getState().goneReports).toEqual({
      [BOT_ID]: REPORTED_AT,
    });
  }

  beforeEach(() => {
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    useTracySurfaceStore.setState({ goneReports: {}, visitedBotIds: [] });
  });

  it("is the default when nothing reports it gone", () => {
    titleBotFirst();
    mocks.state.listedBotIds = [BOT_ID, OTHER_BOT_ID];
    answeredAt(100);

    render(surfaceFor(null));

    expect(chosen()).toContainEqual(CHOSE_BOT);
    expect(chosen()).not.toContainEqual(CHOSE_OTHER);
  });

  it("does not choose it from the list it was reported against, with no channel selected", () => {
    const view = reportDeleted();

    view.rerender(surfaceFor(null));

    expect(chosen()).toContainEqual(CHOSE_OTHER);
    expect(chosen()).not.toContainEqual(CHOSE_BOT);
    expectStillGone();
  });

  it("does not choose it from an older list that still carries it first", () => {
    const view = reportDeleted();

    answeredAt(100);
    view.rerender(surfaceFor(null));

    expect(chosen()).toContainEqual(CHOSE_OTHER);
    expect(chosen()).not.toContainEqual(CHOSE_BOT);
    expectStillGone();
  });

  it("does not choose it from an older list read by a surface mounted after the report", () => {
    const view = reportDeleted();
    view.unmount();

    answeredAt(100);
    render(surfaceFor(null));

    expect(chosen()).toContainEqual(CHOSE_OTHER);
    expect(chosen()).not.toContainEqual(CHOSE_BOT);
    expectStillGone();
  });

  it("chooses it again once a list that answered later carries it, taking the report away", () => {
    const view = reportDeleted();
    view.unmount();
    mocks.state.listedBotIds = [BOT_ID];

    answeredAt(300);
    render(surfaceFor(null));

    expect(useTracySurfaceStore.getState().goneReports).toEqual({});
    expect(chosen()).toContainEqual(CHOSE_BOT);
    expect(
      isHistoryEntryEligible(BOT_HREF, useEpicCanvasStore.getState()),
    ).toBe(true);
  });
});

describe("<BotTabSurface /> a history step never lands on a message again", () => {
  const SESSION = { chatId: "trunk-1", threadId: null } as const;
  const LISTED_THREAD: BotThreadSummary = {
    threadId: "thread-1",
    conversationId: "conversation-app",
    sessionChatId: "session-thread-1",
    anchor: {
      messageId: "post-7",
      requestId: "req-7",
      senderUserId: "user-1",
      sentAt: 1_000,
      resolvedAt: 1_001,
      excerpt: null,
    },
    replyCount: 1,
    lastReplyAt: 2_000,
    openRequestCount: 0,
    costUsd: null,
  };

  function sessionLandOn(): string | undefined {
    return screen.getByTestId("stub-session").dataset.landOn;
  }

  function channelLandOn(): string | null {
    return screen.getByTestId("stub-channel").getAttribute("data-land-on");
  }

  describe("a session opened at a message", () => {
    it("lands where it was opened, and not again when a step back to the channel and forward shows it", async () => {
      const user = userEvent.setup();
      render(surface());
      await user.click(screen.getByTestId("stub-channel-open-turn"));
      expect(sessionLandOn()).toBe("prompt-reply");

      act(() => useTracyPlaceStore.getState().setSession(BOT_ID, null));
      expect(screen.queryByTestId("stub-session")).toBeNull();
      act(() => useTracyPlaceStore.getState().setSession(BOT_ID, SESSION));

      expect(sessionLandOn()).toBe("none");
    });

    it("does not land again when its own Back button closed it and a step forward shows it", async () => {
      const user = userEvent.setup();
      render(surface());
      await user.click(screen.getByTestId("stub-channel-open-turn"));

      await user.click(screen.getByTestId("stub-session-back"));
      act(() => useTracyPlaceStore.getState().setSession(BOT_ID, SESSION));

      expect(sessionLandOn()).toBe("none");
    });

    it("lands again when the same session is opened again, a new visit", async () => {
      const user = userEvent.setup();
      render(surface());
      await user.click(screen.getByTestId("stub-channel-open-turn"));
      await user.click(screen.getByTestId("stub-session-back"));
      act(() => useTracyPlaceStore.getState().setSession(BOT_ID, SESSION));
      expect(sessionLandOn()).toBe("none");
      act(() => useTracyPlaceStore.getState().setSession(BOT_ID, null));

      await user.click(screen.getByTestId("stub-channel-open-turn"));

      expect(sessionLandOn()).toBe("prompt-reply");
    });

    it("keeps its landing through a re-render that moves nothing", async () => {
      const user = userEvent.setup();
      const view = render(surface());
      await user.click(screen.getByTestId("stub-channel-open-turn"));

      view.rerender(surface());
      view.rerender(surface());

      expect(sessionLandOn()).toBe("prompt-reply");
    });
  });

  describe("the channel landed on a post", () => {
    it("lands with the move that asked for it, and not again when Activity and Messages are stepped through", async () => {
      const user = userEvent.setup();
      render(surface());
      await user.click(screen.getByTestId("stub-channel-open-turn"));
      await user.click(screen.getByTestId("stub-session-post"));
      expect(channelLandOn()).toBe("post-1");

      act(() => useTracyPlaceStore.getState().setView(BOT_ID, "activity"));
      expect(screen.queryByTestId("stub-channel")).toBeNull();
      act(() => useTracyPlaceStore.getState().setView(BOT_ID, "messages"));

      expect(channelLandOn()).toBe("none");
    });

    it("keeps its landing through a re-render that moves nothing", async () => {
      const user = userEvent.setup();
      const view = render(surface());
      await user.click(screen.getByTestId("stub-channel-open-turn"));
      await user.click(screen.getByTestId("stub-session-post"));

      view.rerender(surface());

      expect(channelLandOn()).toBe("post-1");
    });

    it("lands on a post of a thread beside the channel, and not again when the thread is closed and reopened by the rail's store", async () => {
      const user = userEvent.setup();
      mocks.state.threads = [LISTED_THREAD];
      render(surface());
      await user.click(screen.getByTestId("stub-channel-open-thread-session"));
      await user.click(screen.getByTestId("stub-session-thread-post"));
      const channel = screen.getByTestId("stub-channel");
      expect(channel.getAttribute("data-open-thread")).toBe("post-7");
      expect(channel.getAttribute("data-land-on")).toBe("thread-reply-9");
      expect(channel.getAttribute("data-land-on-thread")).toBe("thread-1");

      act(() => useBotOpenThreadStore.getState().setRail(BOT_ID, null));
      act(() =>
        useBotOpenThreadStore.getState().setRail(BOT_ID, {
          kind: "thread",
          anchorMessageId: "post-7",
          announcement: false,
          anchorKind: null,
          sent: null,
        }),
      );

      const reopened = screen.getByTestId("stub-channel");
      expect(reopened.getAttribute("data-open-thread")).toBe("post-7");
      expect(reopened.getAttribute("data-land-on")).toBe("none");
      expect(reopened.getAttribute("data-land-on-thread")).toBe("none");
    });
  });
});
