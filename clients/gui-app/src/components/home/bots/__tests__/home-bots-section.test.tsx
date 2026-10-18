/**
 * The capability gate and the states of the Home bots band (Tracy Bots):
 * nothing before the handshake answers, an update notice on a host that
 * predates `bot.list` (with both reads held off), a group per environment in
 * list order when supported, and a retry that re-asks both reads.
 */
import { StrictMode } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotRecord } from "@traycer/protocol/host/bot/schemas";
import type { EnvironmentDescriptor } from "@traycer/protocol/host/environment/contracts";

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
    },
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
  useConnectableHostIds: () => ({ hostIds: [], resolved: true }),
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
  useHostEnvironmentBindings: () => ({ byHostId: new Map(), resolved: true }),
}));
vi.mock("@/components/home/bots/home-bots-group", () => ({
  HomeBotsGroupCard: (props: {
    group: { environmentId: string; label: string; bots: unknown[] };
  }) => (
    <div
      data-testid="home-bots-group"
      data-environment-id={props.group.environmentId}
    >
      {props.group.label}
    </div>
  ),
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
  mocks.useHostMethodSupport.mockImplementation(() => mocks.state.support);
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
    expect(notice.textContent).toContain("aren't available on Studio Mac yet");
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
