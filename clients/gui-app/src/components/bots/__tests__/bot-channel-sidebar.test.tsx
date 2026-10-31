/**
 * The bot tab's sidebar (Tracy Bots, decision 41): every environment is a
 * section, every bot in it an avatar and name channel, unread channels are
 * marked. The sections list channels only. The person's own section carries a
 * + that opens the create form, and an empty one a call to action doing the
 * same; a team's + opens the team's main bot, which for a new team with no bot
 * is the one still to be set up (T67), drawn as a row marked as needing a
 * host. A person in no team is offered "Create a team". A bot that is not its
 * environment's main bot is made main from its row's menu. "Threads", above
 * the sections, counts the followed threads with new replies across every
 * bot (T103). The real sidebar, the real new-bot dialog and the real bot-tabs store run
 * over mocked reads; `bot.onboarding.read` answers per environment from a
 * script, the create form and the navigation helper are stubs, so the dialog's
 * focus on closing is read off the real thing.
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
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BotReadCursorReadResponse,
  BotRecord,
  BotThreadFollow,
} from "@traycer/protocol/host/bot/schemas";
import type { BotThreadSummary } from "@traycer/protocol/host/bot/conversation-schemas";
import type { EnvironmentDescriptor } from "@traycer/protocol/host/environment/contracts";
import type {
  BotOnboardingReadResponse,
  BotOnboardingSetup,
} from "@traycer/protocol/host/bot/onboarding-schemas";
import type { TabNavigationIntent } from "@/lib/tab-navigation/intents";

interface IndicatorState {
  unreadDone: boolean;
  unreadFailure: boolean;
  unreadCount: number | null;
}

type ThreadReads = {
  threads: BotThreadSummary[];
  follows: Record<string, BotThreadFollow>;
  cursors: BotReadCursorReadResponse;
};

type ReadScript =
  | ({ setup: BotOnboardingSetup | null } & Partial<
      Pick<BotOnboardingReadResponse, "github" | "unlocked">
    >)
  | "fails";

const mocks = vi.hoisted(() => {
  const epics: Record<string, IndicatorState> = {};
  /**
   * What `bot.onboarding.read` answers per environment id: a setup, `null`
   * for a team that has its bots, "fails" for a read that errors. An
   * environment not listed has not answered yet.
   */
  const reads: Record<string, ReadScript | undefined> = {};
  /** The environments `bot.onboarding.read` was asked about, in order. */
  const readRequests: string[] = [];
  /**
   * What each bot's `bot.thread.list`, `bot.threadFollow.read` and
   * `bot.readCursor.read` answer; a bot not named has no threads.
   */
  const threadReads: Record<string, ThreadReads> = {};
  return {
    client: { stub: "tab-host-client" },
    navigate: vi.fn(),
    openLink: vi.fn<(url: string, kind: string) => Promise<void>>(),
    hasShell: true,
    navigateToTabIntent: vi.fn<(intent: unknown) => void>(),
    setMainBot: vi.fn<(variables: object) => void>(),
    bindings: { stub: "environment-bindings" },
    state: {
      environments: [] as EnvironmentDescriptor[],
      bots: [] as BotRecord[],
      mainBotIds: null as Record<string, string> | null,
      connectable: { hostIds: [] as string[], resolved: true },
      epics,
      reads,
      /** Whether the host advertises `bot.onboarding.read`; `null` while unknown. */
      support: null as boolean | null,
      /** Whether the host advertises `environment.setMainBot`; `null` while unknown. */
      setMainBotSupport: null as boolean | null,
      /** What `environment.setMainBot` reports as its error; `null` = accepted. */
      setMainBotRefusal: null as string | null,
      /** The line the host negotiated for `bot.onboarding.read`. */
      version: { major: 1, minor: 1 },
      /** What `bot.notificationLevel.read` answers: levels by channel id. */
      levels: {},
      /** What `bot.readCursor.read` answers; `undefined` while unread. */
      readCursor: undefined as BotReadCursorReadResponse | undefined,
      /** Methods the host does not advertise, whatever `support` says. */
      unsupported: new Set<string>(),
      threadReads,
    },
    readRequests,
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
vi.mock("@/hooks/chats/use-cloud-chat-queries", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/chats/use-cloud-chat-queries")
  >()),
  useCloudChatViewerId: () => "user-1",
}));
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => mocks.client,
}));
vi.mock("@/components/epic-canvas/hooks/use-tab-host-id", () => ({
  useTabHostId: () => "host-tab",
}));
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: (_hostId: string | null, method: string) => {
    if (method === "environment.setMainBot") {
      return mocks.state.setMainBotSupport;
    }
    return mocks.state.unsupported.has(method) ? false : mocks.state.support;
  },
  useHostMethodSchemaVersion: () => mocks.state.version,
  useHostSupportsMethod: () => true,
}));
// The host RPC boundary: `bot.onboarding.read` answers what the test scripted,
// each bot's thread reads answer `threadReads`, and a query that is not
// enabled reads as pending, as TanStack's does.
vi.mock("@/hooks/host/use-host-queries", () => ({
  useHostQueries: (args: {
    requests: ReadonlyArray<{
      method: string;
      params: { environmentId: string; botId: string };
    }>;
    options: { enabled?: boolean } | null;
  }) =>
    args.requests.map((request) => {
      if (args.options?.enabled !== true) {
        return { status: "pending", isPending: true, data: undefined };
      }
      if (request.method !== "bot.onboarding.read") {
        const reads = Object.hasOwn(
          mocks.state.threadReads,
          request.params.botId,
        )
          ? mocks.state.threadReads[request.params.botId]
          : { threads: [], follows: {}, cursors: { cursors: {}, latest: {} } };
        const answers: Record<string, unknown> = {
          "bot.thread.list": {
            threads: reads.threads,
            trunkCostUsd: null,
            threadAnchors: null,
          },
          "bot.threadFollow.read": { follows: reads.follows },
          "bot.readCursor.read": reads.cursors,
          "bot.notificationLevel.read": { levels: mocks.state.levels },
        };
        return {
          status: "success",
          isPending: false,
          isError: false,
          data: answers[request.method],
        };
      }
      const { environmentId } = request.params;
      mocks.readRequests.push(environmentId);
      const script = mocks.state.reads[environmentId];
      if (script === undefined) return { status: "pending", data: undefined };
      if (script === "fails") return { status: "error", data: undefined };
      return { status: "success", data: script };
    }),
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
// The person's notification levels, as the host answers them.
vi.mock("@/hooks/host/use-host-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/host/use-host-query")>()),
  useHostQuery: (args: { method: string }) => {
    if (args.method === "bot.notificationLevel.read") {
      return { data: { levels: mocks.state.levels } };
    }
    if (args.method === "bot.readCursor.read") {
      return { data: mocks.state.readCursor };
    }
    return { data: undefined };
  },
}));
vi.mock("@/hooks/bots/use-bot-list-query", () => ({
  useBotListQuery: () => ({
    data: { bots: mocks.state.bots, mainBotIds: mocks.state.mainBotIds },
  }),
}));
vi.mock("@/hooks/bots/use-environment-set-main-bot-mutation", () => ({
  useEnvironmentSetMainBotMutation: () => ({
    isPending: false,
    error:
      mocks.state.setMainBotRefusal === null
        ? null
        : { message: mocks.state.setMainBotRefusal },
    mutate: mocks.setMainBot,
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
vi.mock("@/components/home/bots/create-bot-form", () => ({
  CreateBotForm: (props: { environmentId: string }) => (
    <div
      data-testid="stub-create-bot-form"
      data-environment-id={props.environmentId}
    />
  ),
}));

import {
  BotChannelSidebar,
  type BotThreadsViewState,
} from "@/components/bots/bot-channel-sidebar";
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

const SETUP_BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";

/** What the host answers for a new team: its main bot, still to be set up. */
function setupRead(title: string): ReadScript {
  return {
    setup: { botId: SETUP_BOT_ID, title, state: "needs_host", arrival: null },
  };
}

/**
 * What the host answers for a new team when it could not read GitHub: the
 * empty, locked set beside the setup, which still stands.
 */
function degradedSetupRead(title: string): ReadScript {
  return {
    setup: { botId: SETUP_BOT_ID, title, state: "needs_host", arrival: null },
    github: {
      state: "needs_installing_admin",
      installingAdmin: null,
      repositories: [],
      callerCanConnect: false,
    },
    unlocked: false,
  };
}

/** What the host answers for a team that has its bots. */
const NO_SETUP: ReadScript = { setup: null };

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
  mountWithThreads(activeBotId, null);
}

function mountWithThreads(
  activeBotId: string,
  threadsView: BotThreadsViewState | null,
): void {
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
      <BotChannelSidebar
        activeBotId={activeBotId}
        hostId={TAB_HOST}
        threadsView={threadsView}
      />
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
  mocks.state.support = true;
  mocks.state.setMainBotSupport = true;
  mocks.state.setMainBotRefusal = null;
  mocks.state.version = { major: 1, minor: 1 };
  mocks.state.levels = {};
  mocks.state.readCursor = undefined;
  mocks.state.unsupported.clear();
  mocks.state.threadReads = {};
  for (const key of Object.keys(mocks.state.reads)) {
    delete mocks.state.reads[key];
  }
  mocks.readRequests.length = 0;
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
    // The task panel's quiet highlight, never the accent pill.
    expect(row("bot-release").classList.contains("bg-accent")).toBe(true);
    expect(row("bot-release").classList.contains("bg-primary")).toBe(false);
    expect(row("bot-triage").classList.contains("bg-accent")).toBe(false);
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

describe("<BotChannelSidebar /> muted channels", () => {
  function withChannels(): void {
    mocks.state.bots = [
      {
        ...bot("bot-release", "env-team", "release-bot"),
        appConversationChatId: "chan-release",
      },
      {
        ...bot("bot-triage", "env-team", "triage-bot"),
        appConversationChatId: "chan-triage",
      },
      {
        ...bot("bot-notes", "env-me", "notes-bot"),
        appConversationChatId: "chan-notes",
      },
      bot("bot-bare", "env-me", "bare-bot"),
    ];
  }

  it("marks only the channel the person set to Nothing", () => {
    withChannels();
    mocks.state.levels = {
      "chan-release": "off",
      "chan-triage": "mentions",
      "chan-notes": "all",
    };
    mount("bot-release");

    // The channel in view: the glyph takes the quiet row's foreground.
    const glyph = within(row("bot-release")).getByTestId(
      "bot-channel-row-muted",
    );
    expect(glyph.classList.contains("text-accent-foreground")).toBe(true);
    expect(glyph.classList.contains("text-primary-foreground")).toBe(false);
    for (const botId of ["bot-triage", "bot-notes", "bot-bare"]) {
      expect(
        within(row(botId)).queryByTestId("bot-channel-row-muted"),
      ).toBeNull();
    }
  });

  it("marks nothing for a channel with no level set", () => {
    withChannels();
    mount("bot-release");

    expect(screen.queryByTestId("bot-channel-row-muted")).toBeNull();
  });
});

describe("<BotChannelSidebar /> read-cursor bold", () => {
  const NEW_ROW = { messageId: "m-new", seq: 2_000 };
  const OLD_ROW = { messageId: "m-old", seq: 1_000 };

  beforeEach(() => {
    mocks.state.bots = [
      {
        ...bot("bot-release", "env-team", "release-bot"),
        appConversationChatId: "chan-release",
      },
      {
        ...bot("bot-triage", "env-team", "triage-bot"),
        appConversationChatId: "chan-triage",
      },
    ];
  });

  it("bolds a channel with a row past the cursor, with no count when the mailbox holds nothing", () => {
    mocks.state.readCursor = {
      cursors: { "chan-release": OLD_ROW },
      latest: { "chan-release": NEW_ROW },
    };
    mount("bot-triage");

    expect(row("bot-release").getAttribute("data-unread")).toBe("true");
    expect(
      within(row("bot-release")).queryByTestId("bot-channel-row-unread-count"),
    ).toBeNull();
  });

  it("does not bold a channel at Nothing, though a new row has landed", () => {
    mocks.state.readCursor = {
      cursors: {},
      latest: { "chan-release": NEW_ROW },
    };
    mocks.state.levels = { "chan-release": "off" };
    mount("bot-triage");

    expect(row("bot-release").getAttribute("data-unread")).toBe("false");
  });

  it("does not bold a channel the cursor has caught up with, whatever the mailbox says", () => {
    mocks.state.readCursor = {
      cursors: { "chan-release": NEW_ROW },
      latest: { "chan-release": NEW_ROW },
    };
    mocks.state.epics = {
      "bot-release": {
        unreadDone: true,
        unreadFailure: false,
        unreadCount: 1,
      },
    };
    mount("bot-triage");

    expect(row("bot-release").getAttribute("data-unread")).toBe("false");
  });

  it("keeps the mailbox indicator's bold on a host without bot.readCursor.read", () => {
    mocks.state.unsupported.add("bot.readCursor.read");
    mocks.state.readCursor = {
      cursors: {},
      latest: { "chan-release": NEW_ROW },
    };
    mocks.state.epics = {
      "bot-triage": { unreadDone: true, unreadFailure: false, unreadCount: 1 },
    };
    mount("bot-release");

    expect(row("bot-release").getAttribute("data-unread")).toBe("false");
    expect(row("bot-triage").getAttribute("data-unread")).toBe("true");
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
      "text-accent-foreground",
    );
    expect(star.getAttribute("class")).toContain("text-current");
    expect(star.getAttribute("class")).not.toContain("text-muted-foreground");
  });

  it("stars no channel when the host's list names no main bots", () => {
    mount("bot-release");

    expect(screen.queryByRole("img", { name: "Main bot" })).toBeNull();
  });
});

describe("<BotChannelSidebar /> making a bot main", () => {
  function menuOf(botId: string): HTMLElement | null {
    const item = row(botId).closest("li");
    if (item === null) throw new Error(`no list item for ${botId}`);
    return within(item).queryByTestId("bot-channel-row-menu");
  }

  it("makes a bot that is not main the main bot from its row's menu and its context menu, in one click with no confirmation", async () => {
    const user = userEvent.setup();
    mocks.state.mainBotIds = { "env-team": "bot-release" };
    mount("bot-release");

    const menu = menuOf("bot-triage");
    if (menu === null) throw new Error("expected the triage bot's menu");
    await user.click(menu);
    await user.click(screen.getByRole("menuitem", { name: "Make main" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mocks.setMainBot).toHaveBeenCalledTimes(1);
    expect(mocks.setMainBot.mock.calls[0][0]).toEqual({
      environmentId: "env-team",
      botId: "bot-triage",
    });

    await user.pointer({ keys: "[MouseRight]", target: row("bot-triage") });
    await user.click(screen.getByRole("menuitem", { name: "Make main" }));
    expect(mocks.setMainBot).toHaveBeenCalledTimes(2);
    expect(mocks.setMainBot.mock.calls[1][0]).toEqual({
      environmentId: "env-team",
      botId: "bot-triage",
    });
  });

  it("offers no menu on the main bot, nor in an environment with no main bot", () => {
    mocks.state.mainBotIds = { "env-team": "bot-release" };
    mount("bot-release");

    expect(menuOf("bot-triage")).not.toBeNull();
    expect(menuOf("bot-release")).toBeNull();
    expect(menuOf("bot-notes")).toBeNull();
  });

  it.each([false, null])(
    "offers no menu on a host whose support for environment.setMainBot is %s",
    (support) => {
      mocks.state.setMainBotSupport = support;
      mocks.state.mainBotIds = { "env-team": "bot-release" };
      mount("bot-release");

      expect(screen.queryByTestId("bot-channel-row-menu")).toBeNull();
    },
  );

  it("states a refusal under the bot's row, and nowhere else", () => {
    mocks.state.setMainBotRefusal = "Only an admin can change the main bot";
    mocks.state.mainBotIds = { "env-team": "bot-release" };
    mount("bot-release");

    const refusal = screen.getByRole("alert");
    expect(refusal.textContent).toBe("Only an admin can change the main bot");
    expect(row("bot-triage").closest("li")?.contains(refusal)).toBe(true);
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

describe("<BotChannelSidebar /> Threads", () => {
  const FOLLOWING: BotThreadFollow = {
    state: "following",
    reason: "participated",
  };

  function thread(threadId: string, lastReplyAt: number): BotThreadSummary {
    return {
      threadId,
      conversationId: "channel",
      sessionChatId: `session-${threadId}`,
      anchor: null,
      replyCount: 1,
      lastReplyAt,
      openRequestCount: 0,
      costUsd: null,
    };
  }

  function view(shown: boolean): BotThreadsViewState {
    return { shown, onShow: vi.fn(), onLeave: vi.fn() };
  }

  function threadsRow(): HTMLElement {
    return screen.getByTestId("bot-channel-threads-row");
  }

  it("stands above the first section and counts the followed threads with new replies across every bot", () => {
    // Two followed threads with new replies on two bots count; a caught-up
    // one and an unfollowed one with new replies do not.
    mocks.state.threadReads = {
      "bot-release": {
        threads: [thread("release-new", 2_000), thread("release-read", 2_000)],
        follows: { "release-new": FOLLOWING, "release-read": FOLLOWING },
        cursors: {
          cursors: { "release-read": { messageId: "m-1", seq: 2_000 } },
          latest: {},
        },
      },
      "bot-notes": {
        threads: [thread("notes-new", 3_000), thread("notes-other", 3_000)],
        follows: {
          "notes-new": FOLLOWING,
          "notes-other": { state: "unfollowed", reason: "manual" },
        },
        cursors: { cursors: {}, latest: {} },
      },
    };
    mountWithThreads("bot-release", view(false));

    const nav = screen.getByTestId("bot-channel-sidebar");
    expect(nav.firstElementChild).toBe(threadsRow());
    expect(threadsRow().textContent).toBe("Threads2 with new replies");
    expect(threadsRow().getAttribute("aria-current")).toBeNull();
    expect(row("bot-release").getAttribute("aria-current")).toBe("page");
  });

  it("is the current row while Threads shows, the tab's channel row is not, and that row goes back to the channel", async () => {
    const user = userEvent.setup();
    const threads = view(true);
    mountWithThreads("bot-release", threads);

    expect(threadsRow().getAttribute("aria-current")).toBe("page");
    expect(threadsRow().className).toContain("bg-accent");
    expect(row("bot-release").getAttribute("aria-current")).toBeNull();
    expect(screen.queryByTestId("bot-channel-threads-count")).toBeNull();

    await user.click(row("bot-release"));

    expect(threads.onLeave).toHaveBeenCalledTimes(1);
    expect(mocks.navigateToTabIntent).not.toHaveBeenCalled();
  });

  it("shows Threads when chosen, and another bot's row opens that bot's tab and leaves this tab's Threads alone", async () => {
    const user = userEvent.setup();
    const threads = view(false);
    mountWithThreads("bot-release", threads);

    await user.click(threadsRow());
    expect(threads.onShow).toHaveBeenCalledTimes(1);

    await user.click(row("bot-triage"));
    expect(threads.onLeave).not.toHaveBeenCalled();
    expect(mocks.navigateToTabIntent).toHaveBeenCalledWith({
      kind: "bot",
      botId: "bot-triage",
    });
  });

  it("draws no count on a host that cannot read follows, and no row on a tab with no channel to swap", () => {
    mocks.state.unsupported.add("bot.threadFollow.read");
    mocks.state.threadReads = {
      "bot-release": {
        threads: [thread("release-new", 2_000)],
        follows: { "release-new": FOLLOWING },
        cursors: { cursors: {}, latest: {} },
      },
    };
    mountWithThreads("bot-release", view(false));
    expect(threadsRow().textContent).toBe("Threads");
    cleanup();

    mount("bot-release");
    expect(screen.queryByTestId("bot-channel-threads-row")).toBeNull();
  });
});

describe("<BotChannelSidebar /> a team's main bot", () => {
  it("draws a + on the person's own section and on each team with a bot to open, and on no other", () => {
    mocks.state.bots = [
      ...mocks.state.bots,
      bot("bot-orphan", "env-left", "orphan-bot"),
    ];
    mount("bot-release");

    expect(
      within(section("env-me")).getByRole("button", { name: "New bot" }),
    ).toBeTruthy();
    // The list names no main bot, so the team's + opens its first bot.
    expect(
      within(section("env-team")).getByRole("button", {
        name: "Open release-bot",
      }),
    ).toBeTruthy();
    // A team with no bot and nothing to set up has nothing to open.
    expect(
      within(section("env-empty")).queryByTestId("bot-channel-section-add"),
    ).toBeNull();
    // An environment the person is no longer in has no team to add to.
    expect(
      within(section("env-left")).queryByTestId("bot-channel-section-add"),
    ).toBeNull();
    expect(screen.getAllByTestId("bot-channel-section-add")).toHaveLength(2);
  });

  it("opens the team's main bot from its + when the list names one, and no create form", async () => {
    const user = userEvent.setup();
    mocks.state.mainBotIds = { "env-team": "bot-triage" };
    mount("bot-notes");

    await user.click(
      within(section("env-team")).getByRole("button", {
        name: "Open triage-bot",
      }),
    );

    expect(
      lookupBotTab(useBotTabsStore.getState().tabs, "bot-triage"),
    ).toMatchObject({
      botId: "bot-triage",
      hostId: TAB_HOST,
      title: "triage-bot",
    });
    expect(mocks.navigateToTabIntent).toHaveBeenCalledWith({
      kind: "bot",
      botId: "bot-triage",
    });
    expect(screen.queryByTestId("new-bot-dialog")).toBeNull();
  });
});

describe("<BotChannelSidebar /> a team still to be set up", () => {
  beforeEach(() => {
    mocks.state.reads["env-empty"] = setupRead("Tracy");
  });

  it("shows the team's future main bot as a row marked as the main bot and as needing a host, in place of the empty section", () => {
    mount("bot-release");

    const setup = within(section("env-empty")).getByTestId(
      "bot-channel-setup-row",
    );
    expect(setup.getAttribute("data-bot-id")).toBe(SETUP_BOT_ID);
    expect(within(setup).getByText("Tracy")).toBeTruthy();
    expect(within(setup).getByTestId("bot-avatar")).toBeTruthy();
    expect(
      within(setup).getByTestId("bot-channel-setup-row-main"),
    ).toBeTruthy();
    expect(
      within(setup).getByTestId("bot-channel-setup-row-needs-host").textContent,
    ).toBe("Needs a host");
    expect(
      within(section("env-empty")).queryAllByTestId("bot-channel-row"),
    ).toHaveLength(0);
    // The other team's channels carry no such row.
    expect(
      within(section("env-team")).queryByTestId("bot-channel-setup-row"),
    ).toBeNull();
  });

  it.each([
    {
      label: "the row",
      control: () =>
        within(section("env-empty")).getByTestId("bot-channel-setup-row"),
    },
    {
      label: "the team's +",
      control: () =>
        within(section("env-empty")).getByRole("button", {
          name: "Open Tracy",
        }),
    },
  ])(
    "opens a bot tab on the setup bot's id and title from $label",
    async ({ control }) => {
      const user = userEvent.setup();
      mount("bot-release");

      await user.click(control());

      expect(
        lookupBotTab(useBotTabsStore.getState().tabs, SETUP_BOT_ID),
      ).toMatchObject({
        botId: SETUP_BOT_ID,
        hostId: TAB_HOST,
        title: "Tracy",
      });
      expect(mocks.navigateToTabIntent).toHaveBeenCalledTimes(1);
      expect(mocks.navigateToTabIntent).toHaveBeenCalledWith({
        kind: "bot",
        botId: SETUP_BOT_ID,
      });
      expect(screen.queryByTestId("new-bot-dialog")).toBeNull();
    },
  );

  it("still shows the setup row, its Needs a host badge and the team's +, when the host could not read GitHub", async () => {
    mocks.state.reads["env-empty"] = degradedSetupRead("Tracy");
    const user = userEvent.setup();
    mount("bot-release");

    const setup = within(section("env-empty")).getByTestId(
      "bot-channel-setup-row",
    );
    expect(setup.getAttribute("data-bot-id")).toBe(SETUP_BOT_ID);
    expect(
      within(setup).getByTestId("bot-channel-setup-row-needs-host").textContent,
    ).toBe("Needs a host");

    await user.click(
      within(section("env-empty")).getByRole("button", { name: "Open Tracy" }),
    );

    expect(
      lookupBotTab(useBotTabsStore.getState().tabs, SETUP_BOT_ID),
    ).toMatchObject({ botId: SETUP_BOT_ID, hostId: TAB_HOST, title: "Tracy" });
    expect(mocks.navigateToTabIntent).toHaveBeenCalledWith({
      kind: "bot",
      botId: SETUP_BOT_ID,
    });
  });

  it("marks the setup row as the current page while its channel is in view, and does nothing when it is clicked", async () => {
    const user = userEvent.setup();
    mount(SETUP_BOT_ID);

    const setup = screen.getByTestId("bot-channel-setup-row");
    expect(setup.getAttribute("aria-current")).toBe("page");
    expect(setup.classList.contains("bg-accent")).toBe(true);
    expect(setup.classList.contains("bg-primary")).toBe(false);
    await user.click(setup);

    expect(useBotTabsStore.getState().tabs).toEqual({});
    expect(mocks.navigateToTabIntent).not.toHaveBeenCalled();
  });
});

describe("<BotChannelSidebar /> a team that is not to be set up", () => {
  it("shows a team with its bots and no setup row, reading no team that has a bot", () => {
    // A team whose bots pre-date onboarding: the read answers no setup.
    mocks.state.reads["env-team"] = NO_SETUP;
    mount("bot-release");

    expect(
      within(section("env-team"))
        .getAllByTestId("bot-channel-row")
        .map((r) => r.getAttribute("data-bot-id")),
    ).toEqual(["bot-release", "bot-triage"]);
    expect(screen.queryByTestId("bot-channel-setup-row")).toBeNull();
    expect(new Set(mocks.readRequests)).toEqual(new Set(["env-empty"]));
  });

  it.each([
    { label: "a host without bot.onboarding.read", support: false },
    { label: "a host whose methods are not known yet", support: null },
  ])(
    "shows no setup row and no team + on $label, and asks for nothing",
    ({ support }) => {
      mocks.state.support = support;
      mocks.state.reads["env-empty"] = setupRead("Tracy");
      mount("bot-release");

      expect(screen.queryByTestId("bot-channel-setup-row")).toBeNull();
      expect(
        within(section("env-empty")).queryByTestId("bot-channel-section-add"),
      ).toBeNull();
      expect(mocks.readRequests).toEqual([]);
    },
  );

  it("shows no setup row and no team + on a host that answers bot.onboarding.read at 1.0, and asks for nothing", () => {
    mocks.state.version = { major: 1, minor: 0 };
    mocks.state.reads["env-empty"] = setupRead("Tracy");
    mount("bot-release");

    expect(screen.queryByTestId("bot-channel-setup-row")).toBeNull();
    expect(
      within(section("env-empty")).queryByTestId("bot-channel-section-add"),
    ).toBeNull();
    expect(mocks.readRequests).toEqual([]);
  });

  it("shows no setup row and no team + when the read fails", () => {
    mocks.state.reads["env-empty"] = "fails";
    mount("bot-release");

    expect(screen.queryByTestId("bot-channel-setup-row")).toBeNull();
    expect(
      within(section("env-empty")).queryByTestId("bot-channel-section-add"),
    ).toBeNull();
  });
});

describe("<BotChannelSidebar /> the person's own section", () => {
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
    expect(screen.getAllByTestId("bot-channel-section-set-up")).toHaveLength(1);

    await user.click(
      within(section("env-me")).getByTestId("bot-channel-section-add"),
    );
    const fromPlus = screen.getByTestId("new-bot-dialog");
    expect(within(fromPlus).getByText("New bot")).toBeTruthy();
    expect(
      within(fromPlus)
        .getByTestId("stub-create-bot-form")
        .getAttribute("data-environment-id"),
    ).toBe("env-me");

    await user.click(screen.getByRole("button", { name: "Close" }));
    await user.click(
      within(section("env-me")).getByTestId("bot-channel-section-set-up"),
    );
    expect(
      within(screen.getByTestId("new-bot-dialog"))
        .getByTestId("stub-create-bot-form")
        .getAttribute("data-environment-id"),
    ).toBe("env-me");
  });

  it("gives focus back to the + that opened the dialog on Escape", async () => {
    const user = userEvent.setup();
    mount("bot-release");
    const plus = within(section("env-me")).getByTestId(
      "bot-channel-section-add",
    );
    await user.click(plus);
    await screen.findByTestId("new-bot-dialog");

    await user.keyboard("{Escape}");

    await waitFor(() => {
      expect(screen.queryByTestId("new-bot-dialog")).toBeNull();
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(plus);
    });
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
