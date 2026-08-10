import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TestRouterProvider } from "@/__tests__/with-test-router";
import type { HistoryItem } from "@/components/home/data/home-page.data";
import { activateTabIntent } from "@/lib/tab-navigation";
import { useActiveProjectProfileStore } from "@/stores/profiles/active-project-profile-store";
import { useHistoryMembershipCacheStore } from "@/stores/profiles/history-membership-cache-store";
import { useProjectProfilesStore } from "@/stores/profiles/project-profiles-store";
import { useTabsStore } from "@/stores/tabs/store";
import {
  __resetProfileLaunchLandingForTesting,
  ProfileLaunchLanding,
} from "../profile-launch-landing";

const mockNavigate = vi.fn(() => Promise.resolve());
let mockPathname = "/";

vi.mock("@tanstack/react-router", async (importActual) => {
  const actual = await importActual<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useRouterState: (opts: {
      readonly select: (state: {
        readonly location: { readonly pathname: string };
      }) => string;
    }) => opts.select({ location: { pathname: mockPathname } }),
  };
});

vi.mock("@/lib/tab-navigation", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/tab-navigation")>();
  return { ...actual, activateTabIntent: vi.fn(() => true) };
});

function renderLanding(): ReturnType<typeof render> {
  return render(
    <TestRouterProvider>
      <ProfileLaunchLanding />
    </TestRouterProvider>,
  );
}

function historyItem(overrides: {
  readonly epicId: string;
  readonly updatedAtMs: number;
  readonly linkedWorkspaces: ReadonlyArray<{
    readonly hostId: string;
    readonly workspacePath: string;
  }>;
}): HistoryItem {
  return {
    id: overrides.epicId,
    epicId: overrides.epicId,
    taskType: "epic",
    title: overrides.epicId,
    initialUserPrompt: "",
    updatedAtMs: overrides.updatedAtMs,
    updatedLabel: "",
    updatedBucket: "today",
    linkedRepos: [],
    linkedWorkspaces: overrides.linkedWorkspaces,
    pullRequestNumbers: [],
    worktreeBranches: [],
    worktreePaths: [],
    ownership: "mine",
    permissionRole: null,
    isPinned: false,
  };
}

function resetStores(): void {
  useProjectProfilesStore.getState().resetForTests();
  useActiveProjectProfileStore.getState().resetForTests();
  useHistoryMembershipCacheStore.getState().resetForTests();
  useTabsStore.setState({ stripOrder: [] });
}

function expectDraftRedirect(times = 1): void {
  expect(mockNavigate).toHaveBeenCalledTimes(times);
  expect(mockNavigate).toHaveBeenCalledWith({
    to: "/draft/new",
    replace: true,
  });
}

describe("ProfileLaunchLanding", () => {
  beforeEach(() => {
    vi.mocked(activateTabIntent).mockClear();
    mockNavigate.mockClear();
    mockPathname = "/";
    __resetProfileLaunchLandingForTesting();
    resetStores();
    useProjectProfilesStore.getState().createProfile({
      name: "Acme",
      icon: "rocket",
      color: "blue",
      folders: [{ path: "/Users/x/Acme", hostId: "h1" }],
    });
  });

  afterEach(() => {
    cleanup();
    resetStores();
  });

  it("redirects once per launch into the active project's most recent owned epic", async () => {
    const profile = useProjectProfilesStore.getState().profiles[0];
    useActiveProjectProfileStore.getState().setActiveProfile(profile.id);
    useHistoryMembershipCacheStore.getState().setMembershipItems([
      historyItem({
        epicId: "owned",
        updatedAtMs: 100,
        linkedWorkspaces: [
          { hostId: "h1", workspacePath: "/Users/x/Acme" },
        ],
      }),
    ]);

    renderLanding();

    await waitFor(() => {
      expect(vi.mocked(activateTabIntent)).toHaveBeenCalledTimes(1);
    });
    const call = vi.mocked(activateTabIntent).mock.calls[0];
    expect(call[1]).toMatchObject({ kind: "open-epic", epicId: "owned" });
    expect(call[2]).toEqual({ replace: true });

    // A later cache update must NOT redirect again (consumed once) and must
    // NOT clobber the queued jump with the draft fallback (jump pending).
    useHistoryMembershipCacheStore.getState().setMembershipItems([
      historyItem({
        epicId: "owned-newer",
        updatedAtMs: 200,
        linkedWorkspaces: [
          { hostId: "h1", workspacePath: "/Users/x/Acme" },
        ],
      }),
    ]);
    await waitFor(() => {
      expect(
        useHistoryMembershipCacheStore.getState().itemsByEpicId.size,
      ).toBe(1);
    });
    expect(vi.mocked(activateTabIntent)).toHaveBeenCalledTimes(1);
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("waits for a cold membership cache, then redirects when it warms", async () => {
    const profile = useProjectProfilesStore.getState().profiles[0];
    useActiveProjectProfileStore.getState().setActiveProfile(profile.id);

    renderLanding();
    expect(vi.mocked(activateTabIntent)).not.toHaveBeenCalled();
    // Cold cache: no draft fallback either — the pending jump must win.
    expect(mockNavigate).not.toHaveBeenCalled();

    useHistoryMembershipCacheStore.getState().setMembershipItems([
      historyItem({
        epicId: "owned",
        updatedAtMs: 100,
        linkedWorkspaces: [
          { hostId: "h1", workspacePath: "/Users/x/Acme" },
        ],
      }),
    ]);

    await waitFor(() => {
      expect(vi.mocked(activateTabIntent)).toHaveBeenCalledTimes(1);
    });
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("goes to a fresh draft when no profile is active and the strip is empty", async () => {
    useHistoryMembershipCacheStore.getState().setMembershipItems([
      historyItem({
        epicId: "owned",
        updatedAtMs: 100,
        linkedWorkspaces: [
          { hostId: "h1", workspacePath: "/Users/x/Acme" },
        ],
      }),
    ]);

    renderLanding();

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalled();
    });
    expect(vi.mocked(activateTabIntent)).not.toHaveBeenCalled();
    expectDraftRedirect();
  });

  it("goes to a fresh draft when the active project owns no epic", async () => {
    const profile = useProjectProfilesStore.getState().profiles[0];
    useActiveProjectProfileStore.getState().setActiveProfile(profile.id);
    useHistoryMembershipCacheStore.getState().setMembershipItems([
      historyItem({
        epicId: "foreign",
        updatedAtMs: 100,
        linkedWorkspaces: [{ hostId: "h1", workspacePath: "/Users/x/Bkza" }],
      }),
    ]);

    renderLanding();

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalled();
    });
    expect(vi.mocked(activateTabIntent)).not.toHaveBeenCalled();
    expectDraftRedirect();
  });

  it("does not draft-redirect while a live tab strip owns the surface", async () => {
    useTabsStore.setState({
      stripOrder: [{ kind: "epic", id: "live-epic" }],
    });

    renderLanding();

    await waitFor(() => {
      expect(useTabsStore.getState().stripOrder.length).toBe(1);
    });
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(vi.mocked(activateTabIntent)).not.toHaveBeenCalled();
  });

  it("never re-fires the draft redirect off the `/` pathname", async () => {
    // A failed /draft/new resolution re-renders RootLandingPage (and this
    // component) at /draft/new — the fallback must not loop.
    mockPathname = "/draft/new";

    renderLanding();

    await waitFor(() => {
      expect(mockPathname).toBe("/draft/new");
    });
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(vi.mocked(activateTabIntent)).not.toHaveBeenCalled();
  });
});
