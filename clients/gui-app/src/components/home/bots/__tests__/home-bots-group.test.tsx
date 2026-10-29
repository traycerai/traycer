/**
 * Where Home's "Created by" rules meet (Tracy Bots): the group card asks
 * the member directory only for a TEAM environment and only when the band's
 * host answers `environment.members`, and hands each row the label built
 * from the signed-in viewer and that directory.
 *
 * The card and its rows are real: each row is found by its button's
 * accessible name and its attribution read from what it renders; the
 * directory hook and the hooks a row reads its live state from are stubs.
 * A team the person can add to offers "New bot" at once, whether or not it has
 * a bot yet (T67: nothing locks a new team's entry).
 */
import { StrictMode } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotRecord } from "@traycer/protocol/host/bot/schemas";
import { HomeBotsGroupCard } from "@/components/home/bots/home-bots-group";
import type { HomeBotsGroup } from "@/lib/home-bots/bots-model";
import { botTabIntent } from "@/lib/tab-navigation/intents";
import type { TeamSetup } from "@/hooks/bots/use-team-setups";
import { useAuthStore } from "@/stores/auth/auth-store";
import { lookupBotTab, useBotTabsStore } from "@/stores/bots/bot-tabs-store";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  navigateToTabIntent: vi.fn(),
  supported: true as boolean | null,
  supportQueries: [] as Array<{ hostId: string | null; method: string }>,
  memberQueries: [] as Array<{
    environmentId: string | null;
    enabled: boolean;
  }>,
}));

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: (hostId: string | null, method: string) => {
    mocks.supportQueries.push({ hostId, method });
    return mocks.supported;
  },
  useHostSupportsMethod: () => true,
}));
// The directory knows one teammate by name, and answers only when asked.
vi.mock("@/hooks/bots/use-environment-members-query", () => ({
  useEnvironmentMembers: (
    _client: unknown,
    environmentId: string | null,
    enabled: boolean,
  ) => {
    mocks.memberQueries.push({ environmentId, enabled });
    return (userId: string) =>
      enabled && userId === "user-teammate"
        ? { displayName: "Tess Teammate", avatarUrl: null }
        : null;
  },
}));
// What a row reads its live state through; nothing here shapes attribution.
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
}));
vi.mock("@/lib/tab-navigation", () => ({
  navigateToTabIntent: mocks.navigateToTabIntent,
}));
vi.mock("@/hooks/host/use-effective-host-id", () => ({
  useEffectiveHostId: () => "host-band",
}));
vi.mock("@/hooks/bots/use-bot-subscription", () => ({
  useBotSubscription: () => ({
    snapshot: null,
    deleted: false,
    error: null,
    isPending: false,
    resubscribe: vi.fn(),
  }),
}));
vi.mock("@/stores/agent-activity-store", () => ({
  useEpicAgentActivity: () => ({ working: new Set<string>() }),
}));
vi.mock("@/components/home/bots/create-bot-form", () => ({
  CreateBotForm: () => null,
}));

const HOST = "host-band";
const VIEWER = "user-viewer";

function bot(botId: string, createdByUserId: string | null): BotRecord {
  return {
    botId,
    environmentId: "env-1",
    createdByUserId,
    title: botId,
    harness: "claude",
    model: "opus",
    effort: null,
    profile: null,
    trunkChatId: `trunk-${botId}`,
    boundHostId: null,
    hostEpoch: 1,
    createdAt: 1_000,
    archivedAt: null,
    directive: null,
    replyMode: "thread",
    appConversationChatId: null,
  };
}

function group(
  ownerKind: HomeBotsGroup["ownerKind"],
  mainBotId: string | null,
): HomeBotsGroup {
  return {
    environmentId: "env-1",
    label: ownerKind === "organization" ? "acme" : "Personal",
    ownerKind,
    canCreate: false,
    bots: [
      bot("bot-mine", VIEWER),
      bot("bot-teammate", "user-teammate"),
      bot("bot-stranger", "user-stranger"),
    ],
    mainBotId,
  };
}

function mountCard(
  ownerKind: HomeBotsGroup["ownerKind"],
  mainBotId: string | null,
): void {
  render(
    <StrictMode>
      <HomeBotsGroupCard
        group={group(ownerKind, mainBotId)}
        hostReach={{
          directoryHostIds: new Set(),
          connectableHostIds: new Set(),
          connectableResolved: true,
          personalHostIds: null,
        }}
        environmentHostIds={null}
        connectableHostIds={[]}
        environmentBindings={{
          byHostId: new Map(),
          failedHostIds: [],
          retryFailed: () => undefined,
        }}
        client={null}
        hostId={HOST}
        setup={null}
      />
    </StrictMode>,
  );
}

const BOT_IDS = ["bot-mine", "bot-teammate", "bot-stranger"] as const;

/**
 * Each row's attribution as the row renders it: the text of its "Created by"
 * line, or "none" when it shows none. Rows are found by their button's
 * accessible name.
 */
function createdBy(): Record<string, string> {
  return Object.fromEntries(
    BOT_IDS.map((botId) => {
      const row = screen.getByRole("button", { name: new RegExp(`^${botId}`) });
      return [
        botId,
        within(row).queryByTestId("home-bot-created-by")?.textContent ?? "none",
      ];
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  useBotTabsStore.setState({ tabs: {} });
  mocks.supported = true;
  mocks.supportQueries.length = 0;
  mocks.memberQueries.length = 0;
  useAuthStore.setState({
    profile: { userId: VIEWER, userName: "Viewer", email: "v@example.com" },
  });
});

afterEach(() => {
  cleanup();
  useAuthStore.setState({ profile: null });
});

describe("<HomeBotsGroupCard /> attribution", () => {
  it("names who made each team bot from the team's directory, asked of the band's host", () => {
    mountCard("organization", null);

    expect(mocks.supportQueries).toContainEqual({
      hostId: HOST,
      method: "environment.members",
    });
    expect(mocks.memberQueries).toContainEqual({
      environmentId: "env-1",
      enabled: true,
    });
    expect(createdBy()).toEqual({
      "bot-mine": "Created by you",
      "bot-teammate": "Created by Tess Teammate",
      "bot-stranger": "none",
    });
  });

  it("asks no directory and says nothing for a personal environment's bots", () => {
    mountCard("user", null);

    expect(mocks.memberQueries.every((query) => !query.enabled)).toBe(true);
    expect(
      mocks.memberQueries.every((query) => query.environmentId === null),
    ).toBe(true);
    expect(createdBy()).toEqual({
      "bot-mine": "none",
      "bot-teammate": "none",
      "bot-stranger": "none",
    });
  });

  it("keeps the viewer's own line but names no teammate on a host without environment.members", () => {
    mocks.supported = false;
    mountCard("organization", null);

    expect(mocks.memberQueries.every((query) => !query.enabled)).toBe(true);
    expect(createdBy()).toEqual({
      "bot-mine": "Created by you",
      "bot-teammate": "none",
      "bot-stranger": "none",
    });
  });
});

describe("<HomeBotsGroupCard /> main bot", () => {
  function mainBadgeOwners(): ReadonlyArray<string> {
    return BOT_IDS.filter((botId) => {
      const row = screen.getByRole("button", { name: new RegExp(`^${botId}`) });
      return within(row).queryByTestId("home-bot-main") !== null;
    });
  }

  it("marks only the main bot's row", () => {
    mountCard("organization", "bot-teammate");

    expect(mainBadgeOwners()).toEqual(["bot-teammate"]);
    expect(screen.getAllByRole("img", { name: "Main bot" })).toHaveLength(1);
  });

  it("marks no row when the group names no main bot", () => {
    mountCard("organization", null);

    expect(mainBadgeOwners()).toEqual([]);
  });
});

describe("<HomeBotsGroupCard /> adding a bot", () => {
  it("offers a team with no bot yet a New bot, with nothing locking it", () => {
    render(
      <HomeBotsGroupCard
        group={{ ...group("organization", null), canCreate: true, bots: [] }}
        hostReach={{
          directoryHostIds: new Set(),
          connectableHostIds: new Set(),
          connectableResolved: true,
          personalHostIds: null,
        }}
        environmentHostIds={null}
        connectableHostIds={[]}
        environmentBindings={{
          byHostId: new Map(),
          failedHostIds: [],
          retryFailed: () => undefined,
        }}
        client={null}
        hostId={HOST}
        setup={null}
      />,
    );

    expect(screen.getByTestId("home-bots-create-toggle")).toBeTruthy();
  });
});

/**
 * A creatable team with no live bot whose main bot is still to be set up: its
 * card shows that bot, needing a host, in place of "No bots here yet.", and
 * opens the bot's tab on the band's host.
 */
describe("<HomeBotsGroupCard /> a team's main bot still to be set up", () => {
  const SETUP: TeamSetup = {
    environmentId: "env-1",
    teamName: "acme",
    botId: "bot-tracy-env",
    title: "Tracy",
  };

  function mountBotlessTeam(setup: TeamSetup | null): void {
    render(
      <HomeBotsGroupCard
        group={{ ...group("organization", null), canCreate: true, bots: [] }}
        hostReach={{
          directoryHostIds: new Set(),
          connectableHostIds: new Set(),
          connectableResolved: true,
          personalHostIds: null,
        }}
        environmentHostIds={null}
        connectableHostIds={[]}
        environmentBindings={{
          byHostId: new Map(),
          failedHostIds: [],
          retryFailed: () => undefined,
        }}
        client={null}
        hostId={HOST}
        setup={setup}
      />,
    );
  }

  it("shows the bot as its main bot needing a host, with New bot still offered", () => {
    mountBotlessTeam(SETUP);

    const row = screen.getByRole("button", { name: /^Tracy/ });
    expect(row.getAttribute("data-testid")).toBe("home-bot-setup-row");
    expect(row.getAttribute("data-bot-id")).toBe("bot-tracy-env");
    expect(within(row).getByTestId("home-bot-setup-row-main")).toBeTruthy();
    expect(
      within(row).getByTestId("home-bot-setup-row-needs-host").textContent,
    ).toBe("Needs a host");
    expect(screen.getByTestId("home-bots-create-toggle")).toBeTruthy();
    expect(screen.queryByText("No bots here yet.")).toBeNull();
  });

  it("opens the bot's tab on the band's host when its row is clicked", async () => {
    const user = userEvent.setup();
    mountBotlessTeam(SETUP);

    await user.click(screen.getByTestId("home-bot-setup-row"));

    expect(
      lookupBotTab(useBotTabsStore.getState().tabs, "bot-tracy-env"),
    ).toMatchObject({ hostId: HOST, title: "Tracy" });
    expect(mocks.navigateToTabIntent).toHaveBeenCalledTimes(1);
    expect(mocks.navigateToTabIntent).toHaveBeenCalledWith(
      mocks.navigate,
      botTabIntent("bot-tracy-env"),
      undefined,
    );
  });

  it("says no bots are here yet, with no setup row, when the team has none to set up", () => {
    mountBotlessTeam(null);

    expect(screen.getByText("No bots here yet.")).toBeTruthy();
    expect(screen.queryByTestId("home-bot-setup-row")).toBeNull();
  });
});
