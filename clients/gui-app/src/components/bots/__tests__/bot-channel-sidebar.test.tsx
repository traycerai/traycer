/**
 * The bot tab's sidebar (Tracy Bots, decision 41): every environment is a
 * section, every bot in it a `# name` channel, unread channels are marked. The
 * sections list channels only; a team's header carries a + and an empty team
 * a call to action, both opening that team's setup (T59), and the gate that
 * locks a new team's chat until its GitHub set holds a repository still
 * disables its rows. The real sidebar and the real onboarding gate run over
 * mocked reads and the real bot-tabs store; the setup dialog, the onboarding
 * card and the navigation helper are stubs that record what they were given.
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
vi.mock("@/components/bots/team-bot-setup-dialog", () => ({
  TeamBotSetupDialog: (props: {
    team: {
      environmentId: string;
      teamName: string;
      botCount: number;
    } | null;
    onClose: () => void;
  }) =>
    props.team === null ? null : (
      <div
        data-testid="stub-team-bot-setup-dialog"
        data-environment-id={props.team.environmentId}
        data-team-name={props.team.teamName}
        data-bot-count={String(props.team.botCount)}
      >
        <button type="button" onClick={props.onClose}>
          Close setup
        </button>
      </div>
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

describe("<BotChannelSidebar /> team setup", () => {
  it("draws a + on each team section and on no other", () => {
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
      within(section("env-me")).queryByTestId("bot-channel-section-add"),
    ).toBeNull();
    // An environment the person is no longer in has no team to set up.
    expect(
      within(section("env-left")).queryByTestId("bot-channel-section-add"),
    ).toBeNull();
    expect(screen.getAllByTestId("bot-channel-section-add")).toHaveLength(2);
  });

  it("gives a team with no bots one call to action, and a team with bots none", async () => {
    const user = userEvent.setup();
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

    // A collapsed section hides it with the rest of its body.
    await user.click(
      within(section("env-empty")).getByRole("button", {
        name: "Quiet team",
      }),
    );
    expect(screen.queryByTestId("bot-channel-section-set-up")).toBeNull();
  });

  it("opens the setup for the team of the + or the call to action that was clicked", async () => {
    const user = userEvent.setup();
    mount("bot-release");
    expect(screen.queryByTestId("stub-team-bot-setup-dialog")).toBeNull();

    await user.click(
      within(section("env-team")).getByTestId("bot-channel-section-add"),
    );
    const fromPlus = screen.getByTestId("stub-team-bot-setup-dialog");
    expect(fromPlus.getAttribute("data-environment-id")).toBe("env-team");
    expect(fromPlus.getAttribute("data-team-name")).toBe("Acme");
    expect(fromPlus.getAttribute("data-bot-count")).toBe("2");

    await user.click(screen.getByRole("button", { name: "Close setup" }));
    expect(screen.queryByTestId("stub-team-bot-setup-dialog")).toBeNull();

    await user.click(
      within(section("env-empty")).getByTestId("bot-channel-section-set-up"),
    );
    const fromCta = screen.getByTestId("stub-team-bot-setup-dialog");
    expect(fromCta.getAttribute("data-environment-id")).toBe("env-empty");
    expect(fromCta.getAttribute("data-team-name")).toBe("Quiet team");
    expect(fromCta.getAttribute("data-bot-count")).toBe("0");
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
