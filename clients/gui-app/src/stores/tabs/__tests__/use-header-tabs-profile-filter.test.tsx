import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyCanvas } from "@/stores/epics/canvas/canvas-state";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useTabsStore } from "@/stores/tabs/store";
import { useActiveProjectProfileStore } from "@/stores/profiles/active-project-profile-store";
import { useProjectProfilesStore } from "@/stores/profiles/project-profiles-store";
import type { HistoryItem } from "@/components/home/data/home-page.data";
import { useHistoryMembershipCacheStore } from "@/stores/profiles/history-membership-cache-store";
import { useHeaderTabs } from "@/stores/tabs/use-header-tabs";

function historyItem(
  epicId: string,
  workspaces: ReadonlyArray<{ hostId: string; workspacePath: string }>,
): HistoryItem {
  return {
    id: `epic:${epicId}`,
    epicId,
    taskType: "epic",
    title: epicId,
    initialUserPrompt: "",
    updatedAtMs: 1,
    updatedLabel: "",
    updatedBucket: "earlier",
    linkedRepos: [],
    linkedWorkspaces: workspaces,
    pullRequestNumbers: [],
    worktreeBranches: [],
    worktreePaths: [],
    ownership: "mine",
    permissionRole: null,
    isPinned: false,
  };
}

function resetState(): void {
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useTabsStore.setState({
    version: 2,
    items: [],
    activeItemId: null,
    stripOrder: [],
    systemTabs: {
      history: { id: "history", kind: "history", name: "History", lastPath: null },
      settings: null,
    },
  });
  useProjectProfilesStore.getState().resetForTests();
  useActiveProjectProfileStore.getState().resetForTests();
  useHistoryMembershipCacheStore.getState().resetForTests();
}

function seedTabs(): void {
  useEpicCanvasStore.setState({
    tabsById: {
      "tab-owned": {
        tabId: "tab-owned",
        epicId: "epic-owned",
        name: "Owned",
      },
      "tab-foreign": {
        tabId: "tab-foreign",
        epicId: "epic-foreign",
        name: "Foreign",
      },
      "tab-unknown": {
        tabId: "tab-unknown",
        epicId: "epic-unknown",
        name: "Unknown",
      },
    },
    canvasByTabId: {
      "tab-owned": createEmptyCanvas(),
      "tab-foreign": createEmptyCanvas(),
      "tab-unknown": createEmptyCanvas(),
    },
    openTabOrder: ["tab-owned", "tab-foreign", "tab-unknown"],
    activeTabId: "tab-owned",
    mostRecentTabIdByEpicId: {
      "epic-owned": "tab-owned",
      "epic-foreign": "tab-foreign",
      "epic-unknown": "tab-unknown",
    },
  });
  useTabsStore.setState({
    version: 2,
    items: [
      {
        kind: "tab",
        id: "tab:epic:tab-owned",
        ref: { kind: "epic", id: "tab-owned" },
      },
      {
        kind: "tab",
        id: "tab:epic:tab-foreign",
        ref: { kind: "epic", id: "tab-foreign" },
      },
      {
        kind: "tab",
        id: "tab:epic:tab-unknown",
        ref: { kind: "epic", id: "tab-unknown" },
      },
      {
        kind: "tab",
        id: "tab:history",
        ref: { kind: "history", id: "history" },
      },
    ],
    activeItemId: "tab:epic:tab-owned",
    stripOrder: [
      { kind: "epic", id: "tab-owned" },
      { kind: "epic", id: "tab-foreign" },
      { kind: "epic", id: "tab-unknown" },
      { kind: "history", id: "history" },
    ],
    systemTabs: {
      history: {
        id: "history",
        kind: "history",
        name: "History",
        lastPath: null,
      },
      settings: null,
    },
  });
  useHistoryMembershipCacheStore.getState().setMembershipItems([
    historyItem("epic-owned", [
      { hostId: "h1", workspacePath: "/Users/x/Acme" },
    ]),
    historyItem("epic-foreign", [
      { hostId: "h1", workspacePath: "/Users/x/Other" },
    ]),
  ]);
}

describe("useHeaderTabs profile filter", () => {
  beforeEach(() => {
    resetState();
    seedTabs();
  });

  afterEach(() => {
    cleanup();
    resetState();
  });

  it("hides foreign epic tabs when a profile is active, keeps unknown + system", () => {
    const profile = useProjectProfilesStore.getState().createProfile({
      name: "Acme",
      icon: "rocket",
      color: "blue",
      folders: [{ path: "/Users/x/Acme", hostId: "h1" }],
    });
    useActiveProjectProfileStore.getState().setActiveProfile(profile.id);

    const { result } = renderHook(() => useHeaderTabs());

    expect(result.current.map((tab) => tab.id)).toEqual([
      "tab-owned",
      "tab-unknown",
      "history",
    ]);
  });

  it("restores foreign epic tabs when active profile is cleared", () => {
    const profile = useProjectProfilesStore.getState().createProfile({
      name: "Acme",
      icon: "rocket",
      color: "blue",
      folders: [{ path: "/Users/x/Acme", hostId: "h1" }],
    });
    useActiveProjectProfileStore.getState().setActiveProfile(profile.id);

    const { result, rerender } = renderHook(() => useHeaderTabs());
    expect(result.current.some((tab) => tab.id === "tab-foreign")).toBe(false);

    act(() => {
      useActiveProjectProfileStore.getState().setActiveProfile(null);
    });
    rerender();

    expect(result.current.map((tab) => tab.id)).toEqual([
      "tab-owned",
      "tab-foreign",
      "tab-unknown",
      "history",
    ]);
  });
});
