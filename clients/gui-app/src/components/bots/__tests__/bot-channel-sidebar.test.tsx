/**
 * The bot tab's sidebar (Tracy Bots, decision 41): every environment is a
 * section, every bot in it a `# name` channel, unread channels are marked, and
 * a section ends with "Add a bot" for that environment, and a team's section
 * opens with its onboarding, whose gate locks a new team's chat until its
 * GitHub set holds a repository. The real sidebar and the real onboarding
 * gate run over mocked reads and the real bot-tabs store; the create form,
 * the onboarding card and the navigation helper are stubs that record what
 * they were given.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotRecord } from "@traycer/protocol/host/bot/schemas";
import type { EnvironmentDescriptor } from "@traycer/protocol/host/environment/contracts";
import type { BotOnboardingReadResponse } from "@traycer/protocol/host/bot/onboarding-schemas";
import type { TabNavigationIntent } from "@/lib/tab-navigation/intents";

interface IndicatorState {
  unreadDone: boolean;
  unreadFailure: boolean;
}

const mocks = vi.hoisted(() => {
  const epics: Record<string, IndicatorState> = {};
  /** Each team environment's onboarding read, by environment id. */
  const onboarding: Record<string, BotOnboardingReadResponse> = {};
  return {
    client: { stub: "tab-host-client" },
    navigate: vi.fn(),
    navigateToTabIntent: vi.fn<(intent: unknown) => void>(),
    bindings: { stub: "environment-bindings" },
    state: {
      environments: [] as EnvironmentDescriptor[],
      bots: [] as BotRecord[],
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
vi.mock("@/hooks/bots/use-environment-list-query", () => ({
  useEnvironmentListQuery: () => ({
    data: { environments: mocks.state.environments },
  }),
}));
vi.mock("@/hooks/bots/use-bot-list-query", () => ({
  useBotListQuery: () => ({ data: { bots: mocks.state.bots } }),
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
vi.mock("@/components/home/bots/create-bot-form", () => ({
  CreateBotForm: (props: {
    environmentId: string;
    environmentLabel: string;
  }) => (
    <div
      data-testid="stub-create-bot-form"
      data-environment-id={props.environmentId}
      data-environment-label={props.environmentLabel}
    />
  ),
}));

vi.mock("@/components/home/bots/bot-onboarding-card", () => ({
  BotOnboardingCard: (props: { environmentId: string; teamName: string }) => (
    <div
      data-testid="stub-bot-onboarding-card"
      data-environment-id={props.environmentId}
      data-team-name={props.teamName}
    />
  ),
}));

import { BotChannelSidebar } from "@/components/bots/bot-channel-sidebar";
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
  render(<BotChannelSidebar activeBotId={activeBotId} hostId={TAB_HOST} />);
}

beforeEach(() => {
  vi.clearAllMocks();
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
  it("lists each environment as a section with its bots as # channels, an empty environment included", () => {
    mount("bot-release");

    const sections = screen.getAllByTestId("bot-channel-section");
    expect(sections.map((s) => s.getAttribute("data-environment-id"))).toEqual([
      "env-me",
      "env-team",
      "env-empty",
    ]);
    expect(
      within(section("env-team")).getByRole("button", { name: "Acme" }),
    ).toBeTruthy();
    expect(
      within(section("env-team"))
        .getAllByTestId("bot-channel-row")
        .map((r) => r.textContent),
    ).toEqual(["release-bot", "triage-bot"]);
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
      "bot-release": { unreadDone: false, unreadFailure: false },
      "bot-triage": { unreadDone: true, unreadFailure: false },
      "bot-notes": { unreadDone: false, unreadFailure: true },
    };
    mount("bot-release");

    expect(row("bot-triage").getAttribute("data-unread")).toBe("true");
    expect(row("bot-notes").getAttribute("data-unread")).toBe("true");
    expect(row("bot-release").getAttribute("data-unread")).toBe("false");
    expect(row("bot-release").getAttribute("aria-current")).toBe("page");
    expect(row("bot-triage").getAttribute("aria-current")).toBeNull();
    expect(row("bot-notes").getAttribute("aria-current")).toBeNull();
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

describe("<BotChannelSidebar /> Add a bot", () => {
  it("opens the create form for the environment of the section that was clicked", async () => {
    const user = userEvent.setup();
    mount("bot-release");
    expect(screen.queryByTestId("stub-create-bot-form")).toBeNull();

    await user.click(
      within(section("env-empty")).getByRole("button", { name: "Add a bot" }),
    );

    const form = screen.getByTestId("stub-create-bot-form");
    expect(form.getAttribute("data-environment-id")).toBe("env-empty");
    expect(form.getAttribute("data-environment-label")).toBe("Quiet team");
    expect(
      within(section("env-empty")).getByTestId("stub-create-bot-form"),
    ).toBe(form);
  });

  it("offers no form for bots of an environment the person is no longer in", () => {
    mocks.state.bots = [bot("bot-orphan", "env-left", "orphan-bot")];
    mount("bot-orphan");

    const orphan = section("env-left");
    expect(within(orphan).getByTestId("bot-channel-row")).toBeTruthy();
    expect(
      within(orphan).queryByRole("button", { name: "Add a bot" }),
    ).toBeNull();
  });
});

describe("<BotChannelSidebar /> team onboarding", () => {
  it("opens each team section with its onboarding, and no other section", async () => {
    const user = userEvent.setup();
    mocks.state.bots = [
      ...mocks.state.bots,
      bot("bot-orphan", "env-left", "orphan-bot"),
    ];
    mount("bot-release");

    const cards = screen.getAllByTestId("stub-bot-onboarding-card");
    expect(
      cards.map((card) => [
        card.getAttribute("data-environment-id"),
        card.getAttribute("data-team-name"),
      ]),
    ).toEqual([
      ["env-team", "Acme"],
      ["env-empty", "Quiet team"],
    ]);
    expect(
      within(section("env-team")).getByTestId("stub-bot-onboarding-card"),
    ).toBe(cards[0]);

    // A collapsed section hides it with the rest of its body.
    await user.click(
      within(section("env-team")).getByRole("button", { name: "Acme" }),
    );
    expect(
      within(section("env-team")).queryByTestId("stub-bot-onboarding-card"),
    ).toBeNull();
  });

  it("locks a new team's chat until its GitHub set holds a repository, leaving a team that pre-dates onboarding open", () => {
    mocks.state.onboarding = {
      "env-team": onboarding({ unlocked: false, chosen: false }),
      "env-empty": onboarding({ unlocked: false, chosen: false }),
    };
    mount("bot-release");

    // The new team (no bots, no record) offers no "Add a bot".
    expect(
      within(section("env-empty")).queryByRole("button", { name: "Add a bot" }),
    ).toBeNull();
    // A team with bots and no onboarding record pre-dates onboarding.
    expect(
      within(section("env-team")).getByRole("button", { name: "Add a bot" }),
    ).toBeTruthy();
    expect(row("bot-triage")).toHaveProperty("disabled", false);
    expect(
      within(section("env-me")).getByRole("button", { name: "Add a bot" }),
    ).toBeTruthy();

    cleanup();
    mocks.state.onboarding["env-empty"] = onboarding({
      unlocked: true,
      chosen: true,
    });
    mount("bot-release");
    expect(
      within(section("env-empty")).getByRole("button", { name: "Add a bot" }),
    ).toBeTruthy();
  });

  it("closes the channels of a team mid-onboarding whose set holds no repository, and offers no create", async () => {
    const user = userEvent.setup();
    mocks.state.onboarding["env-team"] = onboarding({
      unlocked: false,
      chosen: true,
    });
    mount("bot-notes");

    expect(
      within(section("env-team")).queryByRole("button", { name: "Add a bot" }),
    ).toBeNull();
    expect(row("bot-triage")).toHaveProperty("disabled", true);
    await user.click(row("bot-triage"));
    expect(mocks.navigateToTabIntent).not.toHaveBeenCalled();
  });
});
