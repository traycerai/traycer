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
  type HostClientChange,
  hostSupportsMethodMock,
  mocks,
  notificationHostMock,
  type ReadScript,
  tabHostClientMock,
  tabHostProviderMock,
  tabNavigationMock,
} from "./bot-tab-surface-mocks";
import { BotMentionsContext } from "@/components/bots/bot-mentions-context";

import {
  useVoiceSessionStore,
  type VoiceSessionDriver,
} from "@/stores/voice/voice-session-store";
import { KEYBOARD_FOCUS_OWNER_PROPS } from "@/hooks/ui/use-keyboard-focus-layout";
import { setPhoneLayoutOnly } from "@/lib/mobile-app";

import {
  installShellForm,
  SHELL_WIDTH_COLUMN_256,
  SHELL_WIDTH_MENU,
  SHELL_WIDTH_TWO_TILES,
  type ShellFormHarness,
} from "../../../../__tests__/mobile-level2-form-harness";
import { StrictMode, useContext, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotOpenPausedReason } from "@traycer/protocol/host/bot/schemas";
import type { BotOnboardingSetup } from "@traycer/protocol/host/bot/onboarding-schemas";

import type { BotTurnRef } from "@traycer/protocol/host/bot/conversation-schemas";
import type { BotChannelLanding } from "@/components/bots/bot-channel-view";
import { botColorAt } from "@/lib/providers/profile-accent-color";
import { readFocusedHostNotificationPresence } from "@/lib/notifications/notification-presence";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { makeOpenableNodeRef } from "@/stores/epics/canvas/types";
import type { BotOpenSession } from "@/components/bots/bot-session-view";
import type {
  BotOpenMemory,
  BotOpenThread,
  BotSessionOpen,
  BotTurnOpen,
} from "@/stores/bots/bot-open-thread-store";
import {
  answer,
  BOT_ID,
  BOUND_HOST,
  endBotTabSurfaceCase,
  NEEDS_HOST_SETUP,
  OTHER_BOT_ID,
  resetBotTabSurfaceMocks,
  setUpNewTeam,
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

import { BotTabSurface } from "@/components/bots/bot-tab-surface";
import { useTracySurfaceStore } from "@/stores/bots/tracy-surface-store";
import { useBotPaneWidthsStore } from "@/stores/bots/bot-pane-widths-store";

import { useBotDraftsStore } from "@/stores/bots/bot-drafts-store";
import {
  useBotOpenThreadStore,
  type BotRail,
} from "@/stores/bots/bot-open-thread-store";
import { useAuthStore } from "@/stores/auth/auth-store";

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

/** The surface outside StrictMode, for a case that counts its mount's opens. */
function unstrictSurface(): ReactNode {
  return (
    <QueryClientProvider client={queryClient}>
      <BotTabSurface botId={BOT_ID} hostId={TAB_HOST} />
    </QueryClientProvider>
  );
}

/** Nothing on a tab says where a bot runs or offers to move it. */
function expectNoMachineWording(container: HTMLElement): void {
  expect(container.textContent).not.toMatch(
    /View on|Move it here|Studio Mac|Laptop|host-bound|host-tab|offline/i,
  );
  expect(screen.queryByTestId("bot-tab-bound-elsewhere")).toBeNull();
  expect(screen.queryByTestId("bot-tab-move-here")).toBeNull();
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

describe("<BotTabSurface /> on a host without bot.open", () => {
  it("asks about bot.open on the tab's own host", () => {
    render(surface());

    expect(mocks.supportQueries).toContainEqual({
      hostId: TAB_HOST,
      method: "bot.open",
    });
    expect(mocks.supportQueries.every((q) => q.hostId === TAB_HOST)).toBe(true);
  });

  it("shows the update notice, without naming a host, and none of the tab's controls", () => {
    mocks.state.support = false;
    render(surface());

    expect(screen.getByTestId("bot-tab-unavailable").textContent).toContain(
      "Bots aren't available on this host yet",
    );
    expect(screen.queryByTestId("stub-channel")).toBeNull();
    expect(screen.queryByTestId("stub-settings")).toBeNull();
    expect(screen.queryByTestId("bot-tab-paused")).toBeNull();
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it("shows the connecting state, never nothing, and opens nothing, until the handshake has answered either way", () => {
    mocks.state.support = null;
    render(surface());

    expect(screen.getByTestId("bot-tab-connecting")).toBeTruthy();
    expect(screen.queryByTestId("stub-channel")).toBeNull();
    expect(mocks.open).not.toHaveBeenCalled();
  });
});

describe("<BotTabSurface /> a team's main bot still to be set up", () => {
  beforeEach(() => {
    setUpNewTeam();
    mocks.reads["env-new"] = {
      setup: NEEDS_HOST_SETUP,
    };
  });

  it("shows the channel where the team is set up, with the bot's post and the ways to get a host, and none of the starter-bot flow", () => {
    render(surfaceFor(SETUP_BOT_ID));

    const channel = screen.getByTestId("team-setup-channel");
    expect(within(channel).getByTestId("bot-tab-title").textContent).toBe(
      "Tracy",
    );
    expect(within(channel).getByTestId("bot-tab-main")).toBeTruthy();
    expect(screen.getByTestId("stub-sidebar").dataset.activeBotId).toBe(
      SETUP_BOT_ID,
    );
    const post = within(channel).getByTestId("team-setup-post");
    expect(within(post).getByText("Tracy")).toBeTruthy();
    const card = within(post).getByTestId("team-host-options");
    expect(
      within(card)
        .getAllByRole("heading")
        .map((heading) => heading.textContent),
    ).toEqual([
      "Give the team a computer",
      "Enable cloud for the team",
      "Add a computer",
    ]);
    expect(within(card).queryAllByRole("link")).toHaveLength(0);
    expect(channel.textContent).not.toMatch(/github|starter|seat/i);
    expect(screen.queryByTestId("stub-channel")).toBeNull();
    expect(screen.queryByTestId("bot-tab-connecting")).toBeNull();
  });

  describe("level 2 in the installed app", () => {
    let shell: ShellFormHarness;
    beforeEach(() => {
      shell = installShellForm(SHELL_WIDTH_MENU);
    });
    afterEach(() => {
      shell.dispose();
    });

    it("offers Threads from the setup channel's title, which replaces the setup until Threads goes back", async () => {
      const user = userEvent.setup();
      render(surfaceFor(SETUP_BOT_ID));

      expect(screen.queryByTestId("bot-channel-sidebar-pane")).toBeNull();
      await user.click(
        within(screen.getByTestId("team-setup-channel")).getByTestId(
          "bot-channel-picker-trigger",
        ),
      );
      await user.click(
        within(await screen.findByTestId("bot-channel-picker")).getByTestId(
          "stub-sidebar-threads",
        ),
      );

      expect(screen.getByTestId("stub-threads")).toBeTruthy();
      expect(screen.queryByTestId("team-setup-channel")).toBeNull();
      expect(screen.queryByTestId("bot-channel-picker")).toBeNull();

      await user.click(screen.getByTestId("stub-threads-back"));

      expect(screen.queryByTestId("stub-threads")).toBeNull();
      expect(screen.getByTestId("team-setup-channel")).toBeTruthy();
    });
  });

  it("draws the message box with nothing to type into or send, and says why", () => {
    render(surfaceFor(SETUP_BOT_ID));

    const composer = screen.getByTestId("team-setup-composer");
    const input = within(composer).getByRole("textbox", {
      name: "Message Tracy",
    });
    expect(input).toHaveProperty("disabled", true);
    expect(
      within(composer).getByRole("button", { name: "Send" }),
    ).toHaveProperty("disabled", true);
    expect(
      within(composer).getByTestId("team-setup-composer-reason").textContent,
    ).toBe("Tracy can reply once the team has a computer.");
  });

  it("opens, subscribes to and closes nothing: the bot does not exist", () => {
    render(surfaceFor(SETUP_BOT_ID));

    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.subscribed).toEqual([]);
    expect(isKept(SETUP_BOT_ID)).toBe(true);
  });

  it("shows the connecting state, opening nothing, until the team's read answers, then the setup channel", () => {
    delete mocks.reads["env-new"];
    const view = render(surfaceFor(SETUP_BOT_ID));

    expect(screen.getByTestId("bot-tab-connecting")).toBeTruthy();
    expect(screen.queryByTestId("team-setup-channel")).toBeNull();
    expect(mocks.open).not.toHaveBeenCalled();
    expect(isKept(SETUP_BOT_ID)).toBe(true);

    mocks.reads["env-new"] = {
      setup: NEEDS_HOST_SETUP,
    };
    view.rerender(surfaceFor(SETUP_BOT_ID));

    expect(screen.getByTestId("team-setup-channel")).toBeTruthy();
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it("shows the setup channel for a team whose machine is joining, as one still to be set up, and opens no bot", () => {
    mocks.reads["env-new"] = {
      setup: {
        ...NEEDS_HOST_SETUP,
        state: "host_joining",
        arrival: { kind: "machine" },
      },
    };
    render(surfaceFor(SETUP_BOT_ID));

    expect(screen.getByTestId("team-setup-channel")).toBeTruthy();
    expect(screen.queryByTestId("stub-channel")).toBeNull();
    expect(mocks.open).not.toHaveBeenCalled();
    expect(isKept(SETUP_BOT_ID)).toBe(true);
  });

  it.each<readonly [string, ReadScript]>([
    ["the read answers no setup", { setup: null }],
    [
      "the setup names another bot",
      { setup: { ...NEEDS_HOST_SETUP, botId: OTHER_BOT_ID } },
    ],
  ])(
    "opens the tab as any unlisted bot's, which closes itself, when every read has answered, the list was read since the tab mounted, and %s",
    (_name, script) => {
      mocks.reads["env-new"] = script;
      render(surfaceFor(SETUP_BOT_ID));

      expect(screen.queryByTestId("team-setup-channel")).toBeNull();
      expect(screen.queryByTestId("bot-tab-error")).toBeNull();
      expect(mocks.listRefetch).not.toHaveBeenCalled();
      expect(mocks.open).toHaveBeenCalledWith({ botId: SETUP_BOT_ID });
      expect(isKept(SETUP_BOT_ID)).toBe(false);
    },
  );

  /**
   * The team's setup read failed, so it cannot be told from a deleted bot.
   * The tab says so, and Retry reads the setup again, and only it.
   */
  it("shows the setup could not be read, never opening, subscribing to or closing the tab, when the setup read fails; Retry reads it again and the setup then shows", async () => {
    mocks.reads["env-new"] = "fails";
    const user = userEvent.setup();
    const view = render(surfaceFor(SETUP_BOT_ID));

    const notice = screen.getByTestId("bot-tab-error");
    expect(notice.textContent).toContain("Couldn't load this channel.");
    expect(screen.queryByTestId("team-setup-channel")).toBeNull();
    expect(screen.queryByTestId("bot-tab-connecting")).toBeNull();
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.subscribed).toEqual([]);
    expect(mocks.readRefetch).not.toHaveBeenCalled();
    expect(isKept(SETUP_BOT_ID)).toBe(true);

    mocks.readRefetch.mockImplementation(() => {
      mocks.reads["env-new"] = {
        setup: NEEDS_HOST_SETUP,
      };
    });
    await user.click(within(notice).getByRole("button", { name: "Retry" }));

    expect(mocks.readRefetch).toHaveBeenCalled();
    expect(mocks.listRefetch).not.toHaveBeenCalled();
    expect(mocks.environmentsRefetch).not.toHaveBeenCalled();
    view.rerender(surfaceFor(SETUP_BOT_ID));

    expect(screen.getByTestId("team-setup-channel")).toBeTruthy();
    expect(screen.queryByTestId("bot-tab-error")).toBeNull();
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.subscribed).toEqual([]);
  });

  /**
   * The host does not answer a team's setup, so the team cannot be told from
   * a deleted bot - not even by the setup it answered before it reconnected,
   * still cached. Nothing failed, so asking again would answer the same: the
   * tab says the channel could not be loaded, with no Retry, and shows the
   * setup once the host's methods answer it.
   */
  it.each<readonly [string, () => void]>([
    [
      "the host lacks bot.onboarding.read",
      () => {
        mocks.state.onboardingSupport = false;
      },
    ],
    [
      "the host answers bot.onboarding.read at 1.0",
      () => {
        mocks.state.onboardingVersion = { major: 1, minor: 0 };
      },
    ],
  ])(
    "shows the channel could not be loaded, without Retry, and never opens, subscribes to or closes the tab, when %s",
    (_name, script) => {
      mocks.state.readsCached = true;
      script();
      const view = render(surfaceFor(SETUP_BOT_ID));

      const notice = screen.getByTestId("bot-tab-error");
      expect(notice.textContent).toContain("Couldn't load this channel.");
      expect(within(notice).queryByRole("button")).toBeNull();
      expect(screen.queryByTestId("team-setup-channel")).toBeNull();
      expect(screen.queryByTestId("bot-tab-connecting")).toBeNull();
      expect(mocks.open).not.toHaveBeenCalled();
      expect(mocks.subscribed).toEqual([]);
      expect(isKept(SETUP_BOT_ID)).toBe(true);

      mocks.state.onboardingSupport = true;
      mocks.state.onboardingVersion = { major: 1, minor: 1 };
      view.rerender(surfaceFor(SETUP_BOT_ID));

      expect(screen.getByTestId("team-setup-channel")).toBeTruthy();
      expect(screen.queryByTestId("bot-tab-error")).toBeNull();
      expect(mocks.open).not.toHaveBeenCalled();
      expect(mocks.subscribed).toEqual([]);
    },
  );

  /**
   * The environment list's refresh failed and TanStack kept a list from
   * before the team, so the team's setup is never read and the bot list,
   * fresh, does not carry the bot. Only a list that was read says a bot is
   * absent: the tab does not open the bot, which would find it gone and
   * close the tab, and reads the environments again only on Retry.
   */
  it("shows the channel could not be loaded, never opening or closing the tab, when the environment list's refresh failed over a list from before the team; Retry reads it again and the setup then shows", async () => {
    mocks.state.environments = [
      {
        environmentId: "env-team",
        label: "Acme",
        ownerKind: "organization",
        providerHandle: null,
      },
    ];
    mocks.state.environmentsStatus = "error";
    mocks.state.environmentsKept = true;
    const user = userEvent.setup();
    const view = render(surfaceFor(SETUP_BOT_ID));

    const notice = screen.getByTestId("bot-tab-error");
    expect(notice.textContent).toContain("Couldn't load this channel.");
    expect(screen.queryByTestId("team-setup-channel")).toBeNull();
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.subscribed).toEqual([]);
    expect(mocks.environmentsRefetch).not.toHaveBeenCalled();
    expect(isKept(SETUP_BOT_ID)).toBe(true);

    mocks.environmentsRefetch.mockImplementation(() => {
      setUpNewTeam();
      mocks.state.environmentsStatus = "success";
    });
    await user.click(within(notice).getByRole("button", { name: "Retry" }));

    expect(mocks.environmentsRefetch).toHaveBeenCalledTimes(1);
    expect(mocks.listRefetch).not.toHaveBeenCalled();
    view.rerender(surfaceFor(SETUP_BOT_ID));

    expect(screen.getByTestId("team-setup-channel")).toBeTruthy();
    expect(mocks.open).not.toHaveBeenCalled();
    expect(isKept(SETUP_BOT_ID)).toBe(true);
  });

  /**
   * A cold first read failed (no data), where the setup tab was restored:
   * neither list can say the bot is absent, so the tab says the channel could
   * not be loaded, opens and subscribes to nothing, keeps the tab and reads
   * only what failed, and only on Retry.
   */
  it.each<readonly [string, () => void, () => void, () => void]>([
    [
      "the first bot.list failed while environment.list succeeded",
      () => {
        mocks.state.listedBotIds = undefined;
        mocks.state.listFailed = true;
      },
      () => expect(mocks.listRefetch).toHaveBeenCalledTimes(1),
      () => expect(mocks.environmentsRefetch).not.toHaveBeenCalled(),
    ],
    [
      "the bot list answered while the first environment.list failed",
      () => {
        mocks.state.listedBotIds = [];
        mocks.state.environmentsStatus = "error";
      },
      () => expect(mocks.environmentsRefetch).toHaveBeenCalledTimes(1),
      () => expect(mocks.listRefetch).not.toHaveBeenCalled(),
    ],
  ])(
    "shows the channel could not be loaded, opening, subscribing to and closing nothing and refetching nothing on its own, when %s; Retry reads only the failed list",
    async (_name, script, expectFailedRefetched, expectOtherNotRefetched) => {
      mocks.reads["env-new"] = {
        setup: NEEDS_HOST_SETUP,
      };
      script();
      const user = userEvent.setup();
      render(surfaceFor(SETUP_BOT_ID));

      const notice = screen.getByTestId("bot-tab-error");
      expect(notice.textContent).toContain("Couldn't load this channel.");
      expect(screen.queryByTestId("team-setup-channel")).toBeNull();
      expect(screen.queryByTestId("bot-tab-connecting")).toBeNull();
      expect(mocks.open).not.toHaveBeenCalled();
      expect(mocks.subscribed).toEqual([]);
      expect(mocks.listRefetch).not.toHaveBeenCalled();
      expect(mocks.environmentsRefetch).not.toHaveBeenCalled();
      expect(isKept(SETUP_BOT_ID)).toBe(true);

      await user.click(within(notice).getByRole("button", { name: "Retry" }));

      expectFailedRefetched();
      expectOtherNotRefetched();
    },
  );

  /**
   * The team's read answers `setup: null` because the bot has been created,
   * but the cached list was read before that. The tab reads the list again
   * before it decides the bot is gone.
   */
  it.each<readonly [string, () => void]>([
    [
      "the list was last read before the setup read answered",
      () => {
        mocks.state.list.dataUpdatedAt = 500;
      },
    ],
    [
      "the list was not fetched since the tab mounted",
      () => {
        mocks.state.list.isFetchedAfterMount = false;
      },
    ],
  ])(
    "reads the list again before closing an unlisted bot whose setup is gone, when %s, and opens the bot once the list carries it",
    (_name, script) => {
      mocks.reads["env-new"] = { setup: null };
      script();
      const view = render(surfaceFor(SETUP_BOT_ID));

      expect(mocks.listRefetch).toHaveBeenCalled();
      expect(screen.getByTestId("bot-tab-connecting")).toBeTruthy();
      expect(mocks.open).not.toHaveBeenCalled();
      expect(isKept(SETUP_BOT_ID)).toBe(true);

      // The re-read answers, now carrying the bot.
      mocks.state.listedBotIds = [BOT_ID, SETUP_BOT_ID];
      mocks.state.list = {
        dataUpdatedAt: 2_000,
        errorUpdatedAt: 0,
        isFetchedAfterMount: true,
        isFetching: false,
      };
      view.rerender(surfaceFor(SETUP_BOT_ID));

      expect(mocks.open).toHaveBeenCalledWith({ botId: SETUP_BOT_ID });
      expect(screen.getByTestId("stub-channel")).toBeTruthy();
      expect(screen.queryByTestId("bot-tab-connecting")).toBeNull();
      expect(isKept(SETUP_BOT_ID)).toBe(true);
    },
  );

  it("draws no setup channel for a bot the read names live before the list carries it: it reads the list again and opens the bot once listed", () => {
    mocks.reads["env-new"] = {
      setup: { ...NEEDS_HOST_SETUP, state: "live", arrival: { kind: "cloud" } },
    };
    mocks.state.list.isFetchedAfterMount = false;
    mocks.listRefetch.mockImplementation(() => {
      mocks.state.listedBotIds = [BOT_ID, SETUP_BOT_ID];
      mocks.state.list = {
        dataUpdatedAt: 2_000,
        errorUpdatedAt: 0,
        isFetchedAfterMount: true,
        isFetching: false,
      };
    });
    const view = render(surfaceFor(SETUP_BOT_ID));

    expect(screen.queryByTestId("team-setup-channel")).toBeNull();
    expect(mocks.listRefetch).toHaveBeenCalled();

    view.rerender(surfaceFor(SETUP_BOT_ID));

    expect(mocks.open).toHaveBeenCalledWith({ botId: SETUP_BOT_ID });
    expect(screen.getByTestId("stub-channel")).toBeTruthy();
  });

  /**
   * The team's read answers `setup: null` (the bot has been created), but the
   * list's required refetch failed and TanStack kept the old data, which lacks
   * the bot. Only a successful read can say a bot is absent, so the tab says
   * the setup could not be read - it does not open the bot, which would find
   * it gone and close the tab - and asks the list again only on Retry.
   */
  it("shows the setup could not be read, never opening or closing the tab nor refetching the list on its own, when the list's refresh failed over old data; Retry reads it again and the bot then opens", async () => {
    mocks.reads["env-new"] = { setup: null };
    mocks.state.listFailed = true;
    mocks.state.list = {
      dataUpdatedAt: 500,
      errorUpdatedAt: 2_000,
      isFetchedAfterMount: true,
      isFetching: false,
    };
    const user = userEvent.setup();
    const view = render(surfaceFor(SETUP_BOT_ID));

    const notice = screen.getByTestId("bot-tab-error");
    expect(notice.textContent).toContain("Couldn't load this channel.");
    expect(screen.queryByTestId("bot-tab-connecting")).toBeNull();
    expect(screen.queryByTestId("team-setup-channel")).toBeNull();
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.subscribed).toEqual([]);
    expect(mocks.listRefetch).not.toHaveBeenCalled();
    expect(isKept(SETUP_BOT_ID)).toBe(true);

    mocks.listRefetch.mockImplementation(() => {
      mocks.state.listedBotIds = [BOT_ID, SETUP_BOT_ID];
      mocks.state.listFailed = false;
      mocks.state.list = {
        dataUpdatedAt: 3_000,
        errorUpdatedAt: 2_000,
        isFetchedAfterMount: true,
        isFetching: false,
      };
    });
    await user.click(within(notice).getByRole("button", { name: "Retry" }));

    expect(mocks.listRefetch).toHaveBeenCalledTimes(1);
    view.rerender(surfaceFor(SETUP_BOT_ID));

    expect(screen.queryByTestId("bot-tab-error")).toBeNull();
    expect(mocks.open).toHaveBeenCalledWith({ botId: SETUP_BOT_ID });
    expect(screen.getByTestId("stub-channel")).toBeTruthy();
    expect(mocks.listRefetch).toHaveBeenCalledTimes(1);
    expect(isKept(SETUP_BOT_ID)).toBe(true);
  });

  it("draws the post in a scroller that starts at the top, with the post at the bottom through its own margin", () => {
    render(surfaceFor(SETUP_BOT_ID));

    // jsdom measures no layout, so the classes that decide it are asserted:
    // `justify-end` would put an overflowing post's top out of reach, while
    // `mt-auto` on the post's slot keeps it at the bottom yet lets the
    // overflow run downward from the top.
    const scroller = screen.getByTestId("team-setup-scroller");
    expect(scroller.classList.contains("overflow-y-auto")).toBe(true);
    expect(scroller.classList.contains("justify-end")).toBe(false);
    const slot = screen.getByTestId("team-setup-post-slot");
    expect(slot.parentElement).toBe(scroller);
    expect(slot.classList.contains("mt-auto")).toBe(true);
    expect(within(slot).getByTestId("team-setup-post")).toBeTruthy();
  });

  it("opens the bot normally once it exists under the setup's id", () => {
    mocks.state.listedBotIds = [BOT_ID, SETUP_BOT_ID];
    render(surfaceFor(SETUP_BOT_ID));

    expect(screen.queryByTestId("team-setup-channel")).toBeNull();
    expect(mocks.open).toHaveBeenCalledWith({ botId: SETUP_BOT_ID });
    expect(screen.getByTestId("stub-channel")).toBeTruthy();
  });
});

describe("<BotTabSurface /> before the lists answer", () => {
  it("opens nothing and shows no channel until bot.list names the bot's team", () => {
    mocks.state.listedBotIds = undefined;
    render(surface());

    expect(mocks.open).not.toHaveBeenCalled();
    expect(screen.queryByTestId("stub-channel")).toBeNull();
    expect(screen.getByTestId("bot-tab-connecting")).toBeTruthy();
  });
});

describe("<BotTabSurface /> bot.open", () => {
  afterEach(() => {
    useBotPaneWidthsStore.getState().resetWidth("sidebar");
  });

  it("opens the bot once on mount, for this bot", () => {
    render(unstrictSurface());

    expect(mocks.open).toHaveBeenCalledTimes(1);
    expect(mocks.open).toHaveBeenCalledWith({ botId: BOT_ID });
  });

  it("shows the connecting state until bot.open answers", () => {
    mocks.state.openResult = null;
    render(surface());

    expect(screen.getByTestId("bot-tab-connecting")).toBeTruthy();
    expect(screen.queryByTestId("stub-channel")).toBeNull();
    expect(screen.queryByTestId("bot-tab-paused")).toBeNull();
  });

  it("draws the channel sidebar in a pane as wide as the person set it, with a handle on its channel edge", () => {
    useBotPaneWidthsStore.getState().setWidthPx("sidebar", 300);
    render(surface());

    const pane = screen.getByTestId("bot-channel-sidebar-pane");
    expect(pane.style.getPropertyValue("--bot-pane-width")).toBe("300px");
    expect(within(pane).getByTestId("stub-sidebar")).toBeTruthy();
    expect(
      within(pane)
        .getByTestId("bot-channel-sidebar-pane-resize-handle")
        .getAttribute("aria-label"),
    ).toBe("Resize channels");
  });

  describe("level 2 in the installed app", () => {
    let shell: ShellFormHarness;
    beforeEach(() => {
      shell = installShellForm(SHELL_WIDTH_COLUMN_256);
    });
    afterEach(() => {
      shell.dispose();
    });

    it("draws the bots as the 256 column the resolver answers, with no handle and no container gate", () => {
      render(surface());

      const pane = screen.getByTestId("bot-channel-sidebar-pane");
      expect(pane.style.width).toBe("256px");
      expect(
        screen.queryByTestId("bot-channel-sidebar-pane-resize-handle"),
      ).toBeNull();
      expect(pane.className).not.toContain("@3xl");
      expect(within(pane).getByTestId("stub-sidebar")).toBeTruthy();
      expect(screen.queryByTestId("bot-channel-picker-trigger")).toBeNull();
    });

    it.each([
      ["menu", { width: SHELL_WIDTH_MENU, portrait: false }],
      ["bar", { width: SHELL_WIDTH_COLUMN_256, portrait: true }],
    ])(
      "draws no sidebar at %s, and the bot's name opens the bots list, which a pick or Threads closes",
      async (_form, shape) => {
        shell.set(shape);
        const user = userEvent.setup();
        render(surface());

        expect(screen.queryByTestId("bot-channel-sidebar-pane")).toBeNull();
        const trigger = screen.getByTestId("bot-channel-picker-trigger");
        expect(screen.getByTestId("bot-tab-title").contains(trigger)).toBe(
          true,
        );
        expect(trigger.textContent).toContain("Release Bot");

        await user.click(trigger);
        const picker = await screen.findByTestId("bot-channel-picker");
        expect(
          within(picker).getByTestId("stub-sidebar").dataset.activeBotId,
        ).toBe(BOT_ID);
        await user.click(within(picker).getByTestId("stub-sidebar-pick"));
        expect(screen.queryByTestId("bot-channel-picker")).toBeNull();

        await user.click(trigger);
        await user.click(
          within(await screen.findByTestId("bot-channel-picker")).getByTestId(
            "stub-sidebar-threads",
          ),
        );
        expect(screen.queryByTestId("bot-channel-picker")).toBeNull();
      },
    );

    it("draws the bots column at 256 and the channel as one tile while no thread is open at a two-tile width", () => {
      shell.set({ width: SHELL_WIDTH_TWO_TILES, portrait: false });
      render(surface());

      expect(screen.getByTestId("bot-channel-sidebar-pane").style.width).toBe(
        "256px",
      );
      expect(screen.queryByTestId("bot-channel-picker-trigger")).toBeNull();
      expect(screen.getByTestId("stub-channel").dataset.tiles).toBe("1");
    });

    it("folds the bots column to the picker and tells the channel two tiles show once a thread is open at a two-tile width", () => {
      shell.set({ width: SHELL_WIDTH_TWO_TILES, portrait: false });
      useBotOpenThreadStore.getState().setRail(BOT_ID, {
        kind: "thread",
        anchorMessageId: "post-7",
        announcement: false,
        anchorKind: null,
        sent: null,
      });
      render(surface());

      expect(screen.queryByTestId("bot-channel-sidebar-pane")).toBeNull();
      expect(screen.getByTestId("bot-channel-picker-trigger")).toBeTruthy();
      expect(screen.getByTestId("stub-channel").dataset.tiles).toBe("2");
    });

    describe("the tile count the shell resolves as the rail comes and goes", () => {
      const OPEN_THREAD: BotRail = {
        kind: "thread",
        anchorMessageId: "post-7",
        announcement: false,
        anchorKind: null,
        sent: null,
      };

      // One tile draws the bots column at this width and two fold it to the
      // picker, so the column is what tells the shell's count apart.
      function columnDrawn(): boolean {
        return screen.queryByTestId("bot-channel-sidebar-pane") !== null;
      }

      beforeEach(() => {
        shell.set({ width: SHELL_WIDTH_TWO_TILES, portrait: false });
        useBotOpenThreadStore.getState().setRail(BOT_ID, OPEN_THREAD);
      });

      it("returns to one tile when the thread closes", () => {
        render(surface());
        expect(columnDrawn()).toBe(false);

        act(() => useBotOpenThreadStore.getState().setRail(BOT_ID, null));

        expect(columnDrawn()).toBe(true);
        expect(screen.getByTestId("stub-channel").dataset.tiles).toBe("1");
      });

      it("returns to one tile when the channel switches in place to one with nothing open", () => {
        const view = render(surface());
        expect(columnDrawn()).toBe(false);

        view.rerender(surfaceFor(OTHER_BOT_ID));

        expect(columnDrawn()).toBe(true);
        expect(screen.getByTestId("stub-channel").dataset.tiles).toBe("1");
      });

      it("returns to one tile on Activity, where no rail is drawn", async () => {
        const user = userEvent.setup();
        render(surface());
        expect(columnDrawn()).toBe(false);

        await user.click(screen.getByTestId("bot-tab-view-activity"));

        expect(columnDrawn()).toBe(true);
      });

      it("returns to one tile when Threads is shown from the column", async () => {
        const user = userEvent.setup();
        render(surface());
        await user.click(screen.getByTestId("bot-channel-picker-trigger"));
        const picker = await screen.findByTestId("bot-channel-picker");

        await user.click(within(picker).getByTestId("stub-sidebar-threads"));

        expect(screen.getByTestId("stub-threads")).toBeTruthy();
        expect(columnDrawn()).toBe(true);
      });
    });

    it("keeps the resizable pane and the plain title off the installed app", () => {
      setPhoneLayoutOnly(false);
      render(surface());

      const pane = screen.getByTestId("bot-channel-sidebar-pane");
      expect(
        within(pane).getByTestId("bot-channel-sidebar-pane-resize-handle"),
      ).toBeTruthy();
      const title = screen.getByTestId("bot-tab-title");
      expect(title.textContent).toBe("Release Bot");
      expect(screen.queryByTestId("bot-channel-picker-trigger")).toBeNull();
    });
  });

  it("lays the channel column and the conversation on the task page's grounds: the column on the page, the conversation on the canvas, the canvas hairline between them", () => {
    render(surface());

    const pane = screen.getByTestId("bot-channel-sidebar-pane");
    expect(pane.classList.contains("border-canvas-border/70")).toBe(true);
    expect(pane.classList.contains("md:bg-canvas")).toBe(false);
    const content = screen.getByTestId("bot-tab-content-pane");
    expect(content.classList.contains("md:bg-canvas")).toBe(true);
    expect(within(content).getByTestId("bot-tab-title")).toBeTruthy();
    expect(within(content).getByTestId("stub-channel")).toBeTruthy();
  });

  it("shows the full tab, with no banner, when this host serves the bot", () => {
    const { container } = render(surface());

    expect(screen.getByTestId("bot-tab-title").textContent).toBe("Release Bot");
    expect(screen.getByTestId("stub-channel")).toBeTruthy();
    expect(screen.queryByTestId("bot-tab-paused")).toBeNull();
    expect(screen.queryByTestId("bot-tab-error")).toBeNull();
    expect(screen.queryByTestId("bot-tab-connecting")).toBeNull();
    expectNoMachineWording(container);
  });

  it("is also the full tab when this host claimed the bot", () => {
    mocks.state.openResult = answer({
      kind: "serve-here",
      claimed: "bound-host-unreachable",
    });
    render(surface());

    expect(screen.getByTestId("stub-channel")).toBeTruthy();
    expect(screen.queryByTestId("bot-tab-paused")).toBeNull();
  });

  it("names no machine anywhere on the tab", () => {
    const { container } = render(surface());

    expectNoMachineWording(container);
  });
});

/** The team's main bot, live: the onboarding read names it with how its host came. */
const LIVE_SETUP: BotOnboardingSetup = {
  botId: BOT_ID,
  title: "Release Bot",
  state: "live",
  arrival: { kind: "cloud" },
};

describe("<BotTabSurface /> a team's main bot once it is live", () => {
  beforeEach(() => {
    mocks.state.mainBotIds = { "env-team": BOT_ID };
    mocks.reads["env-team"] = { setup: LIVE_SETUP };
  });

  it("opens the bot's own channel, with the setup post kept at its top and a line saying how the team's host came", () => {
    render(surface());

    expect(mocks.open).toHaveBeenCalledWith({ botId: BOT_ID });
    expect(screen.queryByTestId("team-setup-channel")).toBeNull();
    const channel = screen.getByTestId("stub-channel");
    // The setup post is kept whole, with its buttons retired.
    const post = within(channel).getByTestId("team-setup-history-post");
    expect(within(post).getByText("Release Bot")).toBeTruthy();
    expect(post.textContent).toContain("I'm this team's main bot.");
    expect(post.textContent).toContain(
      "Before I can run, the team needs a computer for its bots.",
    );
    expect(
      within(within(post).getByTestId("team-host-options"))
        .getAllByRole("heading")
        .map((heading) => heading.textContent),
    ).toEqual([
      "Give the team a computer",
      "Enable cloud for the team",
      "Add a computer",
    ]);
    expect(within(post).queryAllByRole("button")).toEqual([]);
    expect(post.textContent).not.toContain("Not available yet.");
    expect(within(channel).getByTestId("team-setup-arrival").textContent).toBe(
      "Cloud enabled for Acme · bots run on sandboxes",
    );
  });

  it("says the team's machine joined, with the machine option kept as history: no button and no token", () => {
    mocks.reads["env-team"] = {
      setup: { ...LIVE_SETUP, arrival: { kind: "machine" } },
    };
    render(surface());

    const channel = screen.getByTestId("stub-channel");
    expect(within(channel).getByTestId("team-setup-arrival").textContent).toBe(
      "Acme's computer joined · bots run on it",
    );
    const option = within(channel).getByTestId("team-host-option-machine");
    expect(within(option).queryAllByRole("button")).toEqual([]);
    expect(
      within(option).queryByTestId("team-host-option-machine-command"),
    ).toBeNull();
  });

  it.each<readonly [string, () => void]>([
    [
      "the bot is not its team's main bot",
      () => {
        mocks.state.mainBotIds = { "env-team": OTHER_BOT_ID };
      },
    ],
    [
      "the read names the team's main bot still to be set up",
      () => {
        // With an arrival, so the state alone decides.
        mocks.reads["env-team"] = {
          setup: { ...LIVE_SETUP, state: "needs_host" },
        };
      },
    ],
    [
      "the team's bots pre-date onboarding",
      () => {
        mocks.reads["env-team"] = { setup: null };
      },
    ],
    [
      "the read failed",
      () => {
        mocks.reads["env-team"] = "fails";
      },
    ],
  ])("shows the channel with no setup history when %s", (_name, script) => {
    script();
    render(surface());

    const channel = screen.getByTestId("stub-channel");
    expect(within(channel).queryByTestId("team-setup-history-post")).toBeNull();
    expect(within(channel).queryByTestId("team-setup-arrival")).toBeNull();
  });
});

describe("<BotTabSurface /> another host serves the bot", () => {
  it.each(["reachable", "claimed-concurrently"] as const)(
    "keeps the tab on its own host and renders the channel there (%s)",
    (why) => {
      mocks.state.openResult = answer({
        kind: "serve-on-bound-host",
        hostId: BOUND_HOST,
        why,
      });
      const { container } = render(surface());

      expect(useTracySurfaceStore.getState().hostId).toBe(TAB_HOST);
      expect(
        screen.getByTestId("stub-channel").getAttribute("data-host-id"),
      ).toBe(TAB_HOST);
      expect(screen.queryByTestId("bot-tab-paused")).toBeNull();
      expect(screen.queryByTestId("bot-tab-connecting")).toBeNull();
      expectNoMachineWording(container);
    },
  );

  it("keeps the tab on its host while the directory has not answered", () => {
    mocks.state.openResult = answer({
      kind: "serve-on-bound-host",
      hostId: BOUND_HOST,
      why: "reachable",
    });
    mocks.state.connectable = { hostIds: [], resolved: false };
    render(surface());

    expect(useTracySurfaceStore.getState().hostId).toBe(TAB_HOST);
    expect(screen.getByTestId("stub-channel")).toBeTruthy();
  });
});

describe("<BotTabSurface /> paused", () => {
  const PAUSED_COPY: ReadonlyArray<{
    reason: BotOpenPausedReason;
    text: string;
    retry: boolean;
  }> = [
    {
      reason: "host-not-in-environment",
      text: "Paused: the host this bot runs on is away, and this one doesn't run Acme's bots. Messages you send are delivered when it's back.",
      retry: false,
    },
    {
      reason: "bound-to-sandbox",
      text: "Couldn't check whether this bot is running. Messages you send still reach it.",
      retry: false,
    },
    {
      reason: "bound-host-not-observable",
      text: "Couldn't check whether this bot is running. Messages you send still reach it.",
      retry: false,
    },
    {
      reason: "reachability-unknown",
      text: "Couldn't check whether this bot is running.",
      retry: true,
    },
    {
      reason: "trunk-busy",
      text: "Finishing an earlier turn here. Try again in a moment.",
      retry: true,
    },
  ];

  it.each(PAUSED_COPY)(
    "says $reason in its own words, names no machine, and offers Retry: $retry",
    ({ reason, text, retry }) => {
      mocks.state.openResult = answer({ kind: "paused", reason });
      const { container } = render(surface());

      const banner = screen.getByTestId("bot-tab-paused");
      expect(banner.getAttribute("data-reason")).toBe(reason);
      expect(banner.getAttribute("role")).toBe("status");
      expect(banner.textContent).toContain(text);
      expect(within(banner).queryAllByRole("button")).toHaveLength(
        retry ? 1 : 0,
      );
      expectNoMachineWording(container);
    },
  );

  it("still renders the channel under the paused banner", () => {
    mocks.state.openResult = answer({
      kind: "paused",
      reason: "host-not-in-environment",
    });
    render(surface());

    expect(screen.getByTestId("bot-tab-paused")).toBeTruthy();
    expect(
      screen.getByTestId("stub-channel").getAttribute("data-host-id"),
    ).toBe(TAB_HOST);
  });

  it("hands the channel view the tab's host for its reads and sends, and the bot's bound host for signing a provider in again", () => {
    render(surface());

    const channel = screen.getByTestId("stub-channel");
    expect(channel.getAttribute("data-host-id")).toBe(TAB_HOST);
    expect(channel.getAttribute("data-bound-host-id")).toBe(BOUND_HOST);
  });

  it("hands the channel view the conversation the bot record names as its channel", () => {
    render(surface());

    expect(
      screen
        .getByTestId("stub-channel")
        .getAttribute("data-app-conversation-chat-id"),
    ).toBe("conversation-app");
  });

  it("names the channel's members from the bot's environment when the tab's host lists them", () => {
    render(surface());

    expect(mocks.supportQueries).toContainEqual({
      hostId: TAB_HOST,
      method: "environment.members",
    });
    expect(mocks.membersQueries).toContainEqual({
      environmentId: "env-team",
      enabled: true,
    });
    expect(
      screen.getByTestId("stub-channel").getAttribute("data-teammate-name"),
    ).toBe("Tess Teammate");
  });

  it("leaves the members unresolved on a host without environment.members", () => {
    mocks.state.membersSupport = false;
    render(surface());

    expect(mocks.membersQueries.every((q) => !q.enabled)).toBe(true);
    expect(
      screen.getByTestId("stub-channel").getAttribute("data-teammate-name"),
    ).toBe("unresolved");
  });

  it("hands the Activity page whether this host runs the bot, paused or not", async () => {
    const user = userEvent.setup();
    mocks.state.openResult = answer({
      kind: "paused",
      reason: "bound-to-sandbox",
    });
    render(surface());

    await user.click(screen.getByTestId("bot-tab-view-activity"));
    const page = screen.getByTestId("stub-activity");
    expect(page.getAttribute("data-is-this-host")).toBe("false");
  });

  it("keeps the channel settings ungated: a paused channel still opens the settings panel", async () => {
    const user = userEvent.setup();
    mocks.state.openResult = answer({
      kind: "paused",
      reason: "bound-host-not-observable",
    });
    render(surface());

    await user.click(screen.getByTestId("bot-channel-settings-open"));
    expect(screen.getByTestId("stub-settings")).toBeDefined();
  });

  it.each<readonly [string, "user" | "organization", string]>([
    ["a person's own", "user", "true"],
    ["a team's", "organization", "false"],
  ])(
    "tells the settings panel whether the bot's environment is personal: %s",
    async (_name, ownerKind, expected) => {
      const user = userEvent.setup();
      mocks.state.environments = [
        {
          environmentId: "env-team",
          label: "Acme",
          ownerKind,
          providerHandle: null,
        },
      ];
      render(surface());

      await user.click(screen.getByTestId("bot-channel-settings-open"));
      expect(
        screen.getByTestId("stub-settings").getAttribute("data-personal"),
      ).toBe(expected);
    },
  );

  it("opens the channel's settings beside the channel from the ⋮, for the bot's channel, and closes them back to the ⋮, from their close or the ⋮ again", async () => {
    const user = userEvent.setup();
    render(surface());

    const open = screen.getByTestId("bot-channel-settings-open");
    expect(open.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("stub-settings")).toBeNull();

    await user.click(open);
    const panel = screen.getByTestId("stub-settings");
    expect(open.getAttribute("aria-expanded")).toBe("true");
    expect(panel.getAttribute("data-channel-id")).toBe("conversation-app");
    // The channel stays: the panel sits beside it, not instead of it.
    expect(screen.getByTestId("stub-channel")).toBeTruthy();

    await user.click(within(panel).getByTestId("stub-settings-close"));
    expect(screen.queryByTestId("stub-settings")).toBeNull();
    expect(document.activeElement).toBe(open);

    // The ⋮ closes them too.
    await user.click(open);
    expect(screen.getByTestId("stub-settings")).toBeTruthy();
    await user.click(open);
    expect(screen.queryByTestId("stub-settings")).toBeNull();
    expect(open.getAttribute("aria-expanded")).toBe("false");
  });

  it.each([
    ["a team's", "organization", "Acme", "Members of Acme"],
    ["a person's own", "user", "Olive Owner", "Only you"],
  ] as const)(
    "opens the bot's card from the header for %s bot, naming its owner and who may message it",
    async (_name, ownerKind, owner, access) => {
      const user = userEvent.setup();
      useAuthStore.setState({
        profile: {
          userId: "user-viewer",
          userName: "Olive Owner",
          email: "olive@example.com",
          avatarUrl: null,
        },
      });
      mocks.state.environments = [
        {
          environmentId: "env-team",
          label: "Acme",
          ownerKind,
          providerHandle: null,
        },
      ];
      render(surface());

      await user.click(screen.getByTestId("bot-tab-avatar"));
      const card = await screen.findByTestId("bot-profile-card");
      expect(card.textContent).toContain(`Managed by ${owner}`);
      expect(within(card).getByTestId("bot-profile-access").textContent).toBe(
        access,
      );
    },
  );

  it("treats the environment as not personal until the environment list names it", async () => {
    const user = userEvent.setup();
    mocks.state.environments = [
      {
        environmentId: "env-other",
        label: "Mine",
        ownerKind: "user",
        providerHandle: null,
      },
    ];
    render(surface());

    await user.click(screen.getByTestId("bot-channel-settings-open"));
    expect(
      screen.getByTestId("stub-settings").getAttribute("data-personal"),
    ).toBe("false");
  });

  it("asks again on Retry and drops the banner when the answer changes", async () => {
    const user = userEvent.setup();
    mocks.state.openResult = answer({
      kind: "paused",
      reason: "reachability-unknown",
    });
    render(unstrictSurface());
    expect(mocks.open).toHaveBeenCalledTimes(1);

    mocks.state.openResult = answer({ kind: "serve-here", claimed: null });
    await user.click(screen.getByRole("button", { name: "Retry" }));

    expect(mocks.open).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("bot-tab-paused")).toBeNull();
    expect(screen.getByTestId("stub-channel")).toBeTruthy();
  });
});

describe("<BotTabSurface /> bot.open fails", () => {
  it("shows the error with a Retry, and no tab, when there is no earlier answer", async () => {
    const user = userEvent.setup();
    mocks.state.openResult = { kind: "error", message: "the host is busy" };
    render(unstrictSurface());

    const alert = screen.getByTestId("bot-tab-error");
    expect(alert.textContent).toContain(
      "Couldn't open this bot: the host is busy",
    );
    expect(screen.queryByTestId("bot-tab-title")).toBeNull();
    expect(screen.queryByTestId("stub-channel")).toBeNull();

    mocks.state.openResult = answer({ kind: "serve-here", claimed: null });
    await user.click(within(alert).getByRole("button", { name: "Retry" }));

    expect(mocks.open).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("bot-tab-error")).toBeNull();
    expect(screen.getByTestId("stub-channel")).toBeTruthy();
  });

  it("keeps the tab and shows the error above it when a re-open fails after an answer", async () => {
    const user = userEvent.setup();
    const view = render(surface());
    expect(screen.getByTestId("stub-channel")).toBeTruthy();

    mocks.state.openResult = { kind: "error", message: "network down" };
    mocks.state.paneVisible = false;
    view.rerender(surface());
    mocks.state.paneVisible = true;
    view.rerender(surface());

    const alert = screen.getByTestId("bot-tab-error");
    expect(alert.textContent).toContain("Couldn't open this bot: network down");
    expect(screen.getByTestId("stub-channel")).toBeTruthy();
    expect(screen.getByTestId("bot-tab-title")).toBeTruthy();

    mocks.state.openResult = answer({ kind: "serve-here", claimed: null });
    const callsBefore = mocks.open.mock.calls.length;
    await user.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(mocks.open.mock.calls.length).toBe(callsBefore + 1);
    expect(screen.queryByTestId("bot-tab-error")).toBeNull();
  });
});

describe("<BotTabSurface /> host availability returns", () => {
  const emitHostChange = (event: HostClientChange): void => {
    act(() => {
      for (const listener of mocks.changeListeners) listener(event);
    });
  };

  it("opens again and clears the error when this host recovers after a failed open", () => {
    mocks.state.openResult = { kind: "error", message: "network down" };
    render(surface());
    expect(screen.getByTestId("bot-tab-error")).toBeTruthy();
    const callsBefore = mocks.open.mock.calls.length;

    mocks.state.openResult = answer({ kind: "serve-here", claimed: null });
    emitHostChange({
      reason: "availability-recovered",
      currentHostId: TAB_HOST,
    });

    expect(mocks.open.mock.calls.length).toBe(callsBefore + 1);
    expect(screen.queryByTestId("bot-tab-error")).toBeNull();
  });

  it("does not open again when the last open succeeded", () => {
    render(surface());
    const callsBefore = mocks.open.mock.calls.length;

    emitHostChange({
      reason: "availability-recovered",
      currentHostId: TAB_HOST,
    });

    expect(mocks.open.mock.calls.length).toBe(callsBefore);
  });

  it("does not open again for another host's recovery", () => {
    mocks.state.openResult = { kind: "error", message: "network down" };
    render(surface());
    const callsBefore = mocks.open.mock.calls.length;

    emitHostChange({
      reason: "availability-recovered",
      currentHostId: BOUND_HOST,
    });

    expect(mocks.open.mock.calls.length).toBe(callsBefore);
    expect(screen.getByTestId("bot-tab-error")).toBeTruthy();
  });
});

describe("<BotTabSurface /> re-subscribe on return", () => {
  it("asks for the stream again when the pane goes from hidden to visible, and only then", () => {
    const view = render(surface());
    expect(mocks.resubscribe).not.toHaveBeenCalled();

    mocks.state.paneVisible = false;
    view.rerender(surface());
    expect(mocks.resubscribe).not.toHaveBeenCalled();

    mocks.state.paneVisible = true;
    view.rerender(surface());
    expect(mocks.resubscribe).toHaveBeenCalledTimes(1);

    view.rerender(surface());
    expect(mocks.resubscribe).toHaveBeenCalledTimes(1);
  });

  it("opens the bot again when the pane comes back, since its host may have come or gone", () => {
    const view = render(surface());
    const callsAfterMount = mocks.open.mock.calls.length;

    mocks.state.paneVisible = false;
    view.rerender(surface());
    expect(mocks.open.mock.calls.length).toBe(callsAfterMount);

    mocks.state.paneVisible = true;
    view.rerender(surface());
    expect(mocks.open.mock.calls.length).toBe(callsAfterMount + 1);
  });

  it("opens the bot again when the window returns to view while this tab is the one showing", () => {
    render(surface());
    const callsAfterMount = mocks.open.mock.calls.length;

    document.dispatchEvent(new Event("visibilitychange"));

    expect(mocks.open.mock.calls.length).toBe(callsAfterMount + 1);
    expect(mocks.resubscribe).toHaveBeenCalledTimes(1);
  });

  it("leaves a hidden tab alone when the window returns, since an open can claim the bot onto this host", () => {
    mocks.state.paneVisible = false;
    render(surface());
    const callsAfterMount = mocks.open.mock.calls.length;

    document.dispatchEvent(new Event("visibilitychange"));

    expect(mocks.open.mock.calls.length).toBe(callsAfterMount);
    expect(mocks.resubscribe).not.toHaveBeenCalled();
  });
});

describe("<BotTabSurface /> main bot", () => {
  it("draws the header as the bot's picture, the channel's name with the main bot's star, its two views and the settings ⋮ only", () => {
    mocks.state.listedBotIds = [BOT_ID, OTHER_BOT_ID];
    mocks.state.mainBotIds = { "env-team": BOT_ID };
    render(surface());

    const header = screen.getByTestId("bot-tab-title").closest("header");
    if (header === null) throw new Error("expected the channel header");
    expect(
      within(header)
        .getAllByRole("tab")
        .map((tab) => tab.textContent),
    ).toEqual(["Messages", "Activity"]);
    expect(header.textContent).toBe(
      `${screen.getByTestId("bot-tab-avatar").textContent}${screen.getByTestId("bot-tab-title").textContent}MessagesActivity`,
    );
    expect(
      within(header).getByRole("button", { name: "Channel settings" }),
    ).toBe(screen.getByTestId("bot-channel-settings-open"));
    expect(screen.queryByTestId("bot-channel-mark-read")).toBeNull();
    expect(screen.getByTestId("bot-tab-title").nextElementSibling).toBe(
      within(header).getByRole("img", { name: "Main bot" }).parentElement,
    );
  });

  it.each([
    ["is not main", { "env-team": OTHER_BOT_ID }],
    ["is not known", null],
  ])("draws no star in the header when the bot %s", (_name, mainBotIds) => {
    mocks.state.listedBotIds = [BOT_ID, OTHER_BOT_ID];
    mocks.state.mainBotIds = mainBotIds;
    render(surface());

    const header = screen.getByTestId("bot-tab-title").closest("header");
    if (header === null) throw new Error("expected the channel header");
    expect(within(header).queryByRole("img", { name: "Main bot" })).toBeNull();
  });
});

describe("<BotTabSurface /> Call", () => {
  afterEach(() => {
    useVoiceSessionStore.setState(useVoiceSessionStore.getInitialState(), true);
  });

  it("is not in the channel's header, where it was, even when voice is offered: the message box has it", () => {
    useVoiceSessionStore.setState({
      availability: "live",
      driver: {
        start: vi.fn<VoiceSessionDriver["start"]>(),
        end: vi.fn<VoiceSessionDriver["end"]>(),
        setMuted: vi.fn<VoiceSessionDriver["setMuted"]>(),
      },
    });
    render(surface());

    const header = screen.getByTestId("bot-tab-title").closest("header");
    if (header === null) throw new Error("expected the channel header");
    expect(within(header).queryByRole("button", { name: /^Call/ })).toBeNull();
  });
});

describe("<BotTabSurface /> focused notification presence", () => {
  afterEach(() => {
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    vi.restoreAllMocks();
  });

  it("stands for no entity while in front of a retained task chat, and leaves the chat focused once closed", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const tabId = useEpicCanvasStore
      .getState()
      .openEpicTab("epic-behind", "Epic");
    useEpicCanvasStore.getState().openTileInTab(
      tabId,
      makeOpenableNodeRef({
        id: "chat-behind",
        instanceId: "chat-behind-instance",
        type: "chat",
        name: "Chat",
        hostId: TAB_HOST,
      }),
    );

    const view = render(surface());
    expect(readFocusedHostNotificationPresence()).toBeNull();

    view.unmount();
    expect(readFocusedHostNotificationPresence()?.entity).toEqual({
      epicId: "epic-behind",
      chatId: "chat-behind",
    });
  });
});
describe("<BotTabSurface /> channel background", () => {
  const TINT_CLASS = "bg-(--channel-tint)/10";

  function header(): HTMLElement {
    return screen.getByTestId("bot-channel-header");
  }

  function chooseBackground(background: number | null): void {
    mocks.state.listAppearance = new Map([
      [BOT_ID, { mark: null, color: null, background }],
    ]);
  }

  afterEach(() => {
    document.documentElement.classList.remove("dark");
  });

  it.each([false, true])(
    "tints the header with the chosen colour at one low opacity (dark: %s)",
    (dark) => {
      document.documentElement.classList.toggle("dark", dark);
      chooseBackground(7);
      render(surface());

      expect(header().classList.contains(TINT_CLASS)).toBe(true);
      expect(header().getAttribute("data-channel-background")).toBe("7");
      expect(header().style.getPropertyValue("--channel-tint")).toBe(
        botColorAt(7),
      );
    },
  );

  it("tints neither the bot column nor the composer nor the thread panel", () => {
    chooseBackground(7);
    render(surface());

    for (const region of [
      screen.getByTestId("stub-sidebar"),
      screen.getByTestId("stub-channel"),
    ]) {
      expect(region.hasAttribute("data-channel-background")).toBe(false);
      expect(region.querySelector(`[data-channel-background]`)).toBeNull();
      expect(region.classList.contains(TINT_CLASS)).toBe(false);
    }
    expect(
      screen
        .getByRole("textbox", { name: "Channel box" })
        .closest(`.${CSS.escape(TINT_CLASS)}`),
    ).toBeNull();
    expect(
      screen
        .getByRole("textbox", { name: "Thread box" })
        .closest(`.${CSS.escape(TINT_CLASS)}`),
    ).toBeNull();
  });

  it.each([
    ["names no appearance", null],
    ["chose none", "none"],
  ] as const)("keeps the page's own header when the bot %s", (_name, how) => {
    if (how === "none") chooseBackground(null);
    render(surface());

    expect(header().classList.contains(TINT_CLASS)).toBe(false);
    expect(header().hasAttribute("data-channel-background")).toBe(false);
    expect(header().style.getPropertyValue("--channel-tint")).toBe("");
  });
});
