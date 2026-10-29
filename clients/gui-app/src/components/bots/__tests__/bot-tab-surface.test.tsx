/**
 * The bot tab's surface (Tracy Bots): the tab asks `bot.open` through its own
 * host and follows the answer - serving, or paused with a reason - and never
 * names the machine a bot runs on or moves to it (T65).
 * Also: the stream's states, the re-subscribe and re-open when the pane comes
 * back into view, the tab closing when the bot is gone from `bot.list`, and a
 * team's main bot still to be set up (T67): a tab on its id shows the channel
 * where the team is set up, with nothing opened, subscribed or closed (the
 * real hook, over a scripted `bot.onboarding.read`).
 * The three views are replaced by stubs that expose their props, so what the
 * surface PASSES them is what is asserted. The tab strip's Activity label
 * reads the real summary hook over the real agent-activity store.
 */
import { useAuthStore } from "@/stores/auth/auth-store";
import { StrictMode, type ReactNode } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BotOpenPausedReason,
  BotOpenResponse,
  BotRecord,
  BotTaskEntry,
} from "@traycer/protocol/host/bot/schemas";
import type { BotOnboardingSetup } from "@traycer/protocol/host/bot/onboarding-schemas";
import type { BotSubscriptionSnapshot } from "@/hooks/bots/use-bot-subscription";
import type {
  BotOpenThread,
  BotOpenTurn,
} from "@/stores/bots/bot-open-thread-store";
import {
  __resetAgentActivityStoreForTests,
  __setAgentActivityStateForTests,
} from "@/stores/agent-activity-store";

type OpenResult =
  | { readonly kind: "answer"; readonly response: BotOpenResponse }
  | { readonly kind: "error"; readonly message: string };

type ReadScript = { setup: BotOnboardingSetup | null } | "fails";

const mocks = vi.hoisted(() => ({
  hostClient: { stub: "tab-host-client" },
  resubscribe: vi.fn<() => void>(),
  open: vi.fn<(variables: { botId: string }) => void>(),
  openMutation: {
    mutate: (
      variables: { botId: string },
      options: {
        onSuccess: (response: BotOpenResponse) => void;
        onError: (error: { message: string }) => void;
      },
    ): void => {
      mocks.open(variables);
      const result = mocks.state.openResult;
      if (result === null) return;
      if (result.kind === "answer") options.onSuccess(result.response);
      else options.onError({ message: result.message });
    },
  },
  /** The bots the tab subscribed to, in order. */
  subscribed: [] as string[],
  /** What `bot.onboarding.read` answers per environment id; absent is pending. */
  reads: {} as Record<string, ReadScript>,
  /** A read's `refetch`, which Retry calls on a failed `bot.onboarding.read`. */
  readRefetch: vi.fn<() => void>(),
  /** The bot list query's `refetch`; a case scripts what a re-read answers. */
  listRefetch: vi.fn<() => void>(),
  /** The environment list query's `refetch`. */
  environmentsRefetch: vi.fn<() => void>(),
  supportQueries: [] as Array<{ hostId: string | null; method: string }>,
  membersQueries: [] as Array<{
    environmentId: string | null;
    enabled: boolean;
  }>,
  useBotListChangedSubscriptionForHost:
    vi.fn<(hostId: string, enabled: boolean) => void>(),
  state: {
    snapshot: null as BotSubscriptionSnapshot | null,
    deleted: false,
    error: null as string | null,
    paneVisible: true,
    connectable: { hostIds: [] as string[], resolved: true },
    listedBotIds: undefined as string[] | undefined,
    mainBotIds: null as Record<string, string> | null,
    support: null as boolean | null,
    /** Whether the host advertises `bot.onboarding.read`; `null` while unknown. */
    onboardingSupport: true,
    /** The line the host negotiated for `bot.onboarding.read`. */
    onboardingVersion: { major: 1, minor: 1 },
    /** When a successful `bot.onboarding.read` answered. */
    readAt: 1_000,
    /**
     * The bot list's last read failed: its status is `error`, with the data
     * it had kept, or none when `listedBotIds` is `undefined` (a cold read).
     */
    listFailed: false,
    /** The environment list's status; `error` and `pending` carry no data. */
    environmentsStatus: "success",
    /** The bot list query's freshness, as TanStack reports it. */
    list: {
      dataUpdatedAt: 1_000,
      errorUpdatedAt: 0,
      isFetchedAfterMount: true,
      isFetching: false,
    },
    membersSupport: null as boolean | null,
    openResult: null as OpenResult | null,
    environments: [] as Array<{
      environmentId: string;
      label: string;
      ownerKind: "organization" | "user";
    }>,
  },
}));

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: (hostId: string | null, method: string) => {
    mocks.supportQueries.push({ hostId, method });
    if (method === "environment.members") return mocks.state.membersSupport;
    if (method === "bot.onboarding.read") return mocks.state.onboardingSupport;
    return mocks.state.support;
  },
  useHostMethodSchemaVersion: () => mocks.state.onboardingVersion,
  useHostSupportsMethod: (hostId: string | null, method: string) => {
    mocks.supportQueries.push({ hostId, method });
    return true;
  },
}));
// The host RPC boundary: `bot.onboarding.read` answers what the test
// scripted, and a query that is not enabled reads as pending, as TanStack's
// does.
vi.mock("@/hooks/host/use-host-queries", () => ({
  useHostQueries: (args: {
    requests: ReadonlyArray<{ params: { environmentId: string } }>;
    options: { enabled?: boolean } | null;
  }) =>
    args.requests.map((request) => {
      const script =
        args.options?.enabled === true
          ? mocks.reads[request.params.environmentId]
          : undefined;
      const pending = {
        status: "pending",
        data: undefined,
        dataUpdatedAt: 0,
        refetch: mocks.readRefetch,
      };
      if (script === undefined) return pending;
      if (script === "fails") return { ...pending, status: "error" };
      return {
        ...pending,
        status: "success",
        data: script,
        dataUpdatedAt: mocks.state.readAt,
      };
    }),
}));
vi.mock("@/hooks/bots/use-host-environment-bindings-query", () => ({
  useHostEnvironmentBindings: () => ({
    byHostId: {},
    failedHostIds: [],
    retryFailed: () => undefined,
  }),
}));
// The members of the bot's environment, as the channel view's resolver:
// one teammate it knows by name.
vi.mock("@/hooks/bots/use-environment-members-query", () => ({
  useEnvironmentMemberDirectory: (
    _client: unknown,
    environmentId: string | null,
    enabled: boolean,
  ) => {
    mocks.membersQueries.push({ environmentId, enabled });
    return {
      resolve: (userId: string) =>
        enabled && userId === "user-teammate"
          ? { displayName: "Tess Teammate", avatarUrl: null }
          : null,
      members: enabled
        ? [
            {
              userId: "user-teammate",
              displayName: "Tess Teammate",
              avatarUrl: null,
            },
          ]
        : null,
    };
  },
}));

vi.mock("@/components/epic-canvas/tab-host-provider", () => ({
  TabHostProvider: (props: { hostId: string; children: ReactNode }) => (
    <>{props.children}</>
  ),
}));
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => mocks.hostClient,
}));
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
vi.mock("@/hooks/bots/use-bot-memory", () => ({
  useBotMemory: () => ({ kind: "unsupported" }),
}));
vi.mock("@/hooks/bots/use-bot-subscription", () => ({
  useBotSubscriptionForHost: (input: { botId: string }) => {
    mocks.subscribed.push(input.botId);
    return {
      snapshot: mocks.state.snapshot,
      deleted: mocks.state.deleted,
      error: mocks.state.error,
      isPending: mocks.state.snapshot === null,
      resubscribe: mocks.resubscribe,
    };
  },
}));
vi.mock("@/hooks/host/use-connectable-host-ids", () => ({
  useConnectableHostIds: () => mocks.state.connectable,
}));
// The directory still holds host labels: if the tab ever read it to say where
// the bot runs, a label would reach the screen and the no-machine checks below
// would catch it.
vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({
    data: [
      { hostId: "host-tab", label: "Laptop" },
      { hostId: "host-bound", label: "Studio Mac" },
    ],
  }),
}));
vi.mock("@/hooks/bots/use-bot-list-query", () => {
  const listStatus = (): "pending" | "error" | "success" => {
    if (mocks.state.listedBotIds === undefined) {
      return mocks.state.listFailed ? "error" : "pending";
    }
    return mocks.state.listFailed ? "error" : "success";
  };
  return {
    useBotListQuery: () => ({
      status: listStatus(),
      data:
        mocks.state.listedBotIds === undefined
          ? undefined
          : {
              bots: mocks.state.listedBotIds.map((botId) => ({
                botId,
                title: botId,
                environmentId: "env-team",
                archivedAt: null,
              })),
              mainBotIds: mocks.state.mainBotIds,
            },
      ...mocks.state.list,
      refetch: mocks.listRefetch,
    }),
  };
});
vi.mock("@/hooks/bots/use-bot-list-changed-subscription", () => ({
  useBotListChangedSubscriptionForHost: (hostId: string, enabled: boolean) =>
    mocks.useBotListChangedSubscriptionForHost(hostId, enabled),
}));
vi.mock("@/hooks/bots/use-environment-list-query", () => ({
  useEnvironmentListQuery: () => ({
    status: mocks.state.environmentsStatus,
    data:
      mocks.state.environmentsStatus === "success"
        ? { environments: mocks.state.environments }
        : undefined,
    refetch: mocks.environmentsRefetch,
  }),
}));
// One stable mutation object, like TanStack's `mutate`: the surface re-opens
// from an effect keyed on it.
vi.mock("@/hooks/bots/use-bot-mutations", () => ({
  useBotOpenMutation: () => mocks.openMutation,
}));
vi.mock("@/components/bots/bot-channel-sidebar", () => ({
  BotChannelSidebar: (props: { activeBotId: string; hostId: string }) => (
    <div
      data-testid="stub-sidebar"
      data-active-bot-id={props.activeBotId}
      data-host-id={props.hostId}
    />
  ),
}));
vi.mock("@/components/bots/bot-channel-view", () => ({
  BotChannelView: (props: {
    botId: string;
    hostId: string;
    boundHostId: string | null;
    botTitle: string;
    appConversationChatId: string | null;
    openThread: BotOpenThread | null;
    openTurn: BotOpenTurn | null;
    trunkChatId: string;
    onOpenActivity: () => void;
    resolveMember: (
      userId: string,
    ) => { displayName: string | null; avatarUrl: string | null } | null;
  }) => (
    <div
      data-testid="stub-channel"
      data-host-id={props.hostId}
      data-bound-host-id={props.boundHostId ?? "none"}
      data-bot-title={props.botTitle}
      data-app-conversation-chat-id={props.appConversationChatId ?? "none"}
      data-open-thread={props.openThread?.anchorMessageId ?? "none"}
      data-open-turn={props.openTurn?.ref.turnIds[0] ?? "none"}
      data-open-turn-back={props.openTurn?.back?.anchorMessageId ?? "none"}
      data-trunk-chat-id={props.trunkChatId}
      data-teammate-name={
        props.resolveMember("user-teammate")?.displayName ?? "unresolved"
      }
    >
      <button
        type="button"
        data-testid="stub-channel-open-activity"
        onClick={props.onOpenActivity}
      />
    </div>
  ),
}));
// The Activity page takes the bot's bound host, which says where its
// background work can be read, whether or not this host serves the tab.
vi.mock("@/components/bots/bot-activity-page", () => ({
  BotActivityPage: (props: {
    boundHost: { hostId: string | null; isThisHost: boolean };
    onOpenPost: (open: BotOpenThread) => void;
    onOpenTurn: (open: BotOpenTurn) => void;
  }) => (
    <div
      data-testid="stub-activity"
      data-bound-host-id={props.boundHost.hostId ?? "none"}
      data-is-this-host={String(props.boundHost.isThisHost)}
    >
      <button
        type="button"
        data-testid="stub-activity-open-post"
        onClick={() =>
          props.onOpenPost({
            anchorMessageId: "post-1",
            announcement: false,
            answer: false,
            sent: null,
          })
        }
      />
      <button
        type="button"
        data-testid="stub-activity-open-turn"
        onClick={() =>
          props.onOpenTurn({
            ref: {
              chatId: "trunk-1",
              turnIds: ["turn-checkin"],
              userMessageId: "prompt-checkin",
              threadId: null,
              startedAt: 1_000,
              endedAt: 2_000,
              summary: null,
              messageIds: [],
              requestIds: [],
            },
            question: null,
            back: null,
          })
        }
      />
    </div>
  ),
}));
vi.mock("@/components/bots/bot-threads-page", () => ({
  BotThreadsPage: (props: { botId: string; hostId: string }) => (
    <div
      data-testid="stub-threads"
      data-bot-id={props.botId}
      data-host-id={props.hostId}
    />
  ),
}));
vi.mock("@/hooks/bots/use-bot-thread-list-query", () => ({
  useBotThreadListQuery: () => ({ data: { threads: [] } }),
}));
// The panel takes the bot, whether it is main, whether its environment is a
// person's own, its channel, its environment's bots and how to close, and
// nothing else: no prop says which host serves the tab, so no control can be
// gated on it. The stub lists the props it was given.
vi.mock("@/components/bots/bot-settings-panel", () => ({
  BotChannelSettingsPanel: (props: {
    isMain: boolean | null;
    personal: boolean;
    channelId: string | null;
    onClose: () => void;
  }) => (
    <div
      data-testid="stub-settings"
      data-prop-names={Object.keys(props).join(",")}
      data-is-main={String(props.isMain)}
      data-personal={String(props.personal)}
      data-channel-id={props.channelId ?? "none"}
    >
      <button
        type="button"
        data-testid="stub-settings-close"
        onClick={props.onClose}
      />
    </div>
  ),
}));

import { BotTabSurface } from "@/components/bots/bot-tab-surface";
import { lookupBotTab, useBotTabsStore } from "@/stores/bots/bot-tabs-store";
import { useBotPaneWidthsStore } from "@/stores/bots/bot-pane-widths-store";
import { useBotOpenThreadStore } from "@/stores/bots/bot-open-thread-store";

const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const OTHER_BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAW";
/** The id a new team's main bot will be created under. */
const SETUP_BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAX";
const TAB_HOST = "host-tab";
const BOUND_HOST = "host-bound";

const BOT: BotRecord = {
  botId: BOT_ID,
  environmentId: "env-team",
  createdByUserId: "user-1",
  title: "Release Bot",
  harness: "claude",
  model: "opus",
  effort: null,
  profile: null,
  trunkChatId: "trunk-1",
  boundHostId: BOUND_HOST,
  hostEpoch: 1,
  createdAt: 1_000,
  archivedAt: null,
  directive: null,
  replyMode: "thread",
  appConversationChatId: "conversation-app",
};

function snapshot(): BotSubscriptionSnapshot {
  return {
    bot: BOT,
    tasks: [],
    openRequestCount: 0,
    conversationsRevision: null,
    notificationSubscriptions: null,
    surfaceActions: null,
    stoppedNotificationWatches: null,
    boundHost: { hostId: BOUND_HOST, epoch: 1, isThisHost: false },
    activity: null,
  };
}

function trackingTask(taskId: string): BotTaskEntry {
  return {
    taskId,
    cadence: { kind: "every", seconds: 3_600 },
    lastCheckinAt: null,
    lastCheckin: null,
    nextAt: null,
    state: "tracking",
    endedReason: null,
    createdByUserId: null,
    spun: true,
    label: null,
    originRequestId: null,
    createdByChatId: null,
    checkins: null,
    inputNeeded: null,
    pause: null,
    stop: null,
    runRequest: null,
  };
}

function answer(outcome: BotOpenResponse["outcome"]): OpenResult {
  return { kind: "answer", response: { bot: BOT, outcome } };
}

function surfaceFor(botId: string): ReactNode {
  return (
    <StrictMode>
      <BotTabSurface botId={botId} hostId={TAB_HOST} />
    </StrictMode>
  );
}

function surface(): ReactNode {
  return surfaceFor(BOT_ID);
}

/** Nothing on a tab says where a bot runs or offers to move it. */
function expectNoMachineWording(container: HTMLElement): void {
  expect(container.textContent).not.toMatch(
    /View on|Move it here|Studio Mac|Laptop|host-bound|host-tab|offline/i,
  );
  expect(screen.queryByTestId("bot-tab-bound-elsewhere")).toBeNull();
  expect(screen.queryByTestId("bot-tab-move-here")).toBeNull();
}

function tabHostIdInStore(): string | null {
  const record = lookupBotTab(useBotTabsStore.getState().tabs, BOT_ID);
  return record === null ? null : record.hostId;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.supportQueries.length = 0;
  mocks.membersQueries.length = 0;
  mocks.state.membersSupport = true;
  mocks.state.snapshot = snapshot();
  mocks.state.deleted = false;
  mocks.state.error = null;
  mocks.state.paneVisible = true;
  mocks.state.connectable = { hostIds: [TAB_HOST, BOUND_HOST], resolved: true };
  // The bot is listed, in a team that has bots: nothing is to be set up.
  mocks.state.listedBotIds = [BOT_ID];
  mocks.state.mainBotIds = null;
  mocks.state.support = true;
  mocks.state.onboardingSupport = true;
  mocks.state.onboardingVersion = { major: 1, minor: 1 };
  mocks.state.readAt = 1_000;
  mocks.state.listFailed = false;
  mocks.state.environmentsStatus = "success";
  mocks.state.list = {
    dataUpdatedAt: 1_000,
    errorUpdatedAt: 0,
    isFetchedAfterMount: true,
    isFetching: false,
  };
  mocks.readRefetch.mockReset();
  mocks.listRefetch.mockReset();
  mocks.environmentsRefetch.mockReset();
  mocks.state.openResult = answer({ kind: "serve-here", claimed: null });
  mocks.state.environments = [
    { environmentId: "env-team", label: "Acme", ownerKind: "organization" },
  ];
  mocks.subscribed.length = 0;
  for (const key of Object.keys(mocks.reads)) delete mocks.reads[key];
  useBotTabsStore.setState({ tabs: {} });
  useBotOpenThreadStore.setState({ byBotId: {} });
  __resetAgentActivityStoreForTests();
  useBotTabsStore
    .getState()
    .openBotTab({ botId: BOT_ID, hostId: TAB_HOST, title: "Release Bot" });
});

afterEach(() => {
  cleanup();
  // A case that signs a viewer in leaves no one signed in for the next.
  useAuthStore.setState({ profile: null });
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

/**
 * A tab on a team's main bot before the bot exists: the team (`env-new`) has
 * no bot of its own, another team's bot is the only one listed, and the tab
 * is open as the sidebar's row would have opened it.
 */
function setUpNewTeam(): void {
  mocks.state.environments = [
    { environmentId: "env-team", label: "Acme", ownerKind: "organization" },
    { environmentId: "env-new", label: "Newco", ownerKind: "organization" },
  ];
  mocks.state.listedBotIds = [BOT_ID];
  useBotTabsStore
    .getState()
    .openBotTab({ botId: SETUP_BOT_ID, hostId: TAB_HOST, title: "Tracy" });
}

describe("<BotTabSurface /> a team's main bot still to be set up", () => {
  beforeEach(() => {
    setUpNewTeam();
    mocks.reads["env-new"] = {
      setup: { botId: SETUP_BOT_ID, title: "Tracy" },
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
      "Give the team a host",
      "Enable cloud for the team",
      "Create a team host on a machine",
    ]);
    expect(within(card).queryAllByRole("link")).toHaveLength(0);
    expect(channel.textContent).not.toMatch(/github|starter|seat/i);
    expect(screen.queryByTestId("stub-channel")).toBeNull();
    expect(screen.queryByTestId("bot-tab-connecting")).toBeNull();
  });

  it("draws each way to get a host with its button disabled and a line saying it is not available yet, and a click does nothing", async () => {
    const user = userEvent.setup();
    render(surfaceFor(SETUP_BOT_ID));

    const card = screen.getByTestId("team-host-options");
    const buttons = within(card).getAllByRole("button");
    expect(
      buttons.map((button) => [
        button.textContent,
        button.hasAttribute("disabled"),
        button.getAttribute("aria-describedby") === null
          ? null
          : document.getElementById(
              button.getAttribute("aria-describedby") ?? "",
            )?.textContent,
      ]),
    ).toEqual([
      ["Enable cloud", true, "Not available yet."],
      ["Create team host", true, "Not available yet."],
    ]);
    for (const button of buttons) await user.click(button);

    expect(mocks.open).not.toHaveBeenCalled();
    expect(screen.getByTestId("team-setup-channel")).toBeTruthy();
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
    ).toBe("Tracy can reply once the team has a host.");
  });

  it("opens, subscribes to and closes nothing: the bot does not exist", () => {
    render(surfaceFor(SETUP_BOT_ID));

    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.subscribed).toEqual([]);
    expect(mocks.useBotListChangedSubscriptionForHost).not.toHaveBeenCalled();
    expect(
      lookupBotTab(useBotTabsStore.getState().tabs, SETUP_BOT_ID),
    ).not.toBeNull();
  });

  it("shows the connecting state, opening nothing, until the team's read answers, then the setup channel", () => {
    delete mocks.reads["env-new"];
    const view = render(surfaceFor(SETUP_BOT_ID));

    expect(screen.getByTestId("bot-tab-connecting")).toBeTruthy();
    expect(screen.queryByTestId("team-setup-channel")).toBeNull();
    expect(mocks.open).not.toHaveBeenCalled();
    expect(
      lookupBotTab(useBotTabsStore.getState().tabs, SETUP_BOT_ID),
    ).not.toBeNull();

    mocks.reads["env-new"] = {
      setup: { botId: SETUP_BOT_ID, title: "Tracy" },
    };
    view.rerender(surfaceFor(SETUP_BOT_ID));

    expect(screen.getByTestId("team-setup-channel")).toBeTruthy();
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it.each<readonly [string, ReadScript]>([
    ["the read answers no setup", { setup: null }],
    [
      "the setup names another bot",
      { setup: { botId: OTHER_BOT_ID, title: "Tracy" } },
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
      expect(
        lookupBotTab(useBotTabsStore.getState().tabs, SETUP_BOT_ID),
      ).toBeNull();
    },
  );

  /**
   * The team's setup cannot be told from a deleted bot: the read failed, or
   * the host does not answer it. The tab says so and offers to read again.
   */
  it.each<readonly [string, () => void]>([
    [
      "the setup read fails",
      () => {
        mocks.reads["env-new"] = "fails";
      },
    ],
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
    "shows the setup could not be read, with Retry, and never opens, subscribes to or closes the tab, when %s",
    async (_name, script) => {
      script();
      const user = userEvent.setup();
      const view = render(surfaceFor(SETUP_BOT_ID));

      const notice = screen.getByTestId("bot-tab-error");
      expect(notice.textContent).toContain("Couldn't load this channel.");
      expect(screen.queryByTestId("team-setup-channel")).toBeNull();
      expect(screen.queryByTestId("bot-tab-connecting")).toBeNull();
      expect(mocks.open).not.toHaveBeenCalled();
      expect(mocks.subscribed).toEqual([]);
      expect(
        lookupBotTab(useBotTabsStore.getState().tabs, SETUP_BOT_ID),
      ).not.toBeNull();

      // Retry reads again (the host now answers, where it did not); once the
      // read answers the setup, its channel shows.
      mocks.readRefetch.mockImplementation(() => {
        mocks.reads["env-new"] = {
          setup: { botId: SETUP_BOT_ID, title: "Tracy" },
        };
      });
      mocks.state.onboardingSupport = true;
      mocks.state.onboardingVersion = { major: 1, minor: 1 };
      await user.click(within(notice).getByRole("button", { name: "Retry" }));

      expect(mocks.listRefetch).not.toHaveBeenCalled();
      expect(mocks.environmentsRefetch).not.toHaveBeenCalled();
      view.rerender(surfaceFor(SETUP_BOT_ID));

      expect(screen.getByTestId("team-setup-channel")).toBeTruthy();
      expect(screen.queryByTestId("bot-tab-error")).toBeNull();
      expect(mocks.open).not.toHaveBeenCalled();
      expect(mocks.subscribed).toEqual([]);
      expect(
        lookupBotTab(useBotTabsStore.getState().tabs, SETUP_BOT_ID),
      ).not.toBeNull();
    },
  );

  it("re-reads a failed setup read on Retry", async () => {
    mocks.reads["env-new"] = "fails";
    const user = userEvent.setup();
    render(surfaceFor(SETUP_BOT_ID));

    expect(mocks.readRefetch).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Retry" }));

    expect(mocks.readRefetch).toHaveBeenCalled();
    expect(mocks.listRefetch).not.toHaveBeenCalled();
    expect(mocks.environmentsRefetch).not.toHaveBeenCalled();
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
        setup: { botId: SETUP_BOT_ID, title: "Tracy" },
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
      expect(
        lookupBotTab(useBotTabsStore.getState().tabs, SETUP_BOT_ID),
      ).not.toBeNull();

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

      expect(mocks.listRefetch).toHaveBeenCalled();
      expect(screen.getByTestId("bot-tab-connecting")).toBeTruthy();
      expect(mocks.open).not.toHaveBeenCalled();
      expect(
        lookupBotTab(useBotTabsStore.getState().tabs, SETUP_BOT_ID),
      ).not.toBeNull();

      view.rerender(surfaceFor(SETUP_BOT_ID));

      expect(mocks.open).toHaveBeenCalledWith({ botId: SETUP_BOT_ID });
      expect(screen.getByTestId("stub-channel")).toBeTruthy();
      expect(screen.queryByTestId("bot-tab-connecting")).toBeNull();
      expect(
        lookupBotTab(useBotTabsStore.getState().tabs, SETUP_BOT_ID),
      ).not.toBeNull();
    },
  );

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
    expect(
      lookupBotTab(useBotTabsStore.getState().tabs, SETUP_BOT_ID),
    ).not.toBeNull();

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
    expect(
      lookupBotTab(useBotTabsStore.getState().tabs, SETUP_BOT_ID),
    ).not.toBeNull();
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
    render(<BotTabSurface botId={BOT_ID} hostId={TAB_HOST} />);

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

      expect(tabHostIdInStore()).toBe(TAB_HOST);
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

    expect(tabHostIdInStore()).toBe(TAB_HOST);
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

  it("hands the Activity page the bound host, paused or not", async () => {
    const user = userEvent.setup();
    mocks.state.openResult = answer({
      kind: "paused",
      reason: "bound-to-sandbox",
    });
    render(surface());

    await user.click(screen.getByTestId("bot-tab-view-activity"));
    const page = screen.getByTestId("stub-activity");
    expect(page.getAttribute("data-bound-host-id")).toBe(BOUND_HOST);
    expect(page.getAttribute("data-is-this-host")).toBe("false");
  });

  it("keeps the channel settings ungated: the panel is given the bot, whether it is main and whether it is personal, and no editing flag", async () => {
    const user = userEvent.setup();
    mocks.state.openResult = answer({
      kind: "paused",
      reason: "bound-host-not-observable",
    });
    render(surface());

    await user.click(screen.getByTestId("bot-channel-settings-open"));
    expect(
      screen.getByTestId("stub-settings").getAttribute("data-prop-names"),
    ).toBe("bot,isMain,personal,channelId,environmentBots,onClose");
  });

  it.each<readonly [string, "user" | "organization", string]>([
    ["a person's own", "user", "true"],
    ["a team's", "organization", "false"],
  ])(
    "tells the settings panel whether the bot's environment is personal: %s",
    async (_name, ownerKind, expected) => {
      const user = userEvent.setup();
      mocks.state.environments = [
        { environmentId: "env-team", label: "Acme", ownerKind },
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
        { environmentId: "env-team", label: "Acme", ownerKind },
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
      { environmentId: "env-other", label: "Mine", ownerKind: "user" },
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
    render(<BotTabSurface botId={BOT_ID} hostId={TAB_HOST} />);
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
    render(<BotTabSurface botId={BOT_ID} hostId={TAB_HOST} />);

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
  it("draws the header as the bot's picture, the channel's name with the main bot's star, its three views and the settings ⋮ only", () => {
    mocks.state.listedBotIds = [BOT_ID, OTHER_BOT_ID];
    mocks.state.mainBotIds = { "env-team": BOT_ID };
    render(surface());

    const header = screen.getByTestId("bot-tab-title").closest("header");
    if (header === null) throw new Error("expected the channel header");
    expect(
      within(header)
        .getAllByRole("tab")
        .map((tab) => tab.textContent),
    ).toEqual(["Messages", "Activity", "Threads"]);
    expect(header.textContent).toBe(
      `${screen.getByTestId("bot-tab-avatar").textContent}${screen.getByTestId("bot-tab-title").textContent}MessagesActivityThreads`,
    );
    expect(
      within(header).getByRole("button", { name: "Channel settings" }),
    ).toBe(screen.getByTestId("bot-channel-settings-open"));
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

  it.each([
    ["is main", { "env-team": BOT_ID }, "true"],
    ["is not main", { "env-team": OTHER_BOT_ID }, "false"],
    ["is not known", null, "null"],
  ])(
    "tells the settings panel whether the bot is main: %s",
    async (_name, mainBotIds, expected) => {
      const user = userEvent.setup();
      mocks.state.listedBotIds = [BOT_ID, OTHER_BOT_ID];
      mocks.state.mainBotIds = mainBotIds;
      render(surface());

      await user.click(screen.getByTestId("bot-channel-settings-open"));
      expect(
        screen.getByTestId("stub-settings").getAttribute("data-is-main"),
      ).toBe(expected);
    },
  );
});

describe("<BotTabSurface /> views", () => {
  function activityTab(): HTMLElement {
    return screen.getByTestId("bot-tab-view-activity");
  }

  it("shows Messages first, with Activity and Threads beside it, and no counts for a quiet bot", () => {
    render(surface());

    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Messages",
      "Activity",
      "Threads",
    ]);
    expect(
      screen.getByTestId("bot-tab-view-messages").getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.getByTestId("stub-channel")).toBeTruthy();
    expect(
      activityTab().querySelector("[data-testid^='bot-tab-activity-']"),
    ).toBeNull();
  });

  it("counts what stopped, in red and first, what runs and the tasks the bot tracks, leaving out a zero", () => {
    mocks.state.snapshot = {
      ...snapshot(),
      tasks: [trackingTask("task-1"), trackingTask("task-2")],
      activity: {
        trunk: {
          state: "failed",
          startedAt: null,
          step: null,
          requestId: "req-1",
          reason: null,
        },
        threads: {},
      },
    };
    __setAgentActivityStateForTests(
      { "task-1": { working: ["agent-1"], turn: [] } },
      "local",
      null,
    );
    render(surface());

    expect(activityTab().textContent).toBe(
      "Activity · 1 stopped · 1 running · 2 tasks",
    );
    const parts = within(activityTab()).getAllByTestId(/^bot-tab-activity-/);
    expect(parts.map((part) => part.dataset.testid)).toEqual([
      "bot-tab-activity-stopped",
      "bot-tab-activity-running",
      "bot-tab-activity-tasks",
    ]);
    expect(parts[0].className).toContain("text-destructive");
    expect(parts[1].className).not.toContain("text-destructive");
  });

  it("leaves out the stopped and running counts when nothing has stopped or runs", () => {
    mocks.state.snapshot = {
      ...snapshot(),
      tasks: [trackingTask("task-1")],
    };
    render(surface());

    expect(activityTab().textContent).toBe("Activity · 1 task");
  });

  it("shows the Threads page when Threads is chosen", async () => {
    const user = userEvent.setup();
    render(surface());

    await user.click(screen.getByTestId("bot-tab-view-threads"));

    const page = screen.getByTestId("stub-threads");
    expect(page.getAttribute("data-bot-id")).toBe(BOT_ID);
    expect(page.getAttribute("data-host-id")).toBe(TAB_HOST);
    expect(screen.queryByTestId("stub-channel")).toBeNull();
  });

  it("switches to Activity from the open thread's Activity link", async () => {
    const user = userEvent.setup();
    render(surface());

    await user.click(screen.getByTestId("stub-channel-open-activity"));

    expect(activityTab().getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("stub-activity")).toBeTruthy();
    expect(screen.queryByTestId("stub-channel")).toBeNull();
  });

  it("returns to Messages with the thread open when Activity opens a post", async () => {
    const user = userEvent.setup();
    render(surface());
    await user.click(activityTab());

    await user.click(screen.getByTestId("stub-activity-open-post"));

    expect(
      screen.getByTestId("bot-tab-view-messages").getAttribute("aria-selected"),
    ).toBe("true");
    expect(
      screen.getByTestId("stub-channel").getAttribute("data-open-thread"),
    ).toBe("post-1");
  });
});

describe("<BotTabSurface /> a check-in's turn from Activity", () => {
  it("returns to Messages with the turn open in the rail, in place of the thread that was open, and nothing to go back to", async () => {
    const user = userEvent.setup();
    useBotOpenThreadStore.getState().setRail(BOT_ID, {
      kind: "thread",
      anchorMessageId: "post-1",
      announcement: false,
      answer: false,
      sent: null,
    });
    render(surface());
    await user.click(screen.getByTestId("bot-tab-view-activity"));

    await user.click(screen.getByTestId("stub-activity-open-turn"));

    expect(
      screen.getByTestId("bot-tab-view-messages").getAttribute("aria-selected"),
    ).toBe("true");
    const channel = screen.getByTestId("stub-channel");
    expect(channel.getAttribute("data-open-turn")).toBe("turn-checkin");
    expect(channel.getAttribute("data-open-turn-back")).toBe("none");
    expect(channel.getAttribute("data-open-thread")).toBe("none");
  });

  it("gives the channel the bot's trunk session", () => {
    render(surface());

    expect(
      screen.getByTestId("stub-channel").getAttribute("data-trunk-chat-id"),
    ).toBe("trunk-1");
  });
});

describe("<BotTabSurface /> tab lifetime", () => {
  /**
   * The last bot of a team is deleted: the list no longer carries it and its
   * team has no bot, which is what a team still to be set up looks like. A tab
   * that showed the bot listed is that bot's, so it closes - it never shows the
   * setup notice, whatever the host answers about the team's onboarding.
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
    "closes the tab, never showing the setup notice, when bot.list no longer carries the last bot of its team and %s",
    (_name, script) => {
      script();
      const view = render(surface());
      expect(screen.getByTestId("stub-channel")).toBeTruthy();
      expect(
        lookupBotTab(useBotTabsStore.getState().tabs, BOT_ID),
      ).not.toBeNull();

      mocks.state.listedBotIds = [];
      view.rerender(surface());

      expect(lookupBotTab(useBotTabsStore.getState().tabs, BOT_ID)).toBeNull();
      expect(screen.queryByTestId("bot-tab-error")).toBeNull();
    },
  );

  it("closes a tab that was never listed when the list carries another bot of its team", () => {
    mocks.state.listedBotIds = [OTHER_BOT_ID];
    render(surface());

    expect(lookupBotTab(useBotTabsStore.getState().tabs, BOT_ID)).toBeNull();
  });

  it("keeps the tab while bot.list carries the bot or has not answered", () => {
    mocks.state.listedBotIds = [BOT_ID, OTHER_BOT_ID];
    const view = render(surface());
    expect(
      lookupBotTab(useBotTabsStore.getState().tabs, BOT_ID),
    ).not.toBeNull();

    view.unmount();
    mocks.state.listedBotIds = undefined;
    render(surface());
    expect(
      lookupBotTab(useBotTabsStore.getState().tabs, BOT_ID),
    ).not.toBeNull();
  });

  it("closes the tab on the stream's deleted frame", () => {
    mocks.state.deleted = true;
    render(surface());

    expect(lookupBotTab(useBotTabsStore.getState().tabs, BOT_ID)).toBeNull();
  });

  it("keeps bot.list current through the change stream on the tab's own host", () => {
    render(surface());

    expect(mocks.useBotListChangedSubscriptionForHost).toHaveBeenLastCalledWith(
      TAB_HOST,
      true,
    );
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
