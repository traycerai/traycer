import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type {
  HostListItem,
  HostOwnerPrincipal,
} from "@traycer/protocol/host/host-status";
import type {
  EpicCanvasState,
  EpicCanvasTileRef,
} from "@/stores/epics/canvas/types";
import { epicCanvasKey } from "@/lib/persist";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { CHAT_A } from "@/stores/epics/canvas/__tests__/canvas-test-fixtures";

/**
 * Leaving a team closes the person's open tiles on that team's hosts and says
 * so once. The hook remembers a team's host ids and name while the person is in
 * it, because by the time the team has left the list the registry may no longer
 * name them.
 */

const mocks = vi.hoisted(() => {
  const hosts: { current: readonly HostListItem[] | null } = { current: null };
  const toastInfo = vi.fn();
  return { hosts, toastInfo };
});

vi.mock("sonner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("sonner")>()),
  toast: {
    info: mocks.toastInfo,
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    message: vi.fn(),
    dismiss: vi.fn(),
  },
}));
vi.mock("@/hooks/auth/use-registered-hosts-query", () => ({
  useRegisteredHosts: () => ({
    data: mocks.hosts.current === null ? null : { hosts: mocks.hosts.current },
  }),
}));

import { removedTeamIds } from "@/hooks/teams/team-removal-model";
import { useCloseTilesOnTeamRemoval } from "@/hooks/teams/use-close-tiles-on-team-removal";

const VIEWER = "user-viewer";
const ALPHA = { teamId: "team-a", slug: "alpha-slug", avatarUrl: null };
const BETA = { teamId: "team-b", slug: "beta-slug", avatarUrl: null };

describe("removedTeamIds", () => {
  it("returns the ids in previous that are not in next, in previous order", () => {
    expect(removedTeamIds(["a", "b", "c", "d"], ["c", "a"])).toEqual([
      "b",
      "d",
    ]);
  });

  it("returns nothing when the list is unchanged, reordered or only grew", () => {
    expect(removedTeamIds(["a", "b"], ["a", "b"])).toEqual([]);
    expect(removedTeamIds(["a", "b"], ["b", "a"])).toEqual([]);
    expect(removedTeamIds(["a"], ["a", "b"])).toEqual([]);
    expect(removedTeamIds([], ["a"])).toEqual([]);
  });

  it("returns every id when the next list is empty", () => {
    expect(removedTeamIds(["a", "b"], [])).toEqual(["a", "b"]);
  });
});

function tile(id: string, hostId: string): EpicCanvasTileRef {
  return { ...CHAT_A, id, instanceId: `inst-${id}`, hostId };
}

function requireCanvas(tabId: string): EpicCanvasState {
  const canvas = useEpicCanvasStore.getState().canvasByTabId[tabId];
  if (canvas === undefined) throw new Error(`Expected canvas for ${tabId}`);
  return canvas;
}

function isOpen(tabId: string, instanceId: string): boolean {
  return requireCanvas(tabId).tilesByInstanceId[instanceId] !== undefined;
}

beforeEach(() => {
  window.localStorage.clear();
  useEpicCanvasStore.persist.setOptions({ name: epicCanvasKey(null) });
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
});

describe("useEpicCanvasStore.closeTilesOnHosts", () => {
  it("closes every open tile on the named hosts across tabs, keeps the rest, and returns the count", () => {
    const store = useEpicCanvasStore.getState();
    const firstTab = store.openEpicTab("epic-one", "One");
    const secondTab = store.openEpicTab("epic-two", "Two");
    const onTeam = tile("on-team", "host-team");
    const onSecondTeamHost = tile("on-team-2", "host-team-2");
    const onOther = tile("on-other", "host-other");
    const alsoOnTeam = tile("also-on-team", "host-team");
    const alsoOnOther = tile("also-on-other", "host-other");
    store.openTileInTab(firstTab, onTeam);
    store.openTileInTab(firstTab, onOther);
    store.openTileInTab(firstTab, onSecondTeamHost);
    store.openTileInTab(secondTab, alsoOnTeam);
    store.openTileInTab(secondTab, alsoOnOther);

    const closed = useEpicCanvasStore
      .getState()
      .closeTilesOnHosts(new Set(["host-team", "host-team-2"]));

    expect(closed).toBe(3);
    expect(isOpen(firstTab, onTeam.instanceId)).toBe(false);
    expect(isOpen(firstTab, onSecondTeamHost.instanceId)).toBe(false);
    expect(isOpen(secondTab, alsoOnTeam.instanceId)).toBe(false);
    expect(isOpen(firstTab, onOther.instanceId)).toBe(true);
    expect(isOpen(secondTab, alsoOnOther.instanceId)).toBe(true);
  });

  it("closes nothing and returns 0 for an empty set or hosts with no tiles", () => {
    const store = useEpicCanvasStore.getState();
    const tab = store.openEpicTab("epic-one", "One");
    const kept = tile("kept", "host-other");
    store.openTileInTab(tab, kept);

    expect(useEpicCanvasStore.getState().closeTilesOnHosts(new Set())).toBe(0);
    expect(
      useEpicCanvasStore.getState().closeTilesOnHosts(new Set(["host-none"])),
    ).toBe(0);
    expect(isOpen(tab, kept.instanceId)).toBe(true);
  });
});

function hostOf(hostId: string, owner: HostOwnerPrincipal): HostListItem {
  return {
    hostId,
    displayName: hostId,
    platform: "linux",
    kind: "sandbox",
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
    sandboxState: "awake",
    sandboxFrozen: false,
    profile: "agent",
    owner,
  };
}

const ALPHA_HOST = hostOf("host-alpha", {
  kind: "team",
  id: ALPHA.teamId,
  name: "Alpha Team",
});
const BETA_HOST = hostOf("host-beta", {
  kind: "team",
  id: BETA.teamId,
  name: "Beta Team",
});

function signIn(
  userId: string,
  teams: readonly { teamId: string; slug: string; avatarUrl: string | null }[],
): void {
  useAuthStore.setState({
    status: "signed-in",
    contextMetadata: { userId, username: userId },
    shareableTeams: teams,
  });
}

function setTeams(
  teams: readonly { teamId: string; slug: string; avatarUrl: string | null }[],
): void {
  act(() => {
    useAuthStore.setState({ shareableTeams: teams });
  });
}

interface SeededTiles {
  readonly tab: string;
  readonly alpha: EpicCanvasTileRef;
  readonly beta: EpicCanvasTileRef;
  readonly local: EpicCanvasTileRef;
}

function seedTiles(): SeededTiles {
  const store = useEpicCanvasStore.getState();
  const tab = store.openEpicTab("epic-one", "One");
  const alpha = tile("alpha-chat", ALPHA_HOST.hostId);
  const beta = tile("beta-chat", BETA_HOST.hostId);
  const local = tile("local-chat", "host-local");
  store.openTileInTab(tab, alpha);
  store.openTileInTab(tab, beta);
  store.openTileInTab(tab, local);
  return { tab, alpha, beta, local };
}

describe("useCloseTilesOnTeamRemoval", () => {
  beforeEach(() => {
    mocks.toastInfo.mockReset();
    mocks.hosts.current = [ALPHA_HOST, BETA_HOST];
    signIn(VIEWER, [ALPHA, BETA]);
  });
  afterEach(() => {
    cleanup();
    useAuthStore.setState({
      status: "signed-out",
      contextMetadata: null,
      shareableTeams: [],
    });
  });

  it("closes the removed team's tiles and toasts with the registry's team name", () => {
    const seeded = seedTiles();
    renderHook(() => {
      useCloseTilesOnTeamRemoval();
    });

    setTeams([BETA]);

    expect(isOpen(seeded.tab, seeded.alpha.instanceId)).toBe(false);
    expect(isOpen(seeded.tab, seeded.beta.instanceId)).toBe(true);
    expect(isOpen(seeded.tab, seeded.local.instanceId)).toBe(true);
    expect(mocks.toastInfo).toHaveBeenCalledTimes(1);
    expect(mocks.toastInfo.mock.calls[0]?.[0]).toBe(
      "You are no longer a member of Alpha Team.",
    );
  });

  it("falls back to the slug when no host of the team was ever known", () => {
    mocks.hosts.current = [BETA_HOST];
    const seeded = seedTiles();
    renderHook(() => {
      useCloseTilesOnTeamRemoval();
    });

    setTeams([BETA]);

    expect(mocks.toastInfo).toHaveBeenCalledTimes(1);
    expect(mocks.toastInfo.mock.calls[0]?.[0]).toBe(
      "You are no longer a member of alpha-slug.",
    );
    expect(isOpen(seeded.tab, seeded.beta.instanceId)).toBe(true);
    expect(isOpen(seeded.tab, seeded.local.instanceId)).toBe(true);
  });

  it("still closes hosts it remembered after the registry stopped listing them", () => {
    const seeded = seedTiles();
    const { rerender } = renderHook(() => {
      useCloseTilesOnTeamRemoval();
    });
    mocks.hosts.current = [];
    rerender();

    setTeams([BETA]);

    expect(isOpen(seeded.tab, seeded.alpha.instanceId)).toBe(false);
    expect(isOpen(seeded.tab, seeded.beta.instanceId)).toBe(true);
    expect(mocks.toastInfo.mock.calls[0]?.[0]).toBe(
      "You are no longer a member of Alpha Team.",
    );
  });

  it("does nothing on sign-out", () => {
    const seeded = seedTiles();
    renderHook(() => {
      useCloseTilesOnTeamRemoval();
    });

    act(() => {
      useAuthStore.setState({
        status: "signed-out",
        contextMetadata: null,
        shareableTeams: [],
      });
    });

    expect(isOpen(seeded.tab, seeded.alpha.instanceId)).toBe(true);
    expect(isOpen(seeded.tab, seeded.beta.instanceId)).toBe(true);
    expect(mocks.toastInfo).not.toHaveBeenCalled();
  });

  it("does nothing when the viewer changes, even though the team list changed with them", () => {
    const seeded = seedTiles();
    renderHook(() => {
      useCloseTilesOnTeamRemoval();
    });

    act(() => {
      signIn("user-someone-else", [BETA]);
    });

    expect(isOpen(seeded.tab, seeded.alpha.instanceId)).toBe(true);
    expect(isOpen(seeded.tab, seeded.beta.instanceId)).toBe(true);
    expect(mocks.toastInfo).not.toHaveBeenCalled();
  });

  it("does nothing when the team list is unchanged", () => {
    const seeded = seedTiles();
    renderHook(() => {
      useCloseTilesOnTeamRemoval();
    });

    setTeams([ALPHA, BETA]);
    setTeams([BETA, ALPHA]);

    expect(isOpen(seeded.tab, seeded.alpha.instanceId)).toBe(true);
    expect(isOpen(seeded.tab, seeded.beta.instanceId)).toBe(true);
    expect(mocks.toastInfo).not.toHaveBeenCalled();
  });

  it("does nothing when a team is added", () => {
    signIn(VIEWER, [BETA]);
    const seeded = seedTiles();
    renderHook(() => {
      useCloseTilesOnTeamRemoval();
    });

    setTeams([BETA, ALPHA]);

    expect(isOpen(seeded.tab, seeded.alpha.instanceId)).toBe(true);
    expect(isOpen(seeded.tab, seeded.beta.instanceId)).toBe(true);
    expect(mocks.toastInfo).not.toHaveBeenCalled();
  });
});
