import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TestRouterProvider } from "@/__tests__/with-test-router";
import type { HistoryItem } from "@/components/home/data/home-page.data";
import { activateTabIntent } from "@/lib/tab-navigation";
import { useActiveProjectProfileStore } from "@/stores/profiles/active-project-profile-store";
import { useHistoryMembershipCacheStore } from "@/stores/profiles/history-membership-cache-store";
import { useProjectProfilesStore } from "@/stores/profiles/project-profiles-store";
import { ProjectProfileSwitcher } from "../project-profile-switcher";

vi.mock("@/hooks/workspace/use-workspace-folder-actions", () => ({
  useWorkspaceFolderActions: () => ({
    pickAndPrepareFolders: vi.fn(() => Promise.resolve(null)),
    isPreparing: false,
    isRemoving: false,
    prepareFoldersMutation: {},
    removeEpicRepoMutation: {},
  }),
}));

vi.mock("@/lib/tab-navigation", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/tab-navigation")>();
  return { ...actual, activateTabIntent: vi.fn(() => true) };
});

function renderSwitcher(): ReturnType<typeof render> {
  return render(
    <TestRouterProvider>
      <ProjectProfileSwitcher />
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
}

describe("ProjectProfileSwitcher", () => {
  beforeEach(() => {
    vi.mocked(activateTabIntent).mockClear();
    resetStores();
    useProjectProfilesStore.getState().createProfile({
      name: "Acme",
      icon: "rocket",
      color: "blue",
      folders: [{ path: "/Users/x/Acme", hostId: "h1" }],
    });
    useProjectProfilesStore.getState().createProfile({
      name: "Bagisto",
      icon: "store",
      color: "green",
      folders: [{ path: "/Users/x/Bagisto", hostId: "h1" }],
    });
  });

  afterEach(() => {
    cleanup();
    resetStores();
  });

  it("selects a project and updates the active store", async () => {
    const user = userEvent.setup();
    renderSwitcher();

    await user.click(await screen.findByTestId("project-profile-switcher"));
    const profiles = useProjectProfilesStore.getState().profiles;
    await user.click(
      screen.getByTestId(`project-profile-option-${profiles[0].id}`),
    );

    expect(useActiveProjectProfileStore.getState().activeProfileId).toBe(
      profiles[0].id,
    );
  });

  it("returns to All projects when selected", async () => {
    const user = userEvent.setup();
    const profiles = useProjectProfilesStore.getState().profiles;
    useActiveProjectProfileStore.getState().setActiveProfile(profiles[0].id);

    renderSwitcher();
    await user.click(await screen.findByTestId("project-profile-switcher"));
    await user.click(screen.getByTestId("project-profile-option-all"));

    expect(useActiveProjectProfileStore.getState().activeProfileId).toBe(null);
  });

  it("opens the create dialog from New project…", async () => {
    const user = userEvent.setup();
    renderSwitcher();

    await user.click(await screen.findByTestId("project-profile-switcher"));
    await user.click(screen.getByTestId("project-profile-option-new"));

    await waitFor(() => {
      expect(screen.getByTestId("project-profile-dialog")).toBeTruthy();
    });
    expect(screen.getByText("New project")).toBeTruthy();
  });

  it("jumps to the most recent owned epic when entering a project", async () => {
    const user = userEvent.setup();
    const profiles = useProjectProfilesStore.getState().profiles;
    useHistoryMembershipCacheStore.getState().setMembershipItems([
      historyItem({
        epicId: "titanos-old",
        updatedAtMs: 100,
        linkedWorkspaces: [
          { hostId: "h1", workspacePath: "/Users/x/Acme" },
        ],
      }),
      historyItem({
        epicId: "titanos-new",
        updatedAtMs: 200,
        linkedWorkspaces: [
          { hostId: "h1", workspacePath: "/Users/x/Acme/apps/web" },
        ],
      }),
      historyItem({
        epicId: "foreign",
        updatedAtMs: 999,
        linkedWorkspaces: [{ hostId: "h1", workspacePath: "/Users/x/Bkza" }],
      }),
    ]);

    renderSwitcher();
    await user.click(await screen.findByTestId("project-profile-switcher"));
    await user.click(
      screen.getByTestId(`project-profile-option-${profiles[0].id}`),
    );

    expect(vi.mocked(activateTabIntent)).toHaveBeenCalledTimes(1);
    const call = vi.mocked(activateTabIntent).mock.calls[0];
    expect(call[1]).toMatchObject({ kind: "open-epic", epicId: "titanos-new" });
  });

  it("does not navigate when the project owns no epic", async () => {
    const user = userEvent.setup();
    const profiles = useProjectProfilesStore.getState().profiles;
    useHistoryMembershipCacheStore.getState().setMembershipItems([
      historyItem({
        epicId: "foreign",
        updatedAtMs: 999,
        linkedWorkspaces: [{ hostId: "h1", workspacePath: "/Users/x/Bkza" }],
      }),
    ]);

    renderSwitcher();
    await user.click(await screen.findByTestId("project-profile-switcher"));
    await user.click(
      screen.getByTestId(`project-profile-option-${profiles[0].id}`),
    );

    expect(useActiveProjectProfileStore.getState().activeProfileId).toBe(
      profiles[0].id,
    );
    expect(vi.mocked(activateTabIntent)).not.toHaveBeenCalled();
  });
});
