/**
 * The bot tab's surface (Tracy Bots): the tab asks `bot.open` through its own
 * host and follows the answer - serving here, moving to a host this client can
 * dial, or paused with a reason - and never names the machine a bot runs on.
 * Also: the stream's states, the re-subscribe and re-open when the pane comes
 * back into view, the tab closing when the bot is gone from `bot.list`, and a
 * team whose onboarding locks its chat (the real gate, over a mocked read).
 * The three views are replaced by stubs that expose their props, so what the
 * surface PASSES them is what is asserted.
 */
import { StrictMode, type ReactNode } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BotOpenPausedReason,
  BotOpenResponse,
  BotRecord,
} from "@traycer/protocol/host/bot/schemas";
import type { BotOnboardingReadResponse } from "@traycer/protocol/host/bot/onboarding-schemas";
import type { BotSubscriptionSnapshot } from "@/hooks/bots/use-bot-subscription";

type OpenResult =
  | { readonly kind: "answer"; readonly response: BotOpenResponse }
  | { readonly kind: "error"; readonly message: string };

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
    return method === "environment.members"
      ? mocks.state.membersSupport
      : mocks.state.support;
  },
  useHostSupportsMethod: (hostId: string | null, method: string) => {
    mocks.supportQueries.push({ hostId, method });
    return true;
  },
}));
/** The team's onboarding read, by environment id; absent reads as pending. */
const onboardingReads = vi.hoisted(
  () => new Map<string, BotOnboardingReadResponse>(),
);
vi.mock("@/hooks/bots/use-bot-onboarding-query", () => ({
  useBotOnboardingQuery: (
    _client: unknown,
    environmentId: string,
    enabled: boolean,
  ) => {
    const data = enabled ? onboardingReads.get(environmentId) : undefined;
    return { status: data === undefined ? "pending" : "success", data };
  },
}));
vi.mock("@/hooks/bots/use-host-environment-bindings-query", () => ({
  useHostEnvironmentBindings: () => ({
    byHostId: {},
    failedHostIds: [],
    retryFailed: () => undefined,
  }),
}));
vi.mock("@/components/home/bots/bot-onboarding-card", () => ({
  BotOnboardingCard: (props: {
    environmentId: string;
    teamName: string;
    botCount: number;
  }) => (
    <div
      data-testid="stub-onboarding-card"
      data-environment-id={props.environmentId}
      data-team-name={props.teamName}
      data-bot-count={String(props.botCount)}
    />
  ),
}));
// The members of the bot's environment, as the channel view's resolver:
// one teammate it knows by name.
vi.mock("@/hooks/bots/use-environment-members-query", () => ({
  useEnvironmentMembers: (
    _client: unknown,
    environmentId: string | null,
    enabled: boolean,
  ) => {
    mocks.membersQueries.push({ environmentId, enabled });
    return (userId: string) =>
      enabled && userId === "user-teammate"
        ? { displayName: "Tess Teammate", avatarUrl: null }
        : null;
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
vi.mock("@/components/epic-tabs/pane-visibility-context", () => ({
  usePaneVisible: () => mocks.state.paneVisible,
}));
vi.mock("@/hooks/bots/use-bot-subscription", () => ({
  useBotSubscriptionForHost: () => ({
    snapshot: mocks.state.snapshot,
    deleted: mocks.state.deleted,
    error: mocks.state.error,
    isPending: mocks.state.snapshot === null,
    resubscribe: mocks.resubscribe,
  }),
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
vi.mock("@/hooks/bots/use-bot-list-query", () => ({
  useBotListQuery: () => ({
    status: mocks.state.listedBotIds === undefined ? "pending" : "success",
    data:
      mocks.state.listedBotIds === undefined
        ? undefined
        : {
            bots: mocks.state.listedBotIds.map((botId) => ({
              botId,
              environmentId: "env-team",
              archivedAt: null,
            })),
            mainBotIds: mocks.state.mainBotIds,
          },
  }),
}));
vi.mock("@/hooks/bots/use-bot-list-changed-subscription", () => ({
  useBotListChangedSubscriptionForHost: (hostId: string, enabled: boolean) =>
    mocks.useBotListChangedSubscriptionForHost(hostId, enabled),
}));
vi.mock("@/hooks/bots/use-environment-list-query", () => ({
  useEnvironmentListQuery: () => ({
    status: "success",
    data: { environments: mocks.state.environments },
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
    botTitle: string;
    appConversationChatId: string | null;
    paused: boolean;
    resolveMember: (
      userId: string,
    ) => { displayName: string | null; avatarUrl: string | null } | null;
  }) => (
    <div
      data-testid="stub-channel"
      data-host-id={props.hostId}
      data-bot-title={props.botTitle}
      data-app-conversation-chat-id={props.appConversationChatId ?? "none"}
      data-paused={String(props.paused)}
      data-teammate-name={
        props.resolveMember("user-teammate")?.displayName ?? "unresolved"
      }
    />
  ),
}));
vi.mock("@/components/bots/bot-under-the-hood-panel", () => ({
  BotUnderTheHoodPanel: (props: { paused: boolean }) => (
    <div data-testid="stub-under-the-hood" data-paused={String(props.paused)} />
  ),
}));
// The panel takes the bot, whether it is main and whether its environment is
// a person's own, and nothing else: no prop says which host serves the tab,
// so no control can be gated on it. The stub lists the props it was given.
vi.mock("@/components/bots/bot-settings-panel", () => ({
  BotSettingsPanel: (props: { isMain: boolean | null; personal: boolean }) => (
    <div
      data-testid="stub-settings"
      data-prop-names={Object.keys(props).join(",")}
      data-is-main={String(props.isMain)}
      data-personal={String(props.personal)}
    />
  ),
}));

import { BotTabSurface } from "@/components/bots/bot-tab-surface";
import { lookupBotTab, useBotTabsStore } from "@/stores/bots/bot-tabs-store";

const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const OTHER_BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAW";
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
    boundHost: { hostId: BOUND_HOST, epoch: 1, isThisHost: false },
  };
}

function answer(outcome: BotOpenResponse["outcome"]): OpenResult {
  return { kind: "answer", response: { bot: BOT, outcome } };
}

function surface(): ReactNode {
  return (
    <StrictMode>
      <BotTabSurface botId={BOT_ID} hostId={TAB_HOST} />
    </StrictMode>
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
  // The bot is listed, and its team has answered with no onboarding: a team
  // from before onboarding, never locked.
  mocks.state.listedBotIds = [BOT_ID];
  mocks.state.mainBotIds = null;
  mocks.state.support = true;
  mocks.state.openResult = answer({ kind: "serve-here", claimed: null });
  mocks.state.environments = [
    { environmentId: "env-team", label: "Acme", ownerKind: "organization" },
  ];
  onboardingReads.clear();
  onboardingReads.set("env-team", noOnboardingRead());
  useBotTabsStore.setState({ tabs: {} });
  useBotTabsStore
    .getState()
    .openBotTab({ botId: BOT_ID, hostId: TAB_HOST, title: "Release Bot" });
});

afterEach(() => {
  cleanup();
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

  it("draws nothing, and opens nothing, until the handshake has answered either way", () => {
    mocks.state.support = null;
    const { container } = render(surface());

    expect(container.textContent).toBe("");
    expect(screen.queryByTestId("stub-channel")).toBeNull();
    expect(mocks.open).not.toHaveBeenCalled();
  });
});

/** A team's onboarding read with no record: the team pre-dates onboarding. */
function noOnboardingRead(): BotOnboardingReadResponse {
  return {
    github: {
      state: "ok",
      installingAdmin: null,
      repositories: [
        { repositoryId: "11", fullName: "acme/web", permission: "write" },
      ],
      callerCanConnect: false,
    },
    unlocked: true,
    choice: null,
    catalog: [],
  };
}

/** A team's onboarding read: `repositories` empty locks its chat. */
function onboardingRead(
  repositories: BotOnboardingReadResponse["github"]["repositories"],
): BotOnboardingReadResponse {
  return {
    github: {
      state: "ok",
      installingAdmin: null,
      repositories,
      callerCanConnect: false,
    },
    unlocked: repositories.length > 0,
    choice: {
      areas: ["ci-speed-and-cost"],
      chosenAt: 1_000,
      completedAt: null,
      pending: [
        { area: "ci-speed-and-cost", botId: BOT_ID, hostId: BOUND_HOST },
      ],
    },
    catalog: [],
  };
}

describe("<BotTabSurface /> while the team's onboarding locks its chat", () => {
  it("shows a restored tab the onboarding instead of the channel, opening nothing, and opens the channel once the lock lifts", () => {
    // A bot an onboarding try made, its tab restored with the team's GitHub
    // set holding no repository.
    mocks.state.listedBotIds = [BOT_ID];
    onboardingReads.set("env-team", onboardingRead([]));
    const view = render(surface());

    const card = screen.getByTestId("stub-onboarding-card");
    expect(card.dataset.environmentId).toBe("env-team");
    expect(card.dataset.teamName).toBe("Acme");
    expect(card.dataset.botCount).toBe("1");
    expect(screen.queryByTestId("stub-channel")).toBeNull();
    expect(screen.queryByTestId("bot-tab-connecting")).toBeNull();
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.supportQueries).toContainEqual({
      hostId: TAB_HOST,
      method: "bot.onboarding.read",
    });

    onboardingReads.set(
      "env-team",
      onboardingRead([
        { repositoryId: "11", fullName: "acme/web", permission: "write" },
      ]),
    );
    view.rerender(surface());

    expect(screen.queryByTestId("stub-onboarding-card")).toBeNull();
    expect(screen.getByTestId("stub-channel")).toBeTruthy();
    expect(mocks.open).toHaveBeenCalledWith({ botId: BOT_ID });
  });

  it("opens nothing and shows no channel while the onboarding read is held, then shows the onboarding when it answers locked", () => {
    onboardingReads.clear();
    const view = render(surface());

    expect(mocks.open).not.toHaveBeenCalled();
    expect(screen.queryByTestId("stub-channel")).toBeNull();
    expect(screen.queryByTestId("stub-sidebar")).toBeNull();
    expect(screen.getByTestId("bot-tab-connecting")).toBeTruthy();

    onboardingReads.set("env-team", onboardingRead([]));
    view.rerender(surface());

    expect(screen.getByTestId("stub-onboarding-card")).toBeTruthy();
    expect(screen.queryByTestId("stub-channel")).toBeNull();
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it("opens the channel of a team with no onboarding once its read answers", () => {
    onboardingReads.clear();
    const view = render(surface());
    expect(mocks.open).not.toHaveBeenCalled();

    onboardingReads.set("env-team", noOnboardingRead());
    view.rerender(surface());

    expect(mocks.open).toHaveBeenCalledWith({ botId: BOT_ID });
    expect(screen.getByTestId("stub-channel")).toBeTruthy();
  });

  it("opens nothing until bot.list names the bot's team", () => {
    mocks.state.listedBotIds = undefined;
    render(surface());

    expect(mocks.open).not.toHaveBeenCalled();
    expect(screen.queryByTestId("stub-channel")).toBeNull();
  });
});

describe("<BotTabSurface /> bot.open", () => {
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

  it("shows the full tab, unpaused and with no banner, when this host serves the bot", () => {
    const { container } = render(surface());

    expect(screen.getByTestId("bot-tab-title").textContent).toBe("Release Bot");
    expect(screen.getByTestId("stub-channel").getAttribute("data-paused")).toBe(
      "false",
    );
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

  it("labels the tab with the environment and nothing about a machine", () => {
    const { container } = render(surface());

    expect(screen.getByRole("banner").textContent).toContain("Acme");
    expectNoMachineWording(container);
  });
});

describe("<BotTabSurface /> another host serves the bot", () => {
  const SERVED_ELSEWHERE = answer({
    kind: "serve-on-bound-host",
    hostId: BOUND_HOST,
    why: "reachable",
  });

  it("moves the tab to that host silently when this client can dial it", () => {
    mocks.state.openResult = SERVED_ELSEWHERE;
    const { container } = render(surface());

    expect(tabHostIdInStore()).toBe(BOUND_HOST);
    // Until the surface remounts on the new host: a spinner, no banner.
    expect(screen.getByTestId("bot-tab-connecting")).toBeTruthy();
    expect(screen.queryByTestId("bot-tab-paused")).toBeNull();
    expect(screen.queryByTestId("stub-channel")).toBeNull();
    expectNoMachineWording(container);
  });

  it("moves it as well when another host claimed the bot while this one was deciding", () => {
    mocks.state.openResult = answer({
      kind: "serve-on-bound-host",
      hostId: BOUND_HOST,
      why: "claimed-concurrently",
    });
    render(surface());

    expect(tabHostIdInStore()).toBe(BOUND_HOST);
  });

  it("pauses on the opening host, with no move, when this client cannot dial that host", () => {
    mocks.state.openResult = SERVED_ELSEWHERE;
    mocks.state.connectable = { hostIds: [TAB_HOST], resolved: true };
    const { container } = render(surface());

    expect(tabHostIdInStore()).toBe(TAB_HOST);
    const banner = screen.getByTestId("bot-tab-paused");
    expect(banner.getAttribute("data-reason")).toBe("bound-host-not-dialable");
    expect(banner.textContent).toContain("Acme");
    expect(within(banner).queryByRole("button")).toBeNull();
    expect(screen.getByTestId("stub-channel").getAttribute("data-paused")).toBe(
      "true",
    );
    expect(
      screen.getByTestId("stub-channel").getAttribute("data-host-id"),
    ).toBe(TAB_HOST);
    expectNoMachineWording(container);
  });

  it("neither calls the host undialable nor moves the tab before the directory has answered", () => {
    mocks.state.openResult = SERVED_ELSEWHERE;
    mocks.state.connectable = { hostIds: [], resolved: false };
    render(surface());

    expect(screen.queryByTestId("bot-tab-paused")).toBeNull();
    expect(screen.getByTestId("bot-tab-connecting")).toBeTruthy();
    // Moving now could strand the tab on a host this client never reaches.
    expect(tabHostIdInStore()).toBe(TAB_HOST);
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
      text: "Paused: the computer this bot runs on is away, and this one doesn't run Acme's bots. Messages you send are delivered when it's back.",
      retry: false,
    },
    {
      reason: "bound-to-sandbox",
      text: "This bot's channel can't be shown here. Messages you send still reach it.",
      retry: false,
    },
    {
      reason: "bound-host-not-observable",
      text: "This bot's channel can't be shown here. Messages you send still reach it.",
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

  it("hands the channel view the paused flag, whose placeholder names no machine", () => {
    mocks.state.openResult = answer({
      kind: "paused",
      reason: "host-not-in-environment",
    });
    render(surface());

    expect(screen.getByTestId("stub-channel").getAttribute("data-paused")).toBe(
      "true",
    );
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

  it("hands the under-the-hood view the paused flag too", async () => {
    const user = userEvent.setup();
    mocks.state.openResult = answer({
      kind: "paused",
      reason: "bound-to-sandbox",
    });
    render(surface());

    await user.click(screen.getByTestId("bot-tab-view-under-the-hood"));
    expect(
      screen.getByTestId("stub-under-the-hood").getAttribute("data-paused"),
    ).toBe("true");
  });

  it("keeps Settings ungated: the panel is given the bot, whether it is main and whether it is personal, and no editing flag", async () => {
    const user = userEvent.setup();
    mocks.state.openResult = answer({
      kind: "paused",
      reason: "bound-host-not-observable",
    });
    render(surface());

    await user.click(screen.getByTestId("bot-tab-view-settings"));
    expect(
      screen.getByTestId("stub-settings").getAttribute("data-prop-names"),
    ).toBe("bot,isMain,personal");
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

      await user.click(screen.getByTestId("bot-tab-view-settings"));
      expect(
        screen.getByTestId("stub-settings").getAttribute("data-personal"),
      ).toBe(expected);
    },
  );

  it("treats the environment as not personal until the environment list names it", async () => {
    const user = userEvent.setup();
    mocks.state.environments = [
      { environmentId: "env-other", label: "Mine", ownerKind: "user" },
    ];
    render(surface());

    await user.click(screen.getByTestId("bot-tab-view-settings"));
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
    expect(screen.getByTestId("stub-channel").getAttribute("data-paused")).toBe(
      "false",
    );
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
  it("marks the header of the bot bot.list names as its environment's main bot", () => {
    mocks.state.listedBotIds = [BOT_ID, OTHER_BOT_ID];
    mocks.state.mainBotIds = { "env-team": BOT_ID };
    render(surface());

    expect(screen.getByTestId("bot-tab-main").textContent).toBe("Main");
  });

  it.each([
    ["another bot is main", { "env-team": OTHER_BOT_ID }],
    ["this bot is main only in another environment", { "env-other": BOT_ID }],
    ["the host predates the field", null],
  ])("leaves the header unmarked when %s", (_name, mainBotIds) => {
    mocks.state.listedBotIds = [BOT_ID, OTHER_BOT_ID];
    mocks.state.mainBotIds = mainBotIds;
    render(surface());

    expect(screen.queryByTestId("bot-tab-main")).toBeNull();
  });

  it("leaves the header unmarked until bot.list has answered", () => {
    render(surface());

    expect(screen.queryByTestId("bot-tab-main")).toBeNull();
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

      await user.click(screen.getByTestId("bot-tab-view-settings"));
      expect(
        screen.getByTestId("stub-settings").getAttribute("data-is-main"),
      ).toBe(expected);
    },
  );
});

describe("<BotTabSurface /> tab lifetime", () => {
  it("closes the tab when bot.list no longer carries the bot", () => {
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
