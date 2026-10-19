import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
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
import { reportTeamMemberRemovedClose } from "@traycer-clients/shared/host-transport/team-member-removed-close";

/**
 * Removal close: a team host ending the person's session with
 * `TEAM_MEMBER_REMOVED` is a second signal for the same removal the team list's
 * own loss reports. Whichever signal comes first closes the team's tiles on its
 * hosts and toasts once; the other finds the team already closed, so one
 * removal is one close and one toast, never two. The signal is driven here with
 * the real `reportTeamMemberRemovedClose` seam.
 */

interface MockHolders {
  readonly hosts: { current: readonly HostListItem[] | null };
  readonly toastInfo: Mock<(message: string) => void>;
}

const mocks = vi.hoisted((): MockHolders => {
  const hosts: { current: readonly HostListItem[] | null } = { current: null };
  const toastInfo = vi.fn<(message: string) => void>();
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

import { useCloseTilesOnTeamRemoval } from "@/hooks/teams/use-close-tiles-on-team-removal";

interface TeamEntry {
  readonly teamId: string;
  readonly slug: string;
  readonly avatarUrl: string | null;
}

const VIEWER = "user-viewer";
const ACME: TeamEntry = { teamId: "t1", slug: "acme-slug", avatarUrl: null };
const GLOBEX: TeamEntry = {
  teamId: "t2",
  slug: "globex-slug",
  avatarUrl: null,
};
const OTHER_TEAM: TeamEntry = {
  teamId: "t9",
  slug: "other-slug",
  avatarUrl: null,
};

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

function teamHost(
  hostId: string,
  team: TeamEntry,
  teamName: string,
): HostListItem {
  return hostOf(hostId, { kind: "team", id: team.teamId, name: teamName });
}

const H1 = teamHost("h1", ACME, "Acme");
const H2 = teamHost("h2", ACME, "Acme");
const H3 = teamHost("h3", GLOBEX, "Globex");

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

function signIn(userId: string, teams: readonly TeamEntry[]): void {
  useAuthStore.setState({
    status: "signed-in",
    contextMetadata: { userId, username: userId },
    shareableTeams: teams,
  });
}

function setTeams(teams: readonly TeamEntry[]): void {
  act(() => {
    useAuthStore.setState({ shareableTeams: teams });
  });
}

function fatalOn(hostId: string): void {
  act(() => {
    reportTeamMemberRemovedClose(hostId);
  });
}

/**
 * Wraps the store's real `closeTilesOnHosts` so a test sees every call (and
 * the tiles still close). The store is reset before each test, which also
 * drops the wrapper.
 */
function spyOnCloseTilesOnHosts(): Mock<
  (hostIds: ReadonlySet<string>) => number
> {
  const original = useEpicCanvasStore.getState().closeTilesOnHosts;
  const closeSpy = vi.fn<(hostIds: ReadonlySet<string>) => number>((hostIds) =>
    original(hostIds),
  );
  useEpicCanvasStore.setState({ closeTilesOnHosts: closeSpy });
  return closeSpy;
}

function toastedMessages(): readonly string[] {
  return mocks.toastInfo.mock.calls.map((call) => call[0]);
}

describe("useCloseTilesOnTeamRemoval: the TEAM_MEMBER_REMOVED close report", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useEpicCanvasStore.persist.setOptions({ name: epicCanvasKey(null) });
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    mocks.toastInfo.mockReset();
    mocks.hosts.current = [H1, H2, H3];
    signIn(VIEWER, [ACME, GLOBEX]);
  });
  afterEach(() => {
    cleanup();
    useAuthStore.setState({
      status: "signed-out",
      contextMetadata: null,
      shareableTeams: [],
    });
  });

  it("closes the team's hosts and toasts once on the fatal, and the team list losing the team afterwards adds neither", () => {
    const store = useEpicCanvasStore.getState();
    const tab = store.openEpicTab("epic-one", "One");
    const onH1 = tile("on-h1", "h1");
    const onH2 = tile("on-h2", "h2");
    const onH3 = tile("on-h3", "h3");
    store.openTileInTab(tab, onH1);
    store.openTileInTab(tab, onH2);
    store.openTileInTab(tab, onH3);
    const closeSpy = spyOnCloseTilesOnHosts();
    renderHook(() => {
      useCloseTilesOnTeamRemoval();
    });

    fatalOn("h1");

    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(closeSpy.mock.calls[0]?.[0]).toEqual(new Set(["h1", "h2"]));
    expect(isOpen(tab, onH1.instanceId)).toBe(false);
    expect(isOpen(tab, onH2.instanceId)).toBe(false);
    expect(isOpen(tab, onH3.instanceId)).toBe(true);
    expect(toastedMessages()).toEqual(["You are no longer a member of Acme."]);

    setTeams([GLOBEX]);

    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(toastedMessages()).toEqual(["You are no longer a member of Acme."]);
  });

  it("closes and toasts once when the team list drops the team first, and a later fatal adds neither", () => {
    const closeSpy = spyOnCloseTilesOnHosts();
    renderHook(() => {
      useCloseTilesOnTeamRemoval();
    });

    setTeams([GLOBEX]);

    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(closeSpy.mock.calls[0]?.[0]).toEqual(new Set(["h1", "h2"]));
    expect(toastedMessages()).toEqual(["You are no longer a member of Acme."]);

    fatalOn("h1");

    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(toastedMessages()).toEqual(["You are no longer a member of Acme."]);
  });

  it("closes and toasts once for two fatals on different hosts of the same team", () => {
    const closeSpy = spyOnCloseTilesOnHosts();
    renderHook(() => {
      useCloseTilesOnTeamRemoval();
    });

    fatalOn("h1");
    fatalOn("h2");

    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(closeSpy.mock.calls[0]?.[0]).toEqual(new Set(["h1", "h2"]));
    expect(toastedMessages()).toEqual(["You are no longer a member of Acme."]);
  });

  it("does nothing for a fatal on a host no remembered team owns", () => {
    const store = useEpicCanvasStore.getState();
    const tab = store.openEpicTab("epic-one", "One");
    const onH1 = tile("on-h1", "h1");
    store.openTileInTab(tab, onH1);
    const closeSpy = spyOnCloseTilesOnHosts();
    renderHook(() => {
      useCloseTilesOnTeamRemoval();
    });

    fatalOn("host-nobody-owns");

    expect(closeSpy).not.toHaveBeenCalled();
    expect(mocks.toastInfo).not.toHaveBeenCalled();
    expect(isOpen(tab, onH1.instanceId)).toBe(true);
  });

  it("closes only the fatal's team, and the other team's own removal still closes and toasts once", () => {
    const store = useEpicCanvasStore.getState();
    const tab = store.openEpicTab("epic-one", "One");
    const onH1 = tile("on-h1", "h1");
    const onH3 = tile("on-h3", "h3");
    store.openTileInTab(tab, onH1);
    store.openTileInTab(tab, onH3);
    const closeSpy = spyOnCloseTilesOnHosts();
    renderHook(() => {
      useCloseTilesOnTeamRemoval();
    });

    fatalOn("h1");

    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(closeSpy.mock.calls[0]?.[0]).toEqual(new Set(["h1", "h2"]));
    expect(toastedMessages()).toEqual(["You are no longer a member of Acme."]);
    expect(isOpen(tab, onH1.instanceId)).toBe(false);
    expect(isOpen(tab, onH3.instanceId)).toBe(true);

    setTeams([ACME]);

    expect(closeSpy).toHaveBeenCalledTimes(2);
    expect(closeSpy.mock.calls[1]?.[0]).toEqual(new Set(["h3"]));
    expect(toastedMessages()).toEqual([
      "You are no longer a member of Acme.",
      "You are no longer a member of Globex.",
    ]);
    expect(isOpen(tab, onH3.instanceId)).toBe(false);
  });

  it("forgets the previous viewer's teams, so a fatal after the viewer changes does nothing", () => {
    const store = useEpicCanvasStore.getState();
    const tab = store.openEpicTab("epic-one", "One");
    const onH1 = tile("on-h1", "h1");
    store.openTileInTab(tab, onH1);
    const closeSpy = spyOnCloseTilesOnHosts();
    renderHook(() => {
      useCloseTilesOnTeamRemoval();
    });

    // The registry still lists h1 as Acme's, so only the memory reset keeps
    // the new viewer (who is in no team that owns h1) from closing it.
    act(() => {
      signIn("user-someone-else", [OTHER_TEAM]);
    });
    fatalOn("h1");

    expect(closeSpy).not.toHaveBeenCalled();
    expect(mocks.toastInfo).not.toHaveBeenCalled();
    expect(isOpen(tab, onH1.instanceId)).toBe(true);
  });
});
