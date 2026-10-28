/**
 * The bot tab's sidebar (Tracy Bots, decision 41): every environment is a
 * section, every bot in it an avatar and name channel, unread channels are
 * marked. The sections list channels only; every section the person can add
 * to carries a + (the personal one opens the create form) and an empty one a
 * call to action, both opening that section's setup (T59), a person in no
 * team is offered "Create a team", and the gate that
 * locks a new team's chat until its GitHub set holds a repository still
 * disables its rows. The real sidebar, the real setup dialog and the real
 * onboarding gate run over mocked reads and the real bot-tabs store; the
 * onboarding steps, the create form and the navigation helper are stubs, so
 * the dialog's focus on closing is read off the real thing.
 */
import {
  QueryClient,
  QueryClientProvider,
  queryOptions,
} from "@tanstack/react-query";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotRecord } from "@traycer/protocol/host/bot/schemas";
import type { EnvironmentDescriptor } from "@traycer/protocol/host/environment/contracts";
import type { BotOnboardingReadResponse } from "@traycer/protocol/host/bot/onboarding-schemas";
import type { TabNavigationIntent } from "@/lib/tab-navigation/intents";

interface IndicatorState {
  unreadDone: boolean;
  unreadFailure: boolean;
  unreadCount: number | null;
}

const mocks = vi.hoisted(() => {
  const epics: Record<string, IndicatorState> = {};
  /** Each team environment's onboarding read, by environment id. */
  const onboarding: Record<string, BotOnboardingReadResponse> = {};
  return {
    client: { stub: "tab-host-client" },
    navigate: vi.fn(),
    openLink: vi.fn<(url: string, kind: string) => Promise<void>>(),
    hasShell: true,
    navigateToTabIntent: vi.fn<(intent: unknown) => void>(),
    bindings: { stub: "environment-bindings" },
    state: {
      environments: [] as EnvironmentDescriptor[],
      bots: [] as BotRecord[],
      mainBotIds: null as Record<string, string> | null,
      connectable: { hostIds: [] as string[], resolved: true },
      epics,
      onboarding,
    },
  };
});

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
}));
vi.mock("@/lib/tab-navigation", () => ({
  navigateToTabIntent: (
    _navigate: unknown,
    intent: TabNavigationIntent,
    _extra: unknown,
  ) => mocks.navigateToTabIntent(intent),
}));
vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHostOrNull: () =>
    mocks.hasShell ? { signInUrl: "https://platform.traycer.ai" } : null,
}));
vi.mock("@/lib/links/open-link", () => ({
  useOpenLink: () => mocks.openLink,
}));
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => mocks.client,
}));
vi.mock("@/components/epic-canvas/hooks/use-tab-host-id", () => ({
  useTabHostId: () => "host-tab",
}));
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostSupportsMethod: () => true,
}));
vi.mock("@/hooks/bots/use-bot-onboarding-query", () => ({
  useBotOnboardingQuery: (
    _client: unknown,
    environmentId: string,
    enabled: boolean,
  ) => {
    const data = enabled ? mocks.state.onboarding[environmentId] : undefined;
    return { status: data === undefined ? "pending" : "success", data };
  },
}));
// A real query over the host's `environment.list`, which answers whatever the
// test last set; `mount` seeds it, so the first render is synchronous.
vi.mock("@/hooks/bots/use-environment-list-query", async () => {
  const { queryOptions, useQuery } = await import("@tanstack/react-query");
  const { hostQueryKeys } = await import("@/lib/query-keys/host-query-keys");
  return {
    useEnvironmentListQuery: () =>
      useQuery(
        queryOptions({
          queryKey: [
            ...hostQueryKeys.methodScope("host-tab", "environment.list"),
            {},
          ],
          queryFn: () =>
            Promise.resolve({ environments: mocks.state.environments }),
          staleTime: Infinity,
        }),
      ),
  };
});
vi.mock("@/hooks/bots/use-bot-list-query", () => ({
  useBotListQuery: () => ({
    data: { bots: mocks.state.bots, mainBotIds: mocks.state.mainBotIds },
  }),
}));
vi.mock("@/hooks/host/use-connectable-host-ids", () => ({
  useConnectableHostIds: () => mocks.state.connectable,
}));
vi.mock("@/hooks/bots/use-host-environment-bindings-query", () => ({
  useHostEnvironmentBindings: () => mocks.bindings,
}));
vi.mock("@/hooks/notifications/use-notification-indicators-query", () => ({
  useNotificationIndicators: () => ({ epics: mocks.state.epics, chats: {} }),
}));
vi.mock("@/components/home/bots/bot-onboarding-card", () => ({
  BotOnboardingCard: (props: { environmentId: string; teamName: string }) => (
    <div
      data-testid="stub-bot-onboarding-card"
      data-environment-id={props.environmentId}
      data-team-name={props.teamName}
    />
  ),
  GithubStep: () => <div data-testid="stub-github-step" />,
  BotsStep: () => <div data-testid="stub-bots-step" />,
  OnboardingCreateControls: () => null,
  OnboardingOpenButton: () => null,
}));
vi.mock("@/components/home/bots/use-team-onboarding-flow", () => ({
  useTeamOnboardingFlow: () => ({}),
}));
vi.mock("@/components/home/bots/create-bot-form", () => ({
  CreateBotForm: (props: { environmentId: string }) => (
    <div
      data-testid="stub-create-bot-form"
      data-environment-id={props.environmentId}
    />
  ),
}));

import { BotChannelSidebar } from "@/components/bots/bot-channel-sidebar";
import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";
import { lookupBotTab, useBotTabsStore } from "@/stores/bots/bot-tabs-store";

const TAB_HOST = "host-tab";
const OTHER_HOST = "host-other";

function bot(botId: string, environmentId: string, title: string): BotRecord {
  return {
    botId,
    environmentId,
    createdByUserId: "user-1",
    title,
    harness: "claude",
    model: "opus",
    effort: null,
    profile: null,
    directive: null,
    replyMode: "thread",
    appConversationChatId: null,
    trunkChatId: `trunk-${botId}`,
    boundHostId: null,
    hostEpoch: 0,
    createdAt: 1_000,
    archivedAt: null,
  };
}

function environment(
  environmentId: string,
  label: string,
  ownerKind: EnvironmentDescriptor["ownerKind"],
): EnvironmentDescriptor {
  return {
    environmentId,
    ownerKind,
    ownerId: `owner-${environmentId}`,
    roomId: `room-${environmentId}`,
    label,
  };
}

function onboarding(input: {
  readonly unlocked: boolean;
  readonly chosen: boolean;
}): BotOnboardingReadResponse {
  return {
    github: {
      state: "ok",
      installingAdmin: null,
      repositories: input.unlocked
        ? [{ repositoryId: "1", fullName: "acme/web", permission: "write" }]
        : [],
      callerCanConnect: false,
    },
    unlocked: input.unlocked,
    choice: input.chosen
      ? { areas: ["flaky-tests"], chosenAt: 1, completedAt: null, pending: [] }
      : null,
    catalog: [],
  };
}

function section(environmentId: string): HTMLElement {
  const found = screen
    .getAllByTestId("bot-channel-section")
    .find(
      (element) =>
        element.getAttribute("data-environment-id") === environmentId,
    );
  if (found === undefined) throw new Error(`no section for ${environmentId}`);
  return found;
}

function row(botId: string): HTMLElement {
  const found = screen
    .getAllByTestId("bot-channel-row")
    .find((element) => element.getAttribute("data-bot-id") === botId);
  if (found === undefined) throw new Error(`no row for ${botId}`);
  return found;
}

function mount(activeBotId: string): void {
  const queryClient = new QueryClient();
  const seeded = queryOptions({
    queryKey: [...hostQueryKeys.methodScope(TAB_HOST, "environment.list"), {}],
    queryFn: () => Promise.resolve({ environments: mocks.state.environments }),
  });
  queryClient.setQueryData(seeded.queryKey, {
    environments: mocks.state.environments,
  });
  render(
    <QueryClientProvider client={queryClient}>
      <BotChannelSidebar activeBotId={activeBotId} hostId={TAB_HOST} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.hasShell = true;
  mocks.openLink.mockResolvedValue(undefined);
  mocks.state.environments = [
    environment("env-me", "Personal", "user"),
    environment("env-team", "Acme", "organization"),
    environment("env-empty", "Quiet team", "organization"),
  ];
  mocks.state.bots = [
    bot("bot-release", "env-team", "release-bot"),
    bot("bot-triage", "env-team", "triage-bot"),
    bot("bot-notes", "env-me", "notes-bot"),
  ];
  mocks.state.mainBotIds = null;
  mocks.state.connectable = { hostIds: [TAB_HOST, OTHER_HOST], resolved: true };
  mocks.state.epics = {};
  // Both teams read as onboarded, so only the onboarding cases lock.
  mocks.state.onboarding = {
    "env-team": onboarding({ unlocked: true, chosen: false }),
    "env-empty": onboarding({ unlocked: true, chosen: false }),
  };
  useBotTabsStore.setState({ tabs: {} });
});

afterEach(() => {
  cleanup();
});

describe("<BotChannelSidebar /> sections", () => {
  it("lists each environment as a section with its bots as avatar and name channels, an empty environment included", () => {
    mount("bot-release");

    const sections = screen.getAllByTestId("bot-channel-section");
    expect(sections.map((s) => s.getAttribute("data-environment-id"))).toEqual([
      "env-me",
      "env-team",
      "env-empty",
    ]);
    // A section's header is its name and its +, with nothing to fold.
    expect(within(section("env-team")).getByText("Acme")).toBeTruthy();
    expect(
      screen
        .getByTestId("bot-channel-sidebar")
        .querySelectorAll("[aria-expanded]"),
    ).toHaveLength(0);
    expect(
      within(section("env-team"))
        .getAllByTestId("bot-channel-row")
        .map((r) => r.textContent),
    ).toEqual(["RErelease-bot", "TRtriage-bot"]);
    expect(
      within(section("env-team")).getAllByTestId("bot-avatar"),
    ).toHaveLength(2);
    expect(section("env-team").textContent).not.toContain("#");
    expect(
      within(section("env-me"))
        .getAllByTestId("bot-channel-row")
        .map((r) => r.getAttribute("data-bot-id")),
    ).toEqual(["bot-notes"]);
    expect(
      within(section("env-empty")).queryAllByTestId("bot-channel-row"),
    ).toHaveLength(0);
  });

  it("marks a channel with an unread reply, and the one in view as the current page", () => {
    mocks.state.epics = {
      "bot-release": {
        unreadDone: false,
        unreadFailure: false,
        unreadCount: 0,
      },
      "bot-triage": { unreadDone: true, unreadFailure: false, unreadCount: 1 },
      "bot-notes": { unreadDone: false, unreadFailure: true, unreadCount: 1 },
    };
    mount("bot-release");

    expect(row("bot-triage").getAttribute("data-unread")).toBe("true");
    expect(row("bot-notes").getAttribute("data-unread")).toBe("true");
    expect(row("bot-release").getAttribute("data-unread")).toBe("false");
    expect(row("bot-release").getAttribute("aria-current")).toBe("page");
    expect(row("bot-triage").getAttribute("aria-current")).toBeNull();
    expect(row("bot-notes").getAttribute("aria-current")).toBeNull();
  });

  it("counts a channel's unread notifications at the end of its row, and draws nothing at zero or where the host does not count", () => {
    mocks.state.epics = {
      "bot-release": {
        unreadDone: false,
        unreadFailure: false,
        unreadCount: 0,
      },
      "bot-triage": { unreadDone: true, unreadFailure: false, unreadCount: 3 },
      "bot-notes": {
        unreadDone: true,
        unreadFailure: false,
        unreadCount: null,
      },
    };
    mount("bot-release");

    expect(
      within(
        within(row("bot-triage")).getByTestId("bot-channel-row-unread-count"),
      ).getByText("3"),
    ).toBeTruthy();
    expect(row("bot-triage").getAttribute("data-unread")).toBe("true");
    expect(
      within(row("bot-release")).queryByTestId("bot-channel-row-unread-count"),
    ).toBeNull();
    expect(
      within(row("bot-notes")).queryByTestId("bot-channel-row-unread-count"),
    ).toBeNull();
    expect(row("bot-notes").getAttribute("data-unread")).toBe("true");
  });
});

describe("<BotChannelSidebar /> main bot", () => {
  it("stars the environment's main bot after its name and no other channel", () => {
    mocks.state.mainBotIds = { "env-team": "bot-triage" };
    mount("bot-release");

    const star = within(row("bot-triage")).getByRole("img", {
      name: "Main bot",
    });
    expect(star.parentElement?.previousElementSibling?.textContent).toBe(
      "triage-bot",
    );
    expect(star.getAttribute("class")).toContain("text-muted-foreground");
    expect(
      within(row("bot-release")).queryByRole("img", { name: "Main bot" }),
    ).toBeNull();
    expect(
      within(row("bot-notes")).queryByRole("img", { name: "Main bot" }),
    ).toBeNull();
  });

  it("draws the main bot's star before its unread count, which ends the row", () => {
    mocks.state.mainBotIds = { "env-team": "bot-triage" };
    mocks.state.epics = {
      "bot-triage": { unreadDone: true, unreadFailure: false, unreadCount: 2 },
    };
    mount("bot-release");

    const star = within(row("bot-triage")).getByRole("img", {
      name: "Main bot",
    });
    const count = within(row("bot-triage")).getByTestId(
      "bot-channel-row-unread-count",
    );
    expect(
      star.compareDocumentPosition(count) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(row("bot-triage").lastElementChild).toBe(count);
  });

  it("draws the main bot's star in its row's own colour while its channel is in view", () => {
    mocks.state.mainBotIds = { "env-team": "bot-triage" };
    mount("bot-triage");

    const star = within(row("bot-triage")).getByRole("img", {
      name: "Main bot",
    });
    expect(row("bot-triage").getAttribute("class")).toContain(
      "text-primary-foreground",
    );
    expect(star.getAttribute("class")).toContain("text-current");
    expect(star.getAttribute("class")).not.toContain("text-muted-foreground");
  });

  it("stars no channel when the host's list names no main bots", () => {
    mount("bot-release");

    expect(screen.queryByRole("img", { name: "Main bot" })).toBeNull();
  });
});

describe("<BotChannelSidebar /> opening a channel", () => {
  it("opens the other bot's tab on the sidebar's host and navigates to it", async () => {
    const user = userEvent.setup();
    mount("bot-release");

    await user.click(row("bot-triage"));

    const opened = lookupBotTab(useBotTabsStore.getState().tabs, "bot-triage");
    expect(opened).toMatchObject({
      botId: "bot-triage",
      hostId: TAB_HOST,
      title: "triage-bot",
    });
    expect(mocks.navigateToTabIntent).toHaveBeenCalledTimes(1);
    expect(mocks.navigateToTabIntent).toHaveBeenCalledWith({
      kind: "bot",
      botId: "bot-triage",
    });
  });

  it("does nothing when the channel in view is clicked", async () => {
    const user = userEvent.setup();
    mount("bot-release");

    await user.click(row("bot-release"));

    expect(useBotTabsStore.getState().tabs).toEqual({});
    expect(mocks.navigateToTabIntent).not.toHaveBeenCalled();
  });

  it("keeps an open tab on its own host while this client can still dial it", async () => {
    const user = userEvent.setup();
    useBotTabsStore.getState().openBotTab({
      botId: "bot-triage",
      hostId: OTHER_HOST,
      title: "triage-bot",
    });
    mount("bot-release");

    await user.click(row("bot-triage"));

    expect(
      lookupBotTab(useBotTabsStore.getState().tabs, "bot-triage")?.hostId,
    ).toBe(OTHER_HOST);
    expect(mocks.navigateToTabIntent).toHaveBeenCalledTimes(1);
  });

  it("moves an open tab onto the sidebar's host when its host can no longer be dialled", async () => {
    const user = userEvent.setup();
    useBotTabsStore.getState().openBotTab({
      botId: "bot-triage",
      hostId: "host-gone",
      title: "triage-bot",
    });
    mount("bot-release");

    await user.click(row("bot-triage"));

    expect(
      lookupBotTab(useBotTabsStore.getState().tabs, "bot-triage")?.hostId,
    ).toBe(TAB_HOST);
    expect(mocks.navigateToTabIntent).toHaveBeenCalledTimes(1);
  });
});

describe("<BotChannelSidebar /> team setup", () => {
  it("draws a + on each section the person can add to and on no other", () => {
    mocks.state.bots = [
      ...mocks.state.bots,
      bot("bot-orphan", "env-left", "orphan-bot"),
    ];
    mount("bot-release");

    expect(
      within(section("env-team")).getByRole("button", {
        name: "Set up Acme's bots",
      }),
    ).toBeTruthy();
    expect(
      within(section("env-empty")).getByRole("button", {
        name: "Set up Quiet team's bots",
      }),
    ).toBeTruthy();
    expect(
      within(section("env-me")).getByRole("button", { name: "New bot" }),
    ).toBeTruthy();
    // An environment the person is no longer in has no team to set up.
    expect(
      within(section("env-left")).queryByTestId("bot-channel-section-add"),
    ).toBeNull();
    expect(screen.getAllByTestId("bot-channel-section-add")).toHaveLength(3);
  });

  it("gives a team with no bots one call to action, and a team with bots none", () => {
    mocks.state.bots = [
      ...mocks.state.bots,
      bot("bot-orphan", "env-left", "orphan-bot"),
    ];
    mount("bot-release");

    expect(
      within(section("env-empty")).getByTestId("bot-channel-section-set-up")
        .textContent,
    ).toBe("Set up your team's bots");
    expect(screen.getAllByTestId("bot-channel-section-set-up")).toHaveLength(1);
  });

  it("gives an empty personal section a New bot row, and opens the create form for the personal environment from the + and the row", async () => {
    const user = userEvent.setup();
    mocks.state.bots = mocks.state.bots.filter(
      (b) => b.environmentId !== "env-me",
    );
    mount("bot-release");

    expect(
      within(section("env-me")).getByTestId("bot-channel-section-set-up")
        .textContent,
    ).toBe("New bot");

    await user.click(
      within(section("env-me")).getByTestId("bot-channel-section-add"),
    );
    const fromPlus = screen.getByTestId("team-bot-setup-dialog");
    expect(within(fromPlus).getByText("New bot")).toBeTruthy();
    expect(
      within(fromPlus)
        .getByTestId("stub-create-bot-form")
        .getAttribute("data-environment-id"),
    ).toBe("env-me");
    expect(screen.queryByTestId("stub-bots-step")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Close" }));
    await user.click(
      within(section("env-me")).getByTestId("bot-channel-section-set-up"),
    );
    expect(
      within(screen.getByTestId("team-bot-setup-dialog"))
        .getByTestId("stub-create-bot-form")
        .getAttribute("data-environment-id"),
    ).toBe("env-me");
  });

  it("opens the setup for the team of the + or the call to action that was clicked", async () => {
    const user = userEvent.setup();
    mount("bot-release");
    expect(screen.queryByTestId("team-bot-setup-dialog")).toBeNull();

    await user.click(
      within(section("env-team")).getByTestId("bot-channel-section-add"),
    );
    // A team with bots and no onboarding record gets the create form.
    const fromPlus = screen.getByTestId("team-bot-setup-dialog");
    expect(within(fromPlus).getByText("Add a bot to Acme")).toBeTruthy();
    expect(
      within(fromPlus)
        .getByTestId("stub-create-bot-form")
        .getAttribute("data-environment-id"),
    ).toBe("env-team");

    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByTestId("team-bot-setup-dialog")).toBeNull();

    await user.click(
      within(section("env-empty")).getByTestId("bot-channel-section-set-up"),
    );
    // A team with no bots walks its onboarding.
    const fromCta = screen.getByTestId("team-bot-setup-dialog");
    expect(within(fromCta).getByText("Set up Quiet team's bots")).toBeTruthy();
    expect(within(fromCta).getByTestId("stub-bots-step")).toBeTruthy();
  });

  it.each([
    {
      label: "the + on a team's header, on Escape",
      opener: () =>
        within(section("env-team")).getByTestId("bot-channel-section-add"),
      dismiss: (user: UserEvent) => user.keyboard("{Escape}"),
    },
    {
      label: "the empty team's call to action, on the Close button",
      opener: () =>
        within(section("env-empty")).getByTestId("bot-channel-section-set-up"),
      dismiss: (user: UserEvent) =>
        user.click(screen.getByRole("button", { name: "Close" })),
    },
  ])("gives focus back to $label", async ({ opener, dismiss }) => {
    const user = userEvent.setup();
    mount("bot-release");
    const control = opener();
    await user.click(control);
    await screen.findByTestId("team-bot-setup-dialog");

    await dismiss(user);

    await waitFor(() => {
      expect(screen.queryByTestId("team-bot-setup-dialog")).toBeNull();
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(control);
    });
  });

  it("draws no onboarding card or form in any section, a new team's included", () => {
    mocks.state.onboarding = {
      "env-team": onboarding({ unlocked: false, chosen: true }),
      "env-empty": onboarding({ unlocked: false, chosen: false }),
    };
    mount("bot-release");

    expect(screen.queryAllByTestId("stub-bot-onboarding-card")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Add a bot" })).toBeNull();
  });
});

describe("<BotChannelSidebar /> team onboarding", () => {
  it("leaves the channels of a team that pre-dates onboarding open", async () => {
    const user = userEvent.setup();
    // A team with bots and no onboarding record pre-dates onboarding.
    mocks.state.onboarding = {
      "env-team": onboarding({ unlocked: false, chosen: false }),
      "env-empty": onboarding({ unlocked: false, chosen: false }),
    };
    mount("bot-release");

    expect(row("bot-triage")).toHaveProperty("disabled", false);
    await user.click(row("bot-triage"));
    expect(mocks.navigateToTabIntent).toHaveBeenCalledTimes(1);
  });

  it("closes the channels of a team mid-onboarding whose set holds no repository, leaving the + as the way in", async () => {
    const user = userEvent.setup();
    mocks.state.onboarding["env-team"] = onboarding({
      unlocked: false,
      chosen: true,
    });
    mount("bot-notes");

    expect(row("bot-triage")).toHaveProperty("disabled", true);
    await user.click(row("bot-triage"));
    expect(mocks.navigateToTabIntent).not.toHaveBeenCalled();
    expect(
      within(section("env-team")).getByTestId("bot-channel-section-add"),
    ).toBeTruthy();
  });
});

describe("<BotChannelSidebar /> create a team", () => {
  it("offers Create a team to a person in no team, opening the dashboard's create-team page", async () => {
    const user = userEvent.setup();
    mocks.state.environments = [environment("env-me", "Personal", "user")];
    mount("bot-notes");

    await user.click(screen.getByTestId("bot-channel-create-team"));

    expect(mocks.openLink).toHaveBeenCalledTimes(1);
    expect(mocks.openLink.mock.calls[0]?.[0]).toBe(
      "https://platform.traycer.ai/settings?create-team=1",
    );
    expect(mocks.openLink.mock.calls[0]?.[1]).toBe("account");
  });

  it("re-reads the environment list when the window regains focus, so a team made on the dashboard replaces Create a team", async () => {
    mocks.state.environments = [environment("env-me", "Personal", "user")];
    mocks.state.bots = [];
    mount("bot-notes");
    expect(screen.getByTestId("bot-channel-create-team")).toBeTruthy();
    expect(screen.queryAllByTestId("bot-channel-section")).toHaveLength(1);

    mocks.state.environments = [
      environment("env-me", "Personal", "user"),
      environment("env-team", "Acme", "organization"),
    ];
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    await waitFor(() => {
      expect(screen.queryByTestId("bot-channel-create-team")).toBeNull();
    });
    expect(within(section("env-team")).getByText("Acme")).toBeTruthy();
  });

  it("draws nothing when a team environment is present, or when there is no shell to open it", () => {
    mount("bot-release");
    expect(screen.queryByTestId("bot-channel-create-team")).toBeNull();
    cleanup();

    mocks.state.environments = [environment("env-me", "Personal", "user")];
    mocks.hasShell = false;
    mount("bot-notes");
    expect(screen.queryByTestId("bot-channel-create-team")).toBeNull();
  });
});
