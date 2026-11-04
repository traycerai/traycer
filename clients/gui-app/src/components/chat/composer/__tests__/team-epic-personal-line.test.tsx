import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type {
  HostListItem,
  HostOwnerPrincipal,
} from "@traycer/protocol/host/host-status";
import type { EnvironmentStatusResponseV11 } from "@traycer/protocol/host/environment-schemas";
import { environmentStatusFixture } from "@/lib/environment/__tests__/environment-test-support";
import type { EpicShareableTeam } from "@/stores/auth/auth-store";
import { useAuthStore } from "@/stores/auth/auth-store";

/**
 * A chat on a host no team owns, in a team's task, names the settings its
 * host reports and offers to continue on one of that team's hosts. The first
 * use per person per team asks first. Host reads are mocked at the hook
 * boundary; settings classification uses real status fixtures.
 */

const mocks = vi.hoisted(() => {
  const epicTeam: { current: string | null } = { current: null };
  const tabHostTeam: { current: string | null } = { current: null };
  const hosts: { current: readonly HostListItem[] | null } = { current: null };
  const status: {
    current: EnvironmentStatusResponseV11 | null;
  } = { current: null };
  const statusError: { current: boolean } = { current: false };
  const supported: { current: boolean | null } = { current: true };
  const readiness: { current: boolean } = { current: true };
  const resolvedHostIds: string[] = [];
  const statusReadCalls: Array<{
    client: object | null;
    hostId: string | null;
    enabled: boolean;
  }> = [];
  const client = {};
  return {
    epicTeam,
    tabHostTeam,
    hosts,
    status,
    statusError,
    supported,
    readiness,
    resolvedHostIds,
    statusReadCalls,
    client,
  };
});

vi.mock("@/hooks/epics/use-epic-owning-team", () => ({
  useEpicOwningTeamId: (): string | null => mocks.epicTeam.current,
}));
vi.mock("@/hooks/sandboxes/use-on-team-sandbox", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/sandboxes/use-on-team-sandbox")
  >()),
  useHostOwnerTeamId: (): string | null => mocks.tabHostTeam.current,
}));
vi.mock("@/hooks/auth/use-registered-hosts-query", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/auth/use-registered-hosts-query")
  >()),
  useRegisteredHosts: () => ({
    data: mocks.hosts.current === null ? null : { hosts: mocks.hosts.current },
  }),
}));
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) => {
    if (hostId !== null) mocks.resolvedHostIds.push(hostId);
    return mocks.client;
  },
}));
vi.mock("@/hooks/host/use-reactive-host-readiness", () => ({
  useReactiveHostReadiness: () => ({ canExecute: mocks.readiness.current }),
}));
vi.mock("@/hooks/environment/use-environment-reads", () => ({
  useEnvironmentStatusRead: (
    client: object | null,
    hostId: string | null,
    enabled: boolean,
  ) => {
    mocks.statusReadCalls.push({ client, hostId, enabled });
    return {
      supported: mocks.supported.current,
      data: mocks.status.current,
      isError: mocks.statusError.current,
    };
  },
}));

import {
  TEAM_EPIC_PERSONAL_LINE,
  teamEpicContinueCaution,
  teamEpicContinueLabel,
  teamEpicPersonalNotice,
  teamEpicSettingsLine,
} from "@/components/chat/composer/team-epic-personal-line-model";
import { TeamEpicPersonalLine } from "@/components/chat/composer/team-epic-personal-line";
import {
  TEAM_CONTINUE_CAUTION_SEEN_CAP,
  teamContinueCautionSeen,
  useTeamContinueCautionSeenStore,
} from "@/stores/chats/team-continue-caution-seen-store";

const PERSIST_KEY = "traycer-gui-app:team-continue-caution-seen";
const VIEWER = "user-viewer";
const ACME: EpicShareableTeam = {
  teamId: "t1",
  slug: "acme",
  avatarUrl: null,
};
const BETA: EpicShareableTeam = {
  teamId: "t2",
  slug: "beta",
  avatarUrl: null,
};
const CAUTION =
  "Everything in this chat, including what people outside acme wrote, becomes the working context of an agent that holds acme's secrets.";

function hostOf(
  hostId: string,
  owner: HostOwnerPrincipal | undefined,
): HostListItem {
  return {
    hostId,
    displayName: hostId,
    platform: "linux",
    kind: owner?.kind === "team" ? "sandbox" : "personal",
    publicKey: `pk-${hostId}`,
    createdAt: "2026-10-01T00:00:00.000Z",
    status: {
      connectivity: "connectable",
      viewerReachability: "unknown",
      clientCloud: "ok",
      updateState: "current",
      appVersion: "1.5.0",
      lastSeenAt: "2026-10-09T00:00:00.000Z",
    },
    updatePolicy: "manual",
    ...(owner?.kind === "team"
      ? {
          sandboxState: "awake" as const,
          sandboxFrozen: false,
          profile: "agent" as const,
        }
      : {}),
    ...(owner === undefined ? {} : { owner }),
  };
}

function teamHost(hostId: string, teamId: string): HostListItem {
  return hostOf(hostId, { kind: "team", id: teamId, name: `Team ${teamId}` });
}

const REGISTRY: readonly HostListItem[] = [
  teamHost("h1", "t1"),
  teamHost("h2", "t1"),
  teamHost("h3", "t2"),
  hostOf("h4", { kind: "user", id: VIEWER }),
];

function setViewer(
  userId: string,
  teams: ReadonlyArray<EpicShareableTeam>,
): void {
  useAuthStore.setState({
    status: "signed-in",
    contextMetadata: { userId, username: "viewer" },
    shareableTeams: teams,
  });
}

function resetSeenStore(): void {
  window.localStorage.clear();
  useTeamContinueCautionSeenStore.setState({ seen: {} });
}

function markSeen(viewerUserId: string, teamId: string): void {
  useTeamContinueCautionSeenStore.getState().markSeen(viewerUserId, teamId);
}

function seenNow(viewerUserId: string, teamId: string): boolean {
  return teamContinueCautionSeen(
    useTeamContinueCautionSeenStore.getState().seen,
    viewerUserId,
    teamId,
  );
}

function renderLine(onContinue: (teamHostIds: ReadonlySet<string>) => void) {
  render(
    <TeamEpicPersonalLine
      epicId="epic-1"
      tabHostId="host-personal"
      onContinue={onContinue}
    />,
  );
}

function clickContinue(): void {
  fireEvent.click(screen.getByTestId("team-epic-continue"));
}

beforeEach(() => {
  resetSeenStore();
  mocks.epicTeam.current = "t1";
  mocks.tabHostTeam.current = null;
  mocks.hosts.current = REGISTRY;
  mocks.status.current = environmentStatusFixture({
    consent: { acceptedAt: 1, planHash: "accepted" },
  });
  mocks.statusError.current = false;
  mocks.supported.current = true;
  mocks.readiness.current = true;
  mocks.resolvedHostIds.length = 0;
  mocks.statusReadCalls.length = 0;
  setViewer(VIEWER, [ACME, BETA]);
});

afterEach(() => {
  cleanup();
  resetSeenStore();
  useAuthStore.setState({
    status: "signed-out",
    contextMetadata: null,
    shareableTeams: [],
  });
});

describe("teamEpicPersonalNotice", () => {
  it("names the task's team when the person is in it and the host is no team's", () => {
    expect(
      teamEpicPersonalNotice({
        epicTeamId: "t1",
        tabHostTeamId: null,
        teams: [ACME],
      }),
    ).toEqual({ teamId: "t1", slug: "acme" });
  });

  it("says nothing for a task no team owns", () => {
    expect(
      teamEpicPersonalNotice({
        epicTeamId: null,
        tabHostTeamId: null,
        teams: [ACME],
      }),
    ).toBeNull();
  });

  it("says nothing when the person is not in the task's team", () => {
    expect(
      teamEpicPersonalNotice({
        epicTeamId: "t1",
        tabHostTeamId: null,
        teams: [BETA],
      }),
    ).toBeNull();
  });

  it("says nothing when the chat already runs on that team's host", () => {
    expect(
      teamEpicPersonalNotice({
        epicTeamId: "t1",
        tabHostTeamId: "t1",
        teams: [ACME],
      }),
    ).toBeNull();
  });

  it("says nothing when the chat runs on another team's host", () => {
    expect(
      teamEpicPersonalNotice({
        epicTeamId: "t1",
        tabHostTeamId: "t2",
        teams: [ACME, BETA],
      }),
    ).toBeNull();
  });

  it("states the line, the action and the caution word for word", () => {
    expect(TEAM_EPIC_PERSONAL_LINE).toBe("Running on your Personal settings.");
    expect(teamEpicContinueLabel("acme")).toBe("Continue on a acme host");
    expect(teamEpicContinueCaution("acme")).toBe(CAUTION);
  });

  it("classifies local, moved, previously shared, moving, stopped and unread settings", () => {
    expect(
      teamEpicSettingsLine(
        environmentStatusFixture({
          principal: null,
          planes: { records: "local", broker: "local", room: "local" },
        }),
      ),
    ).toBe("Running on this computer's own settings.");
    expect(
      teamEpicSettingsLine(
        environmentStatusFixture({
          consent: { acceptedAt: 1, planHash: "accepted" },
        }),
      ),
    ).toBe(TEAM_EPIC_PERSONAL_LINE);
    expect(teamEpicSettingsLine(environmentStatusFixture({}))).toBe(
      TEAM_EPIC_PERSONAL_LINE,
    );
    expect(
      teamEpicSettingsLine(
        environmentStatusFixture({
          setup: { stage: "moving_settings", state: "running" },
        }),
      ),
    ).toBeNull();
    expect(
      teamEpicSettingsLine(
        environmentStatusFixture({
          setup: { stage: "moving_settings", state: "failed" },
        }),
      ),
    ).toBeNull();
    expect(teamEpicSettingsLine(null)).toBeNull();
  });
});

describe("<TeamEpicPersonalLine />", () => {
  it("is hidden when the task is no team's", () => {
    mocks.epicTeam.current = null;

    renderLine(vi.fn());

    expect(screen.queryByTestId("team-epic-personal-line")).toBeNull();
  });

  it("is hidden when the person is not in the task's team", () => {
    setViewer(VIEWER, [BETA]);

    renderLine(vi.fn());

    expect(screen.queryByTestId("team-epic-personal-line")).toBeNull();
  });

  it("is hidden when the chat is on the team's host", () => {
    mocks.tabHostTeam.current = "t1";

    renderLine(vi.fn());

    expect(screen.queryByTestId("team-epic-personal-line")).toBeNull();
  });

  it("is hidden when the chat is on another team's host", () => {
    mocks.tabHostTeam.current = "t2";

    renderLine(vi.fn());

    expect(screen.queryByTestId("team-epic-personal-line")).toBeNull();
  });

  it("says it runs on Personal settings and offers the team's host", () => {
    renderLine(vi.fn());

    const line = screen.getByTestId("team-epic-personal-line");
    expect(line.textContent).toContain("Running on your Personal settings.");
    expect(screen.getByTestId("team-epic-continue").textContent).toBe(
      "Continue on a acme host",
    );
  });

  it("resolves and reads the explicit tab host, and disables that read when readiness is false", () => {
    renderLine(vi.fn());
    expect(mocks.resolvedHostIds).toContain("host-personal");
    expect(mocks.statusReadCalls).toContainEqual({
      client: mocks.client,
      hostId: "host-personal",
      enabled: true,
    });

    cleanup();
    mocks.readiness.current = false;
    renderLine(vi.fn());
    expect(screen.queryByTestId("team-epic-personal-line")).toBeNull();
    expect(mocks.statusReadCalls.at(-1)).toEqual({
      client: mocks.client,
      hostId: "host-personal",
      enabled: false,
    });
  });

  it("hides stale status when the read errors", () => {
    mocks.statusError.current = true;
    renderLine(vi.fn());
    expect(screen.queryByTestId("team-epic-personal-line")).toBeNull();
  });

  it("hides unread and unsupported status instead of using an old value", () => {
    mocks.status.current = null;
    renderLine(vi.fn());
    expect(screen.queryByTestId("team-epic-personal-line")).toBeNull();

    cleanup();
    mocks.status.current = environmentStatusFixture({
      consent: { acceptedAt: 1, planHash: "accepted" },
    });
    mocks.supported.current = false;
    renderLine(vi.fn());
    expect(screen.queryByTestId("team-epic-personal-line")).toBeNull();
  });

  it("asks first when the person has not confirmed for this team", () => {
    const onContinue = vi.fn();
    renderLine(onContinue);

    clickContinue();

    expect(screen.getByTestId("team-epic-caution").textContent).toContain(
      CAUTION,
    );
    expect(onContinue).not.toHaveBeenCalled();
  });

  it("keeps the person where they are, and unmarked, when they cancel", async () => {
    const onContinue = vi.fn();
    renderLine(onContinue);
    clickContinue();

    fireEvent.click(screen.getByTestId("team-epic-caution-cancel"));

    await waitFor(() => {
      expect(screen.queryByTestId("team-epic-caution")).toBeNull();
    });
    expect(onContinue).not.toHaveBeenCalled();
    expect(seenNow(VIEWER, "t1")).toBe(false);
  });

  it("continues once on exactly the team's hosts after a confirm, and remembers it", async () => {
    const onContinue = vi.fn();
    renderLine(onContinue);
    clickContinue();

    fireEvent.click(screen.getByTestId("team-epic-caution-confirm"));

    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(onContinue.mock.calls[0]?.[0]).toEqual(new Set(["h1", "h2"]));
    expect(seenNow(VIEWER, "t1")).toBe(true);
    await waitFor(() => {
      expect(screen.queryByTestId("team-epic-caution")).toBeNull();
    });
  });

  it("does not ask the same person again for the same team", () => {
    markSeen(VIEWER, "t1");
    const onContinue = vi.fn();
    renderLine(onContinue);

    clickContinue();

    expect(screen.queryByTestId("team-epic-caution")).toBeNull();
    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(onContinue.mock.calls[0]?.[0]).toEqual(new Set(["h1", "h2"]));
  });

  it("asks a different person again", () => {
    markSeen("user-someone-else", "t1");
    const onContinue = vi.fn();
    renderLine(onContinue);

    clickContinue();

    expect(screen.getByTestId("team-epic-caution")).toBeTruthy();
    expect(onContinue).not.toHaveBeenCalled();
  });

  it("asks again for a different team", () => {
    markSeen(VIEWER, "t1");
    mocks.epicTeam.current = "t2";
    const onContinue = vi.fn();
    renderLine(onContinue);

    clickContinue();

    expect(screen.getByTestId("team-epic-caution").textContent).toContain(
      "outside beta",
    );
    expect(onContinue).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("team-epic-caution-confirm"));
    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(onContinue.mock.calls[0]?.[0]).toEqual(new Set(["h3"]));
  });

  it("disables the action when the team has no host in the registry", () => {
    mocks.hosts.current = [
      teamHost("h3", "t2"),
      hostOf("h4", { kind: "user", id: VIEWER }),
    ];
    const onContinue = vi.fn();
    renderLine(onContinue);

    const button = screen.getByTestId("team-epic-continue");
    expect(button.hasAttribute("disabled")).toBe(true);
    fireEvent.click(button);
    expect(screen.queryByTestId("team-epic-caution")).toBeNull();
    expect(onContinue).not.toHaveBeenCalled();
  });
});

describe("useTeamContinueCautionSeenStore", () => {
  it("answers false until a (viewer, team) pair is marked, and is per pair", () => {
    expect(seenNow(VIEWER, "t1")).toBe(false);

    markSeen(VIEWER, "t1");

    expect(seenNow(VIEWER, "t1")).toBe(true);
    expect(seenNow(VIEWER, "t2")).toBe(false);
    expect(seenNow("user-someone-else", "t1")).toBe(false);
  });

  it("persists under its own key", () => {
    markSeen(VIEWER, "t1");

    const raw = window.localStorage.getItem(PERSIST_KEY);
    if (raw === null) throw new Error("Expected a persisted blob");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || !("state" in parsed)) {
      throw new Error("Expected a persisted blob with a state");
    }
    const state = parsed.state;
    if (typeof state !== "object" || state === null || !("seen" in state)) {
      throw new Error("Expected a persisted state with a seen record");
    }
    const seen = state.seen;
    if (typeof seen !== "object" || seen === null) {
      throw new Error("Expected the seen record to be an object");
    }
    expect(Object.keys(seen)).toHaveLength(1);
  });

  it("is capped at 500 pairs", () => {
    expect(TEAM_CONTINUE_CAUTION_SEEN_CAP).toBe(500);
  });
});
