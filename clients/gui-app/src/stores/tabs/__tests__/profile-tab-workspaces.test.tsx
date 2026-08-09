import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ProfileTabWorkspaceBridge,
  startProfileTabWorkspaceController,
} from "@/providers/profile-tab-workspace-bridge";
import {
  WindowsBridgeContext,
  type WindowsBridgeContextValue,
} from "@/providers/windows-bridge-context";
import { useActiveProjectProfileStore } from "@/stores/profiles/active-project-profile-store";
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
    dispose = startProfileTabWorkspaceController();

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
    dispose = startProfileTabWorkspaceController();

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
    dispose = startProfileTabWorkspaceController();

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
    dispose = startProfileTabWorkspaceController();

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
        <ProfileTabWorkspaceBridge />
      </WindowsBridgeContext.Provider>,
    );

    // Profile switch before hydration must not clobber buckets or strip.
    act(() => {
      useActiveProjectProfileStore.getState().setActiveProfile("profile-a");
    });

    expect(readTabStripLayout()).toEqual(expect.objectContaining({
      items: layoutA.items,
      activeItemId: layoutA.activeItemId,
    }));
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
        <ProfileTabWorkspaceBridge />
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
