import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ProfileTabWorkspaceBridgeCore,
  startProfileTabWorkspaceController,
  type ProfileTabRouteSource,
} from "@/providers/profile-tab-workspace-bridge";
import {
  WindowsBridgeContext,
  type WindowsBridgeContextValue,
} from "@/providers/windows-bridge-context";
import { useActiveProjectProfileStore } from "@/stores/profiles/active-project-profile-store";
import { useHistoryMembershipCacheStore } from "@/stores/profiles/history-membership-cache-store";
import { useProjectProfilesStore } from "@/stores/profiles/project-profiles-store";
import {
  ALL_PROJECTS_TAB_BUCKET,
  profileTabBucket,
  useProfileTabWorkspacesStore,
} from "@/stores/profiles/profile-tab-workspaces-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import {
  emptyTabStripLayout,
  flattenLayoutRefs,
  tabItemId,
  type PersistedTabStripLayout,
} from "@/stores/tabs/layout";
import { readTabStripLayout, useTabsStore } from "@/stores/tabs/store";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";
import { profileTabWorkspacesKey } from "@/lib/persist/keys";

const WORKSPACES_KEY = profileTabWorkspacesKey(null);

function stubRoute(pathname: string): {
  readonly route: ProfileTabRouteSource;
  readonly navigateHome: ReturnType<typeof vi.fn>;
} {
  const navigateHome = vi.fn();
  return {
    route: { pathname: () => pathname, navigateHome },
    navigateHome,
  };
}

function layoutWithEpic(tabId: string): PersistedTabStripLayout {
  const ref = { kind: "epic" as const, id: tabId };
  return {
    version: 2,
    items: [{ kind: "tab", id: tabItemId(ref), ref }],
    activeItemId: tabItemId(ref),
    systemTabs: { history: null, settings: null },
    activationHistory: [ref],
  };
}

function layoutWithDraft(draftId: string): PersistedTabStripLayout {
  const ref = { kind: "draft" as const, id: draftId };
  return {
    version: 2,
    items: [{ kind: "tab", id: tabItemId(ref), ref }],
    activeItemId: tabItemId(ref),
    systemTabs: { history: null, settings: null },
    activationHistory: [ref],
  };
}

function seedCanvasEpic(tabId: string, epicId: string, name: string): void {
  useEpicCanvasStore.getState().openEpicTabWithId(tabId, epicId, name);
}

function seedStrip(layout: PersistedTabStripLayout): void {
  useTabsStore.setState({
    ...layout,
    stripOrder: flattenLayoutRefs(layout),
  });
}

function resetAll(): void {
  window.localStorage.clear();
  useProfileTabWorkspacesStore.persist.setOptions({ name: WORKSPACES_KEY });
  useProfileTabWorkspacesStore.getState().resetForTests();
  useActiveProjectProfileStore.getState().resetForTests();
  useProjectProfilesStore.getState().resetForTests();
  useHistoryMembershipCacheStore.getState().resetForTests();
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  useTabsStore.setState({
    ...emptyTabStripLayout(),
    stripOrder: [],
  });
  tabCommandCoordinator.resetReconciliationForTesting();
}

describe("profile tab workspaces controller", () => {
  let dispose: (() => void) | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    resetAll();
  });

  afterEach(() => {
    dispose?.();
    dispose = null;
    resetAll();
    vi.useRealTimers();
    cleanup();
  });

  it("switch A→B saves A's strip and restores B's; switch back re-applies A", () => {
    seedCanvasEpic("tab-a", "epic-a", "Alpha");
    seedCanvasEpic("tab-b", "epic-b", "Beta");
    const layoutA = layoutWithEpic("tab-a");
    const layoutB = layoutWithEpic("tab-b");

    useActiveProjectProfileStore.getState().setActiveProfile("profile-a");
    seedStrip(layoutA);
    dispose = startProfileTabWorkspaceController(stubRoute("/").route);

    act(() => {
      useActiveProjectProfileStore.getState().setActiveProfile("profile-b");
    });
    // B has no bucket yet → empty strip
    expect(flattenLayoutRefs(readTabStripLayout())).toEqual([]);
    expect(
      useProfileTabWorkspacesStore.getState().layoutsByBucket["profile-a"],
    ).toEqual(layoutA);

    // Give B its own strip, then switch back.
    seedStrip(layoutB);
    act(() => {
      useActiveProjectProfileStore.getState().setActiveProfile("profile-a");
    });

    expect(flattenLayoutRefs(readTabStripLayout())).toEqual([
      { kind: "epic", id: "tab-a" },
    ]);
    expect(
      useProfileTabWorkspacesStore.getState().layoutsByBucket["profile-b"],
    ).toEqual(layoutB);
  });

  it("B with no bucket yields an empty strip after switch", () => {
    seedCanvasEpic("tab-a", "epic-a", "Alpha");
    seedStrip(layoutWithEpic("tab-a"));
    dispose = startProfileTabWorkspaceController(stubRoute("/").route);

    act(() => {
      useActiveProjectProfileStore.getState().setActiveProfile("profile-b");
    });

    expect(readTabStripLayout()).toMatchObject({
      items: [],
      activeItemId: null,
    });
    expect(flattenLayoutRefs(readTabStripLayout())).toEqual([]);
  });

  it("write-through updates the active bucket after debounce", async () => {
    seedCanvasEpic("tab-a", "epic-a", "Alpha");
    seedStrip(layoutWithEpic("tab-a"));
    dispose = startProfileTabWorkspaceController(stubRoute("/").route);

    // Mutate layout while active (all-projects bucket).
    seedCanvasEpic("tab-c", "epic-c", "Gamma");
    act(() => {
      useTabsStore.getState().ensurePresent({ kind: "epic", id: "tab-c" });
    });

    expect(
      useProfileTabWorkspacesStore.getState().layoutsByBucket[
        ALL_PROJECTS_TAB_BUCKET
      ],
    ).toBeUndefined();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    const saved =
      useProfileTabWorkspacesStore.getState().layoutsByBucket[
        ALL_PROJECTS_TAB_BUCKET
      ];
    expect(saved).toBeDefined();
    expect(flattenLayoutRefs(saved ?? emptyTabStripLayout())).toEqual(
      expect.arrayContaining([
        { kind: "epic", id: "tab-a" },
        { kind: "epic", id: "tab-c" },
      ]),
    );
  });

  it("dropBucket removes a profile's saved strip", () => {
    useProfileTabWorkspacesStore
      .getState()
      .saveLayout("profile-a", layoutWithEpic("tab-a"));
    useProfileTabWorkspacesStore
      .getState()
      .dropBucket(profileTabBucket("profile-a"));

    expect(
      useProfileTabWorkspacesStore.getState().layoutsByBucket["profile-a"],
    ).toBeUndefined();
  });

  it("dispose flushes a pending write-through (a close is never dropped)", () => {
    seedCanvasEpic("tab-a", "epic-a", "Alpha");
    seedStrip(layoutWithEpic("tab-a"));
    dispose = startProfileTabWorkspaceController(stubRoute("/").route);

    // Close the only tab: the write-through is debounced, not yet saved.
    act(() => {
      seedStrip(emptyTabStripLayout());
    });
    expect(
      useProfileTabWorkspacesStore.getState().layoutsByBucket[
        ALL_PROJECTS_TAB_BUCKET
      ],
    ).toBeUndefined();

    // Teardown inside the debounce window must still persist the close.
    dispose();
    dispose = null;

    const saved =
      useProfileTabWorkspacesStore.getState().layoutsByBucket[
        ALL_PROJECTS_TAB_BUCKET
      ];
    expect(saved).toBeDefined();
    expect(flattenLayoutRefs(saved ?? emptyTabStripLayout())).toEqual([]);
  });

  it("restoring a snapshot with an unknown epic ref heals without throw", () => {
    seedCanvasEpic("tab-known", "epic-known", "Known");
    // Save a layout that also references a tab that is not a live source.
    const mixed: PersistedTabStripLayout = {
      version: 2,
      items: [
        {
          kind: "tab",
          id: tabItemId({ kind: "epic", id: "tab-known" }),
          ref: { kind: "epic", id: "tab-known" },
        },
        {
          kind: "tab",
          id: tabItemId({ kind: "epic", id: "tab-ghost" }),
          ref: { kind: "epic", id: "tab-ghost" },
        },
      ],
      activeItemId: tabItemId({ kind: "epic", id: "tab-known" }),
      systemTabs: { history: null, settings: null },
      activationHistory: [
        { kind: "epic", id: "tab-known" },
        { kind: "epic", id: "tab-ghost" },
      ],
    };
    useProfileTabWorkspacesStore.getState().saveLayout("profile-a", mixed);
    seedStrip(emptyTabStripLayout());
    dispose = startProfileTabWorkspaceController(stubRoute("/").route);

    expect(() => {
      act(() => {
        useActiveProjectProfileStore.getState().setActiveProfile("profile-a");
      });
    }).not.toThrow();

    // Ghost ref is dropped by restoreHydratedLayout; known source remains.
    expect(flattenLayoutRefs(readTabStripLayout())).toEqual([
      { kind: "epic", id: "tab-known" },
    ]);
  });

  it("hydration gate: bridge does not start until windows bridge is hydrated", () => {
    seedCanvasEpic("tab-a", "epic-a", "Alpha");
    const layoutA = layoutWithEpic("tab-a");
    seedStrip(layoutA);
    useProfileTabWorkspacesStore
      .getState()
      .saveLayout("profile-a", layoutWithEpic("tab-preexisting"));

    const pendingValue: WindowsBridgeContextValue = {
      bridge: null,
      hasHydrated: false,
    };

    const { rerender } = render(
      <WindowsBridgeContext.Provider value={pendingValue}>
        <ProfileTabWorkspaceBridgeCore route={stubRoute("/").route} />
      </WindowsBridgeContext.Provider>,
    );

    // Profile switch before hydration must not clobber buckets or strip.
    act(() => {
      useActiveProjectProfileStore.getState().setActiveProfile("profile-a");
    });

    expect(readTabStripLayout()).toEqual(
      expect.objectContaining({
        items: layoutA.items,
        activeItemId: layoutA.activeItemId,
      }),
    );
    // Outgoing all-projects bucket must not have been written from the
    // pre-hydration strip.
    expect(
      useProfileTabWorkspacesStore.getState().layoutsByBucket[
        ALL_PROJECTS_TAB_BUCKET
      ],
    ).toBeUndefined();
    // Pre-existing profile-a bucket remains untouched.
    expect(
      flattenLayoutRefs(
        useProfileTabWorkspacesStore.getState().layoutsByBucket["profile-a"] ??
          emptyTabStripLayout(),
      ),
    ).toEqual([{ kind: "epic", id: "tab-preexisting" }]);

    // After hydration, controller starts; a subsequent switch swaps.
    seedStrip(layoutA);
    useActiveProjectProfileStore.getState().setActiveProfile(null);
    rerender(
      <WindowsBridgeContext.Provider
        value={{ bridge: null, hasHydrated: true }}
      >
        <ProfileTabWorkspaceBridgeCore route={stubRoute("/").route} />
      </WindowsBridgeContext.Provider>,
    );

    act(() => {
      useActiveProjectProfileStore.getState().setActiveProfile("profile-a");
    });

    // Restores the pre-existing profile-a snapshot (ghost source drops).
    expect(flattenLayoutRefs(readTabStripLayout())).toEqual([]);
    expect(
      useProfileTabWorkspacesStore.getState().layoutsByBucket[
        ALL_PROJECTS_TAB_BUCKET
      ],
    ).toEqual(layoutA);
  });
});

describe("profile switch releases foreign active routes", () => {
  let dispose: (() => void) | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    resetAll();
    useProjectProfilesStore.getState().createProfile({
      name: "Buzz",
      icon: "zap",
      color: "orange",
      folders: [{ path: "/Users/x/Buzz", hostId: "h1" }],
    });
  });

  afterEach(() => {
    dispose?.();
    dispose = null;
    resetAll();
    vi.useRealTimers();
    cleanup();
  });

  function seedMembership(
    epicId: string,
    workspacePaths: ReadonlyArray<string>,
  ): void {
    useHistoryMembershipCacheStore.getState().setMembershipItems([
      {
        id: epicId,
        epicId,
        taskType: "epic",
        title: epicId,
        initialUserPrompt: "",
        updatedAtMs: 100,
        updatedLabel: "",
        updatedBucket: "today",
        linkedRepos: [],
        linkedWorkspaces: workspacePaths.map((workspacePath) => ({
          hostId: "h1",
          workspacePath,
        })),
        pullRequestNumbers: [],
        worktreeBranches: [],
        worktreePaths: [],
        ownership: "mine",
        permissionRole: null,
        isPinned: false,
      },
    ]);
  }

  function switchFromEpicRoute(epicId: string): ReturnType<typeof vi.fn> {
    const buzz = useProjectProfilesStore.getState().profiles[0];
    seedCanvasEpic(`tab-${epicId}`, epicId, epicId);
    seedStrip(layoutWithEpic(`tab-${epicId}`));
    const { route, navigateHome } = stubRoute(`/epics/${epicId}`);
    dispose = startProfileTabWorkspaceController(route);
    act(() => {
      useActiveProjectProfileStore.getState().setActiveProfile(buzz.id);
    });
    return navigateHome;
  }

  it("releases an epic route the incoming profile does not own", () => {
    seedMembership("epic-foreign", ["/Users/x/Acme"]);
    const navigateHome = switchFromEpicRoute("epic-foreign");
    expect(navigateHome).toHaveBeenCalledTimes(1);
  });

  it("releases an unscoped epic route (no linked workspaces)", () => {
    seedMembership("epic-unscoped", []);
    const navigateHome = switchFromEpicRoute("epic-unscoped");
    expect(navigateHome).toHaveBeenCalledTimes(1);
  });

  it("keeps an epic route owned by the incoming profile", () => {
    seedMembership("epic-owned", ["/Users/x/Buzz/packages/app"]);
    const navigateHome = switchFromEpicRoute("epic-owned");
    expect(navigateHome).not.toHaveBeenCalled();
  });

  it("keeps an epic route whose membership is unknown (fail-open)", () => {
    const navigateHome = switchFromEpicRoute("epic-unknown");
    expect(navigateHome).not.toHaveBeenCalled();
  });

  it("enters all-projects by navigating home and clearing strip focus", () => {
    const buzz = useProjectProfilesStore.getState().profiles[0];
    seedMembership("epic-foreign", ["/Users/x/Acme"]);
    useActiveProjectProfileStore.getState().setActiveProfile(buzz.id);
    seedCanvasEpic("tab-epic-foreign", "epic-foreign", "epic-foreign");
    seedStrip(layoutWithEpic("tab-epic-foreign"));
    const { route, navigateHome } = stubRoute("/epics/epic-foreign");
    dispose = startProfileTabWorkspaceController(route);

    act(() => {
      useActiveProjectProfileStore.getState().setActiveProfile(null);
    });
    expect(navigateHome).toHaveBeenCalledTimes(1);
    expect(useTabsStore.getState().activeItemId).toBe(null);
  });

  it("releases a draft route that is not in the restored strip", () => {
    const { route, navigateHome } = stubRoute("/draft/draft-1");
    dispose = startProfileTabWorkspaceController(route);
    act(() => {
      useActiveProjectProfileStore.getState().setActiveProfile("profile-b");
    });
    expect(navigateHome).toHaveBeenCalledTimes(1);
  });

  it("keeps a home route untouched on switch", () => {
    const { route, navigateHome } = stubRoute("/");
    dispose = startProfileTabWorkspaceController(route);
    act(() => {
      useActiveProjectProfileStore.getState().setActiveProfile("profile-b");
    });
    expect(navigateHome).not.toHaveBeenCalled();
  });
});

describe("parked drafts across profile strips", () => {
  beforeEach(() => {
    resetAll();
  });

  afterEach(() => {
    resetAll();
  });

  it("minting a Start Page after a profile restore does not re-place parked drafts", () => {
    useLandingDraftStore.getState().createDraftWithId("draft-a", null);
    tabCommandCoordinator.restoreHydratedLayout(layoutWithDraft("draft-a"));
    expect(flattenLayoutRefs(readTabStripLayout())).toEqual([
      { kind: "draft", id: "draft-a" },
    ]);

    // Switch to an empty profile bucket: draft-a stays in the store (so it
    // can come back with its bucket) but must leave the live strip.
    tabCommandCoordinator.restoreHydratedLayout(emptyTabStripLayout());
    expect(flattenLayoutRefs(readTabStripLayout())).toEqual([]);
    expect(
      useLandingDraftStore.getState().drafts.map((draft) => draft.id),
    ).toEqual(["draft-a"]);

    // Empty-profile mint: the same path as openNewEpicIntent after a swap.
    const draftB = useLandingDraftStore.getState().createDraft(null);
    tabCommandCoordinator.reconcileFromSourceStores();

    expect(flattenLayoutRefs(readTabStripLayout())).toEqual([
      { kind: "draft", id: draftB },
    ]);
    expect(
      useLandingDraftStore.getState().drafts.map((draft) => draft.id),
    ).toEqual(["draft-a", draftB]);
  });

  it("restoring a profile layout brings its parked Start Page back", () => {
    useLandingDraftStore.getState().createDraftWithId("draft-a", null);
    tabCommandCoordinator.restoreHydratedLayout(layoutWithDraft("draft-a"));
    tabCommandCoordinator.restoreHydratedLayout(emptyTabStripLayout());
    useLandingDraftStore.getState().createDraftWithId("draft-b", null);
    tabCommandCoordinator.reconcileFromSourceStores();

    tabCommandCoordinator.restoreHydratedLayout(layoutWithDraft("draft-a"));

    expect(flattenLayoutRefs(readTabStripLayout())).toEqual([
      { kind: "draft", id: "draft-a" },
    ]);
  });
});
