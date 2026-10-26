/**
 * The capability gate and the states of the Home bots band (Tracy Bots):
 * nothing before the handshake answers, an update notice on a host that
 * predates `bot.list` (with both reads held off), a group per environment in
 * list order when supported, and a retry that re-asks both reads. Each group
 * is handed what a row needs to say working, idle or paused without naming a
 * machine: the reader's host reach, and - for a team environment only - that
 * environment's machine list.
 */
import { StrictMode } from "react";
import {
  QueryClient,
  QueryClientProvider,
  queryOptions,
  useQuery,
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
import type { BotRecord } from "@traycer/protocol/host/bot/schemas";
import type {
  EnvironmentDescriptor,
  EnvironmentHostRecord,
} from "@traycer/protocol/host/environment/contracts";

// The preview-features verdict per feature; a case sets it, every other runs on.
const previewVerdict = vi.hoisted(
  (): { current: Record<"environments" | "sandboxes" | "bots", "on" | "off" | "unread"> } => ({
    current: { environments: "on", sandboxes: "on", bots: "on" },
  }),
);
vi.mock("@/hooks/auth/use-preview-feature", () => ({
  usePreviewFeature: (feature: "environments" | "sandboxes" | "bots") =>
    previewVerdict.current[feature],
}));

const mocks = vi.hoisted(() => {
  const initialSupport = (): boolean | null => true;
  const hostClient = { stub: "host-client" };
  const environmentRefetch = vi.fn(() => Promise.resolve());
  const botRefetch = vi.fn(() => Promise.resolve());
  return {
    hostClient,
    openLink: vi.fn<(url: string, kind: string) => Promise<void>>(),
    hasShell: true,
    environmentRefetch,
    botRefetch,
    state: {
      hostId: "host-1",
      support: initialSupport(),
      environments: {
        data: undefined as
          | { environments: EnvironmentDescriptor[] }
          | undefined,
        isError: false,
        refetch: environmentRefetch,
      },
      bots: {
        data: undefined as
          | { bots: BotRecord[]; mainBotIds: Record<string, string> | null }
          | undefined,
        isError: false,
        refetch: botRefetch,
      },
      directory: [] as Array<{ hostId: string; label: string }>,
      registeredHosts: undefined as
        | { hosts: Array<{ hostId: string; kind: "personal" | "sandbox" }> }
        | undefined,
      connectableHostIds: [] as string[],
      connectableResolved: true,
      hostListSupport: true,
      hostLists: new Map<string, ReadonlyArray<EnvironmentHostRecord>>(),
    },
    groupProps: [] as Array<{
      environmentId: string;
      mainBotId: string | null;
      directoryHostIds: ReadonlySet<string>;
      connectableHostIds: ReadonlySet<string>;
      connectableResolved: boolean;
      personalHostIds: ReadonlySet<string> | null;
      environmentHostIds: ReadonlySet<string> | null;
    }>,
    useEnvironmentHostLists:
      vi.fn<
        (
          client: object,
          environmentIds: ReadonlyArray<string>,
          enabled: boolean,
        ) => unknown
      >(),
    useEnvironmentListQuery:
      vi.fn<(client: object, enabled: boolean) => unknown>(),
    useBotListQuery: vi.fn<(client: object, enabled: boolean) => unknown>(),
    useBotListChangedSubscriptionForApp: vi.fn<(enabled: boolean) => void>(),
    useHostMethodSupport:
      vi.fn<(hostId: string | null, method: string) => boolean | null>(),
  };
});

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHostOrNull: () =>
    mocks.hasShell ? { signInUrl: "https://platform.traycer.ai" } : null,
}));
vi.mock("@/lib/links/open-link", () => ({
  useOpenLink: () => mocks.openLink,
}));
vi.mock("@/lib/host/runtime", () => ({
  useHostClient: () => mocks.hostClient,
}));
vi.mock("@/hooks/host/use-effective-host-id", () => ({
  useEffectiveHostId: () => mocks.state.hostId,
}));
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: (hostId: string | null, method: string) =>
    mocks.useHostMethodSupport(hostId, method),
}));
vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({ data: mocks.state.directory }),
}));
vi.mock("@/hooks/auth/use-registered-hosts-query", () => ({
  useRegisteredHosts: () => ({ data: mocks.state.registeredHosts }),
}));
vi.mock("@/hooks/host/use-connectable-host-ids", () => ({
  useConnectableHostIds: () => ({
    hostIds: mocks.state.connectableHostIds,
    resolved: mocks.state.connectableResolved,
  }),
}));
vi.mock("@/hooks/bots/use-environment-list-query", () => ({
  useEnvironmentListQuery: (client: object, enabled: boolean) =>
    mocks.useEnvironmentListQuery(client, enabled),
}));
vi.mock("@/hooks/bots/use-bot-list-query", () => ({
  useBotListQuery: (client: object, enabled: boolean) =>
    mocks.useBotListQuery(client, enabled),
}));
vi.mock("@/hooks/bots/use-bot-list-changed-subscription", () => ({
  useBotListChangedSubscriptionForApp: (enabled: boolean) =>
    mocks.useBotListChangedSubscriptionForApp(enabled),
}));
vi.mock("@/hooks/bots/use-host-environment-bindings-query", () => ({
  useHostEnvironmentBindings: () => ({
    byHostId: new Map(),
    failedHostIds: [],
    retryFailed: () => undefined,
  }),
}));
vi.mock("@/hooks/bots/use-environment-host-lists-query", () => ({
  useEnvironmentHostLists: (
    client: object,
    environmentIds: ReadonlyArray<string>,
    enabled: boolean,
  ) => mocks.useEnvironmentHostLists(client, environmentIds, enabled),
}));
vi.mock("@/components/home/bots/home-bots-group", () => ({
  HomeBotsGroupCard: (props: {
    group: {
      environmentId: string;
      label: string;
      bots: unknown[];
      mainBotId: string | null;
    };
    hostReach: {
      directoryHostIds: ReadonlySet<string>;
      connectableHostIds: ReadonlySet<string>;
      connectableResolved: boolean;
      personalHostIds: ReadonlySet<string> | null;
    };
    environmentHostIds: ReadonlySet<string> | null;
  }) => {
    mocks.groupProps.push({
      environmentId: props.group.environmentId,
      mainBotId: props.group.mainBotId,
      directoryHostIds: props.hostReach.directoryHostIds,
      connectableHostIds: props.hostReach.connectableHostIds,
      connectableResolved: props.hostReach.connectableResolved,
      personalHostIds: props.hostReach.personalHostIds,
      environmentHostIds: props.environmentHostIds,
    });
    return (
      <div
        data-testid="home-bots-group"
        data-environment-id={props.group.environmentId}
      >
        {props.group.label}
      </div>
    );
  },
}));

import { HomeBotsSection } from "@/components/home/bots/home-bots-section";
import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";

const PERSONAL: EnvironmentDescriptor = {
  environmentId: "env-personal",
  ownerKind: "user",
  ownerId: "user-1",
  roomId: "room-personal",
  label: "Personal",
};
const TEAM: EnvironmentDescriptor = {
  environmentId: "env-team",
  ownerKind: "organization",
  ownerId: "org-1",
  roomId: "room-team",
  label: "acme",
};

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
    trunkChatId: `trunk-${botId}`,
    boundHostId: "host-1",
    hostEpoch: 0,
    createdAt: 1_000,
    archivedAt: null,
    directive: null,
    replyMode: "thread",
    appConversationChatId: null,
  };
}

function resolveBothQueries(): void {
  mocks.state.environments.data = { environments: [PERSONAL, TEAM] };
  mocks.state.bots.data = {
    bots: [
      bot("bot_01ARZ3NDEKTSV4RRFFQ69G5FAV", "env-team", "Release Bot"),
      bot("bot_01ARZ3NDEKTSV4RRFFQ69G5FAW", "env-personal", "Triage Bot"),
    ],
    mainBotIds: null,
  };
}

function mountSection(): void {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <StrictMode>
        <HomeBotsSection />
      </StrictMode>
    </QueryClientProvider>,
  );
}

/** A real query over what the host's `environment.list` answers, for the focus re-read. */
const hostAnswer = { environments: [] as EnvironmentDescriptor[] };

function useLiveEnvironmentList(enabled: boolean): unknown {
  return useQuery(
    queryOptions({
      queryKey: [
        ...hostQueryKeys.methodScope("host-1", "environment.list"),
        {},
      ],
      queryFn: () => Promise.resolve({ environments: hostAnswer.environments }),
      enabled,
      staleTime: Infinity,
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.hasShell = true;
  mocks.openLink.mockResolvedValue(undefined);
  mocks.state.hostId = "host-1";
  mocks.state.support = true;
  mocks.state.environments.data = undefined;
  mocks.state.environments.isError = false;
  mocks.state.bots.data = undefined;
  mocks.state.bots.isError = false;
  mocks.state.directory = [{ hostId: "host-1", label: "Studio Mac" }];
  mocks.state.registeredHosts = undefined;
  mocks.state.connectableHostIds = [];
  mocks.state.connectableResolved = true;
  mocks.state.hostListSupport = true;
  mocks.state.hostLists = new Map();
  mocks.groupProps.length = 0;
  mocks.useHostMethodSupport.mockImplementation((_hostId, method) =>
    method === "environment.host.list"
      ? mocks.state.hostListSupport
      : mocks.state.support,
  );
  mocks.useEnvironmentHostLists.mockImplementation(() => ({
    hostsByEnvironmentId: mocks.state.hostLists,
    failedEnvironmentIds: new Set<string>(),
    retryFailed: () => undefined,
  }));
  mocks.useEnvironmentListQuery.mockImplementation(
    () => mocks.state.environments,
  );
  mocks.useBotListQuery.mockImplementation(() => mocks.state.bots);
});

afterEach(() => {
  cleanup();
  previewVerdict.current = { environments: "on", sandboxes: "on", bots: "on" };
});

describe("HomeBotsSection without the bots preview feature", () => {
  it.each(["off", "unread"] as const)(
    "renders no band and no update notice, and reads nothing, while bots read %s, even on a host without bot.list",
    (state) => {
      previewVerdict.current = { environments: state, sandboxes: state, bots: state };
      mocks.state.support = false;
      mountSection();

      expect(screen.queryByTestId("home-bots")).toBeNull();
      expect(screen.queryByTestId("home-bots-unavailable")).toBeNull();
      expect(screen.queryByTestId("home-bots-group")).toBeNull();
      expect(mocks.useEnvironmentListQuery).not.toHaveBeenCalled();
      expect(mocks.useBotListQuery).not.toHaveBeenCalled();
      expect(mocks.useBotListChangedSubscriptionForApp).not.toHaveBeenCalled();
    },
  );

  it("shows the update notice on a host without bot.list with bots on", () => {
    mocks.state.support = false;
    mountSection();

    expect(screen.getByTestId("home-bots-unavailable")).toBeTruthy();
  });
});

describe("HomeBotsSection capability gate", () => {
  it("asks about bot.list on the effective host", () => {
    mountSection();
    expect(mocks.useHostMethodSupport).toHaveBeenCalledWith(
      "host-1",
      "bot.list",
    );
  });

  it("renders nothing until the handshake has answered", () => {
    mocks.state.support = null;
    mountSection();

    expect(screen.queryByTestId("home-bots")).toBeNull();
    expect(screen.queryByTestId("home-bots-unavailable")).toBeNull();
    expect(screen.queryByTestId("home-bots-group")).toBeNull();
    // The reads stay off while the answer is unknown.
    expect(mocks.useEnvironmentListQuery).toHaveBeenLastCalledWith(
      mocks.hostClient,
      false,
    );
    expect(mocks.useBotListQuery).toHaveBeenLastCalledWith(
      mocks.hostClient,
      false,
    );
  });

  it("shows the update notice on a host without bot.list and holds both reads off", () => {
    mocks.state.support = false;
    mountSection();

    const notice = screen.getByTestId("home-bots-unavailable");
    expect(notice.getAttribute("role")).toBe("status");
    expect(notice.textContent).toContain(
      "Bots aren't available on this host yet",
    );
    expect(notice.textContent).not.toContain("Studio Mac");
    expect(screen.getByTestId("home-bots")).toBeTruthy();
    expect(screen.queryByTestId("home-bots-group")).toBeNull();
    expect(screen.queryByTestId("home-bots-loading")).toBeNull();
    expect(screen.queryByTestId("home-bots-count")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();

    expect(mocks.useEnvironmentListQuery).toHaveBeenLastCalledWith(
      mocks.hostClient,
      false,
    );
    expect(mocks.useBotListQuery).toHaveBeenLastCalledWith(
      mocks.hostClient,
      false,
    );
    for (const call of mocks.useEnvironmentListQuery.mock.calls) {
      expect(call[1]).toBe(false);
    }
    for (const call of mocks.useBotListQuery.mock.calls) {
      expect(call[1]).toBe(false);
    }
  });

  it("does not show the update notice when the host is supported", () => {
    mountSection();

    expect(screen.queryByTestId("home-bots-unavailable")).toBeNull();
    expect(mocks.useEnvironmentListQuery).toHaveBeenLastCalledWith(
      mocks.hostClient,
      true,
    );
    expect(mocks.useBotListQuery).toHaveBeenLastCalledWith(
      mocks.hostClient,
      true,
    );
  });
});

describe("HomeBotsSection main bots", () => {
  it("hands each group the main bot bot.list names for its environment", () => {
    resolveBothQueries();
    mocks.state.bots.data = {
      bots: mocks.state.bots.data?.bots ?? [],
      mainBotIds: { "env-team": "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV" },
    };
    mountSection();

    expect(latestGroupProps("env-personal").mainBotId).toBeNull();
    expect(latestGroupProps("env-team").mainBotId).toBe(
      "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    );
  });

  it("names no main bot when the host predates the field", () => {
    resolveBothQueries();
    mountSection();

    expect(latestGroupProps("env-personal").mainBotId).toBeNull();
    expect(latestGroupProps("env-team").mainBotId).toBeNull();
  });
});

describe("HomeBotsSection live list", () => {
  it("keeps bot.list current through the change stream on a supported host", () => {
    mountSection();

    expect(mocks.useBotListChangedSubscriptionForApp).toHaveBeenLastCalledWith(
      true,
    );
  });

  it("holds the change stream off until the host supports bot.list", () => {
    mocks.state.support = false;
    mountSection();

    expect(mocks.useBotListChangedSubscriptionForApp).toHaveBeenCalled();
    for (const call of mocks.useBotListChangedSubscriptionForApp.mock.calls) {
      expect(call[0]).toBe(false);
    }
  });
});

describe("HomeBotsSection supported states", () => {
  it("shows a loading placeholder until both reads have answered", () => {
    mocks.state.environments.data = { environments: [PERSONAL] };
    mountSection();

    expect(screen.getByTestId("home-bots-loading")).toBeTruthy();
    expect(screen.queryByTestId("home-bots-group")).toBeNull();
    expect(screen.queryByTestId("home-bots-count")).toBeNull();
  });

  it("renders one group per environment in list order, with the bot count", () => {
    resolveBothQueries();
    mountSection();

    const groups = screen.getAllByTestId("home-bots-group");
    expect(groups.map((g) => g.getAttribute("data-environment-id"))).toEqual([
      "env-personal",
      "env-team",
    ]);
    expect(screen.getByTestId("home-bots-count").textContent).toBe("2 bots");
    expect(screen.queryByTestId("home-bots-error")).toBeNull();
    expect(screen.queryByTestId("home-bots-unavailable")).toBeNull();
  });

  it("renders a group for an environment that holds no bot, and counts one bot singularly", () => {
    mocks.state.environments.data = { environments: [PERSONAL, TEAM] };
    mocks.state.bots.data = {
      bots: [bot("bot_01ARZ3NDEKTSV4RRFFQ69G5FAV", "env-team", "Release Bot")],
      mainBotIds: null,
    };
    mountSection();

    expect(screen.getAllByTestId("home-bots-group")).toHaveLength(2);
    expect(screen.getByTestId("home-bots-count").textContent).toBe("1 bot");
  });

  it("shows the error with a Retry that refetches both reads", async () => {
    const user = userEvent.setup();
    mocks.state.bots.isError = true;
    mocks.state.environments.data = { environments: [PERSONAL] };
    mountSection();

    const error = screen.getByTestId("home-bots-error");
    expect(error.getAttribute("role")).toBe("status");
    expect(screen.queryByTestId("home-bots-group")).toBeNull();

    expect(mocks.environmentRefetch).not.toHaveBeenCalled();
    expect(mocks.botRefetch).not.toHaveBeenCalled();
    await user.click(within(error).getByRole("button", { name: "Retry" }));
    expect(mocks.environmentRefetch).toHaveBeenCalledTimes(1);
    expect(mocks.botRefetch).toHaveBeenCalledTimes(1);
  });

  it("shows the error when only the environment read failed", () => {
    mocks.state.environments.isError = true;
    mountSection();

    expect(screen.getByTestId("home-bots-error")).toBeTruthy();
    expect(screen.queryByTestId("home-bots-loading")).toBeNull();
  });
});

function hostRecord(hostId: string): EnvironmentHostRecord {
  return {
    hostId,
    hostLabel: null,
    hostPlatform: null,
    enrolledByUserId: "user-2",
    kind: "sandbox",
    boundAt: 1_000,
  };
}

function latestGroupProps(environmentId: string) {
  const match = mocks.groupProps.findLast(
    (props) => props.environmentId === environmentId,
  );
  if (match === undefined) {
    throw new Error(`no group card rendered for ${environmentId}`);
  }
  return match;
}

describe("HomeBotsSection what each group is told", () => {
  it("hands every group the reader's own hosts and which of them can be dialled", () => {
    mocks.state.directory = [
      { hostId: "host-1", label: "Studio Mac" },
      { hostId: "host-2", label: "Laptop" },
    ];
    mocks.state.connectableHostIds = ["host-1"];
    resolveBothQueries();
    mountSection();

    for (const environmentId of ["env-personal", "env-team"]) {
      const props = latestGroupProps(environmentId);
      expect([...props.directoryHostIds].sort()).toEqual(["host-1", "host-2"]);
      expect([...props.connectableHostIds]).toEqual(["host-1"]);
    }
  });

  it("hands every group the reader's personal hosts, and only those the registry calls personal", () => {
    mocks.state.registeredHosts = {
      hosts: [
        { hostId: "host-1", kind: "personal" },
        { hostId: "host-sandbox", kind: "sandbox" },
      ],
    };
    resolveBothQueries();
    mountSection();

    for (const environmentId of ["env-personal", "env-team"]) {
      expect(latestGroupProps(environmentId).personalHostIds).toEqual(
        new Set(["host-1"]),
      );
    }
  });

  it("hands every group an unanswered registry as not known, never as no personal host", () => {
    resolveBothQueries();
    mountSection();

    for (const environmentId of ["env-personal", "env-team"]) {
      expect(latestGroupProps(environmentId).personalHostIds).toBeNull();
    }
  });

  it("tells every group whether the directory has answered, so an empty dialable set is not read as none", () => {
    mocks.state.connectableResolved = false;
    resolveBothQueries();
    mountSection();
    for (const environmentId of ["env-personal", "env-team"]) {
      expect(latestGroupProps(environmentId).connectableResolved).toBe(false);
    }

    cleanup();
    mocks.groupProps.length = 0;
    mocks.state.connectableResolved = true;
    mountSection();
    for (const environmentId of ["env-personal", "env-team"]) {
      expect(latestGroupProps(environmentId).connectableResolved).toBe(true);
    }
  });

  it("gives a personal environment an empty machine set without asking anyone, and a team environment its answered list", () => {
    mocks.state.hostLists = new Map([
      ["env-team", [hostRecord("host-sandbox"), hostRecord("host-mate")]],
    ]);
    resolveBothQueries();
    mountSection();

    expect(latestGroupProps("env-personal").environmentHostIds).toEqual(
      new Set(),
    );
    expect(latestGroupProps("env-team").environmentHostIds).toEqual(
      new Set(["host-sandbox", "host-mate"]),
    );
  });

  it("gives a team environment null while its machine list has not answered", () => {
    resolveBothQueries();
    mountSection();

    expect(latestGroupProps("env-team").environmentHostIds).toBeNull();
    // A personal environment is never waiting on a list it does not have.
    expect(latestGroupProps("env-personal").environmentHostIds).toEqual(
      new Set(),
    );
  });

  it("asks for the machine lists of team environments only", () => {
    resolveBothQueries();
    mountSection();

    expect(mocks.useEnvironmentHostLists).toHaveBeenLastCalledWith(
      mocks.hostClient,
      ["env-team"],
      true,
    );
  });

  it("holds the machine-list reads off on a host without environment.host.list", () => {
    mocks.state.hostListSupport = false;
    resolveBothQueries();
    mountSection();

    expect(mocks.useHostMethodSupport).toHaveBeenCalledWith(
      "host-1",
      "environment.host.list",
    );
    expect(mocks.useEnvironmentHostLists).toHaveBeenLastCalledWith(
      mocks.hostClient,
      ["env-team"],
      false,
    );
    expect(latestGroupProps("env-team").environmentHostIds).toBeNull();
  });

  it("holds the machine-list reads off while the bots band itself is unsupported", () => {
    mocks.state.support = false;
    mountSection();

    for (const call of mocks.useEnvironmentHostLists.mock.calls) {
      expect(call[2]).toBe(false);
    }
  });
});

describe("HomeBotsSection create a team", () => {
  it("offers a card to a reader in no team, opening the dashboard's create-team page", async () => {
    const user = userEvent.setup();
    mocks.state.environments.data = { environments: [PERSONAL] };
    mocks.state.bots.data = { bots: [], mainBotIds: null };
    mountSection();

    expect(screen.getAllByTestId("home-bots-group")).toHaveLength(1);
    const card = screen.getByTestId("home-bots-create-team");
    await user.click(within(card).getByTestId("home-bots-create-team-open"));

    expect(within(card).getByText("Create a team")).toBeTruthy();
    expect(mocks.openLink).toHaveBeenCalledTimes(1);
    expect(mocks.openLink.mock.calls[0]?.[0]).toBe(
      "https://platform.traycer.ai/settings?create-team=1",
    );
    expect(mocks.openLink.mock.calls[0]?.[1]).toBe("account");
  });

  it("re-reads the environment list when the window regains focus, so a team made on the dashboard replaces the card", async () => {
    hostAnswer.environments = [PERSONAL];
    mocks.useEnvironmentListQuery.mockImplementation((_client, enabled) =>
      useLiveEnvironmentList(enabled),
    );
    mocks.state.bots.data = { bots: [], mainBotIds: null };
    mountSection();
    await screen.findByTestId("home-bots-create-team");

    hostAnswer.environments = [PERSONAL, TEAM];
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    await waitFor(() => {
      expect(
        screen
          .getAllByTestId("home-bots-group")
          .map((group) => group.getAttribute("data-environment-id")),
      ).toEqual(["env-personal", "env-team"]);
    });
    expect(screen.queryByTestId("home-bots-create-team")).toBeNull();
  });

  it("draws no card when a team is listed, or with no shell to open it", () => {
    resolveBothQueries();
    mountSection();
    expect(screen.queryByTestId("home-bots-create-team")).toBeNull();
    cleanup();

    mocks.state.environments.data = { environments: [PERSONAL] };
    mocks.hasShell = false;
    mountSection();
    expect(screen.queryByTestId("home-bots-create-team")).toBeNull();
  });
});
