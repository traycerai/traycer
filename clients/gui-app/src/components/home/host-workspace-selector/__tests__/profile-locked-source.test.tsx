import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import type { WorktreeStagingKey } from "@/stores/worktree/worktree-intent-staging-store";
import { useWorkspaceFoldersStore } from "@/stores/workspace/workspace-folders-store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { useWorktreeIntentStagingStore } from "@/stores/worktree/worktree-intent-staging-store";
import { useActiveProjectProfileStore } from "@/stores/profiles/active-project-profile-store";
import { useProjectProfilesStore } from "@/stores/profiles/project-profiles-store";
import { useHomeWorkspaceSource } from "../use-home-workspace-source";
import { ProjectProfileBadge } from "@/components/profiles/project-profile-badge";
import { workspaceFolderName } from "@/lib/worktree/workspace-folder-name";
import { cn } from "@/lib/utils";
import type { ReactNode } from "react";
import { useActiveProjectProfile } from "@/lib/profiles/use-active-project-profile";

const STAGING_KEY: WorktreeStagingKey = {
  surface: "landing",
  draftId: null,
};

function resetStores(): void {
  useWorkspaceFoldersStore.setState({
    folders: [],
    folderInfoByPath: {},
    primaryPath: null,
  });
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  useWorktreeIntentStagingStore.getState().resetForTests();
  useProjectProfilesStore.getState().resetForTests();
  useActiveProjectProfileStore.getState().resetForTests();
}

beforeEach(resetStores);
afterEach(() => {
  cleanup();
  resetStores();
});

/** Minimal locked chip matching host-workspace-selector's profile-locked branch. */
function ProfileLockedWorkspaceChipHarness(props: {
  readonly primaryPath: string | null;
}): ReactNode {
  const activeProfile = useActiveProjectProfile();
  if (activeProfile === null) return null;
  const primaryName =
    props.primaryPath === null
      ? null
      : workspaceFolderName(props.primaryPath);
  return (
    <div
      className={cn("inline-flex items-center gap-2")}
      data-testid="profile-locked-workspace"
    >
      <ProjectProfileBadge
        profile={activeProfile}
        className="min-w-0"
        trailing={undefined}
      />
      {primaryName === null ? null : (
        <span data-testid="profile-locked-primary-name">{primaryName}</span>
      )}
    </div>
  );
}

describe("useHomeWorkspaceSource profile lock", () => {
  it("exposes profile folders and primary when a profile is active", () => {
    useWorkspaceFoldersStore.setState({
      folders: ["/tmp/unrelated"],
      folderInfoByPath: {},
      primaryPath: "/tmp/unrelated",
    });

    const profile = useProjectProfilesStore.getState().createProfile({
      name: "Acme",
      icon: "rocket",
      color: "blue",
      folders: [
        { path: "/Users/x/Acme", hostId: "h1" },
        { path: "/Users/x/Acme-docs", hostId: "h1" },
      ],
    });
    useActiveProjectProfileStore.getState().setActiveProfile(profile.id);

    const { result } = renderHook(() =>
      useHomeWorkspaceSource(STAGING_KEY, null),
    );

    expect(result.current.profileLocked).toBe(true);
    expect(result.current.folders).toEqual([
      "/Users/x/Acme",
      "/Users/x/Acme-docs",
    ]);
    expect(result.current.primaryPath).toBe("/Users/x/Acme");
    expect(result.current.primaryWorkspacePath).toBe("/Users/x/Acme");
  });

  it("keeps unlocked behavior when no profile is active", () => {
    useWorkspaceFoldersStore
      .getState()
      .addResolvedFolders([
        {
          path: "/tmp/first",
          name: "first",
          repoIdentifier: null,
          hostId: null,
        },
      ]);

    const { result } = renderHook(() =>
      useHomeWorkspaceSource(STAGING_KEY, null),
    );

    expect(result.current.profileLocked).toBe(false);
    expect(result.current.folders).toEqual(["/tmp/first"]);
  });

  it("renders the locked chip without add/remove affordances", () => {
    const profile = useProjectProfilesStore.getState().createProfile({
      name: "Acme",
      icon: "rocket",
      color: "blue",
      folders: [
        { path: "/Users/x/Acme", hostId: "h1" },
        { path: "/Users/x/Acme-docs", hostId: "h1" },
      ],
    });
    useActiveProjectProfileStore.getState().setActiveProfile(profile.id);

    const { result } = renderHook(() =>
      useHomeWorkspaceSource(STAGING_KEY, null),
    );

    expect(result.current.profileLocked).toBe(true);

    render(
      <ProfileLockedWorkspaceChipHarness
        primaryPath={result.current.primaryWorkspacePath}
      />,
    );

    expect(screen.getByTestId("profile-locked-workspace")).toBeTruthy();
    expect(screen.getByTestId("project-profile-badge").textContent).toContain(
      "Acme",
    );
    expect(screen.getByTestId("profile-locked-primary-name").textContent).toBe(
      "Acme",
    );
    expect(screen.queryByRole("button", { name: /add folder/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /remove/i })).toBeNull();
  });

  it("clears lock when active profile returns to null", () => {
    const profile = useProjectProfilesStore.getState().createProfile({
      name: "Acme",
      icon: "rocket",
      color: "blue",
      folders: [{ path: "/Users/x/Acme", hostId: "h1" }],
    });
    useActiveProjectProfileStore.getState().setActiveProfile(profile.id);

    const { result, rerender } = renderHook(() =>
      useHomeWorkspaceSource(STAGING_KEY, null),
    );
    expect(result.current.profileLocked).toBe(true);

    act(() => {
      useActiveProjectProfileStore.getState().setActiveProfile(null);
    });
    rerender();

    expect(result.current.profileLocked).toBe(false);
  });
});
