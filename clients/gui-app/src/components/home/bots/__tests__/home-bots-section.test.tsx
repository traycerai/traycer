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
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotRecord } from "@traycer/protocol/host/bot/schemas";
import type {
  EnvironmentDescriptor,
  EnvironmentHostRecord,
} from "@traycer/protocol/host/environment/contracts";

const mocks = vi.hoisted(() => {
  const initialSupport = (): boolean | null => true;
  const hostClient = { stub: "host-client" };
  const environmentRefetch = vi.fn(() => Promise.resolve());
  const botRefetch = vi.fn(() => Promise.resolve());
  return {
    hostClient,
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
        data: undefined as { bots: BotRecord[] } | undefined,
        isError: false,
        refetch: botRefetch,
      },
      directory: [] as Array<{ hostId: string; label: string }>,
      connectableHostIds: [] as string[],
      connectableResolved: true,
      hostListSupport: true,
      hostLists: new Map<string, ReadonlyArray<EnvironmentHostRecord>>(),
      failedHostListIds: new Set<string>(),
    },
    groupProps: [] as Array<{
      environmentId: string;
      directoryHostIds: ReadonlySet<string>;
      connectableHostIds: ReadonlySet<string>;
      connectableResolved: boolean;
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
    useHostMethodSupport:
      vi.fn<(hostId: string | null, method: string) => boolean | null>(),
  };
});

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
vi.mock("@/hooks/bots/use-host-environment-bindings-query", () => ({
  useHostEnvironmentBindings: () => ({
    byHostId: new Map(),
    failedHostIds: [],
    resolved: true,
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
    group: { environmentId: string; label: string; bots: unknown[] };
    hostReach: {
      directoryHostIds: ReadonlySet<string>;
      connectableHostIds: ReadonlySet<string>;
      connectableResolved: boolean;
    };
    environmentHostIds: ReadonlySet<string> | null;
  }) => {
    mocks.groupProps.push({
      environmentId: props.group.environmentId,
      directoryHostIds: props.hostReach.directoryHostIds,
      connectableHostIds: props.hostReach.connectableHostIds,
      connectableResolved: props.hostReach.connectableResolved,
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
  };
}

function resolveBothQueries(): void {
  mocks.state.environments.data = { environments: [PERSONAL, TEAM] };
  mocks.state.bots.data = {
    bots: [
      bot("bot_01ARZ3NDEKTSV4RRFFQ69G5FAV", "env-team", "Release Bot"),
      bot("bot_01ARZ3NDEKTSV4RRFFQ69G5FAW", "env-personal", "Triage Bot"),
    ],
  };
}

function mountSection(): void {
  render(
    <StrictMode>
      <HomeBotsSection />
    </StrictMode>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.state.hostId = "host-1";
  mocks.state.support = true;
  mocks.state.environments.data = undefined;
  mocks.state.environments.isError = false;
  mocks.state.bots.data = undefined;
  mocks.state.bots.isError = false;
  mocks.state.directory = [{ hostId: "host-1", label: "Studio Mac" }];
  mocks.state.connectableHostIds = [];
  mocks.state.connectableResolved = true;
  mocks.state.hostListSupport = true;
  mocks.state.hostLists = new Map();
  mocks.state.failedHostListIds = new Set();
  mocks.groupProps.length = 0;
  mocks.useHostMethodSupport.mockImplementation((_hostId, method) =>
    method === "environment.host.list"
      ? mocks.state.hostListSupport
      : mocks.state.support,
  );
  mocks.useEnvironmentHostLists.mockImplementation(() => ({
    hostsByEnvironmentId: mocks.state.hostLists,
    failedEnvironmentIds: mocks.state.failedHostListIds,
    retryFailed: () => undefined,
  }));
  mocks.useEnvironmentListQuery.mockImplementation(
    () => mocks.state.environments,
  );
  mocks.useBotListQuery.mockImplementation(() => mocks.state.bots);
});

afterEach(() => {
  cleanup();
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

  it("gives a team environment null, never an empty set, when its machine list failed", () => {
    mocks.state.failedHostListIds = new Set(["env-team"]);
    resolveBothQueries();
    mountSection();

    // Absent from the answered lists and named failed: unanswered, not "no
    // machine", so its rows read idle rather than paused.
    expect(latestGroupProps("env-team").environmentHostIds).toBeNull();
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
