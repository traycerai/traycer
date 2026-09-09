import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import type { WorktreeFolderIntent } from "@traycer/protocol/host/worktree-schemas";
import { LandingTerminalGestureProvider } from "../landing-terminal-gesture-provider";
import {
  useLandingTerminalGesture,
  type LandingTerminalTarget,
} from "../landing-terminal-gesture-context";
import {
  UNBOUND_LANDING_PAGE_ID,
  useLandingTerminalStore,
} from "@/stores/home/landing-terminal-store";
import { useWorkspaceFoldersStore } from "@/stores/workspace/workspace-folders-store";
import type { WorkspaceFolderInfo } from "@/stores/workspace/workspace-folders-store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { useWorktreeIntentStagingStore } from "@/stores/worktree/worktree-intent-staging-store";
import type { WorktreeStagingKey } from "@/stores/worktree/worktree-intent-staging-store";

/**
 * `LandingTerminalGestureProvider`'s launch directory follows a staged
 * existing-worktree IMPORT intent instead of always launching in the
 * checkout root - `primaryWorkspacePath`/`workspacePaths` stay the raw
 * workspace-identity values every other consumer (rows, chip) reads. Only
 * the provider's own host/client/probe seams are mocked; `useHomeWorkspaceSource`
 * and the zustand stores it reads are real.
 */

const HOST_A = "host-a";
const HOST_B = "host-b";

const REPO_ROOT: WorkspaceFolderInfo = {
  path: "/tmp/repo-root",
  name: "repo-root",
  repoIdentifier: null,
  hostId: HOST_A,
};
const SECOND_FOLDER: WorkspaceFolderInfo = {
  path: "/tmp/second-repo",
  name: "second-repo",
  repoIdentifier: null,
  hostId: HOST_A,
};
const IMPORTED_WORKTREE_PATH = "/tmp/.traycer/worktrees/repo-root/feature-x";
const SECOND_IMPORTED_WORKTREE_PATH =
  "/tmp/.traycer/worktrees/second-repo/feature-y";

const mocks = vi.hoisted(() => ({
  activeHostId: "host-a" as string | null,
}));

vi.mock("@/hooks/host/use-composer-placement", () => ({
  useComposerPlacement: () => {
    const target = {
      resolvedHostId: mocks.activeHostId,
      client:
        mocks.activeHostId === null
          ? null
          : {
              getActiveHostId: () => mocks.activeHostId,
              onChange: () => () => undefined,
            },
      hostLabel: "",
      isPinned: false,
      namedHostDead: false,
    };
    return {
      pin: {
        selection: null,
        honoredSelection: null,
        resolvedHostId: mocks.activeHostId,
        isPinned: false,
        setSelection: () => undefined,
        latchOnFirstUse: () => undefined,
      },
      target,
      submitTarget: target,
      hostLabelFor: () => "",
      followsEffective: true,
    };
  },
}));
vi.mock("@/lib/host", () => ({
  useHostDirectory: () => ({
    findById: (hostId: string) => ({ hostId, websocketUrl: "ws://test" }),
  }),
}));
vi.mock("@/hooks/host/use-host-client-for", () => ({
  buildDialableHostClient: (
    _client: unknown,
    entry: { readonly hostId: string },
  ) => ({
    getActiveHostId: () => entry.hostId,
    onChange: () => () => undefined,
  }),
}));
vi.mock("@/hooks/terminal/use-terminal-list-for-query", () => ({
  useTerminalListFor: () => ({
    data: { sessions: [], homeCwd: null },
    error: null,
    dataUpdatedAt: 1,
  }),
}));

function resetStores(): void {
  useWorkspaceFoldersStore.setState({ byHost: {} });
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  useWorktreeIntentStagingStore.getState().resetForTests();
  useLandingTerminalStore.getState().resetForTests();
  mocks.activeHostId = HOST_A;
}

beforeEach(resetStores);
afterEach(() => {
  cleanup();
  resetStores();
});

function importEntryFor(
  workspacePath: string,
  worktreePath: string,
): WorktreeFolderIntent {
  return {
    kind: "import",
    workspacePath,
    repoIdentifier: null,
    isPrimary: true,
    worktreePath,
  };
}

function Wrapper({ children }: { readonly children: ReactNode }): ReactNode {
  return (
    <LandingTerminalGestureProvider draftId={null}>
      {children}
    </LandingTerminalGestureProvider>
  );
}

function renderGesture() {
  return renderHook(() => useLandingTerminalGesture(), { wrapper: Wrapper });
}

describe("LandingTerminalGestureProvider - staged worktree intent routes the launch directory", () => {
  it("keeps primaryWorkspacePath/workspacePaths raw while launchWorkspacePath follows the primary's staged import, live and captured", () => {
    const { result } = renderGesture();

    act(() => {
      useWorkspaceFoldersStore
        .getState()
        .addResolvedFolders(HOST_A, [REPO_ROOT]);
    });
    const stagingKey: WorktreeStagingKey = {
      surface: "landing",
      hostId: HOST_A,
      draftId: null,
    };
    act(() => {
      useWorktreeIntentStagingStore
        .getState()
        .stageEntry(
          stagingKey,
          importEntryFor(REPO_ROOT.path, IMPORTED_WORKTREE_PATH),
        );
    });

    expect(result.current.target.primaryWorkspacePath).toBe(REPO_ROOT.path);
    expect(result.current.target.workspacePaths).toEqual([REPO_ROOT.path]);
    expect(result.current.target.launchWorkspacePath).toBe(
      IMPORTED_WORKTREE_PATH,
    );

    const capturedBox: { current: LandingTerminalTarget | null } = {
      current: null,
    };
    act(() => {
      capturedBox.current = result.current.capture();
    });

    expect(capturedBox.current?.primaryWorkspacePath).toBe(REPO_ROOT.path);
    expect(capturedBox.current?.workspacePaths).toEqual([REPO_ROOT.path]);
    expect(capturedBox.current?.launchWorkspacePath).toBe(
      IMPORTED_WORKTREE_PATH,
    );
  });

  it("selectWorkspacePath resolves the CHOSEN folder's own import, not the primary's, and rejects a path outside the live set", () => {
    const { result } = renderGesture();

    act(() => {
      useWorkspaceFoldersStore
        .getState()
        .addResolvedFolders(HOST_A, [REPO_ROOT, SECOND_FOLDER]);
    });
    const stagingKey: WorktreeStagingKey = {
      surface: "landing",
      hostId: HOST_A,
      draftId: null,
    };
    act(() => {
      useWorktreeIntentStagingStore
        .getState()
        .stageEntry(
          stagingKey,
          importEntryFor(SECOND_FOLDER.path, SECOND_IMPORTED_WORKTREE_PATH),
        );
    });

    act(() => {
      result.current.capture();
    });
    // REPO_ROOT is primary (array order, nothing pinned) and carries no
    // staged entry of its own.
    expect(result.current.target.primaryWorkspacePath).toBe(REPO_ROOT.path);

    const selectedBox: { current: LandingTerminalTarget | null } = {
      current: null,
    };
    act(() => {
      selectedBox.current = result.current.selectWorkspacePath(
        SECOND_FOLDER.path,
      );
    });
    expect(selectedBox.current?.launchWorkspacePath).toBe(
      SECOND_IMPORTED_WORKTREE_PATH,
    );
    // Reported primary is unchanged by picking a secondary folder.
    expect(selectedBox.current?.primaryWorkspacePath).toBe(REPO_ROOT.path);

    const rejectedBox: { current: LandingTerminalTarget | null } = {
      current: null,
    };
    act(() => {
      rejectedBox.current =
        result.current.selectWorkspacePath("/not/a/live/path");
    });
    expect(rejectedBox.current).toBeNull();
  });

  interface FallbackCase {
    readonly label: string;
    readonly folders: ReadonlyArray<WorkspaceFolderInfo>;
    readonly intentEntry: WorktreeFolderIntent | null;
    readonly expectedPrimaryWorkspacePath: string | null;
    readonly expectedLaunchWorkspacePath: string | null;
  }

  const FALLBACK_CASES: ReadonlyArray<FallbackCase> = [
    {
      label:
        "Local mode has no worktree to redirect to - falls back to its own path",
      folders: [REPO_ROOT],
      intentEntry: {
        kind: "local",
        workspacePath: REPO_ROOT.path,
        repoIdentifier: null,
        isPrimary: true,
      },
      expectedPrimaryWorkspacePath: REPO_ROOT.path,
      expectedLaunchWorkspacePath: REPO_ROOT.path,
    },
    {
      label:
        "a new-worktree pick isn't materialized yet - falls back to its own path",
      folders: [REPO_ROOT],
      intentEntry: {
        kind: "worktree",
        workspacePath: REPO_ROOT.path,
        repoIdentifier: null,
        isPrimary: true,
        branch: {
          type: "new",
          name: "feature-z",
          source: "main",
          carryUncommittedChanges: false,
        },
        scripts: null,
      },
      expectedPrimaryWorkspacePath: REPO_ROOT.path,
      expectedLaunchWorkspacePath: REPO_ROOT.path,
    },
    {
      label: "no staged intent at all - falls back to its own path",
      folders: [REPO_ROOT],
      intentEntry: null,
      expectedPrimaryWorkspacePath: REPO_ROOT.path,
      expectedLaunchWorkspacePath: REPO_ROOT.path,
    },
    {
      label: "no folders - folderless launch stays null",
      folders: [],
      intentEntry: null,
      expectedPrimaryWorkspacePath: null,
      expectedLaunchWorkspacePath: null,
    },
  ];

  it.each(FALLBACK_CASES)(
    "$label",
    ({
      folders,
      intentEntry,
      expectedPrimaryWorkspacePath,
      expectedLaunchWorkspacePath,
    }) => {
      const { result } = renderGesture();

      if (folders.length > 0) {
        act(() => {
          useWorkspaceFoldersStore
            .getState()
            .addResolvedFolders(HOST_A, [...folders]);
        });
      }
      if (intentEntry !== null) {
        const stagingKey: WorktreeStagingKey = {
          surface: "landing",
          hostId: HOST_A,
          draftId: null,
        };
        act(() => {
          useWorktreeIntentStagingStore
            .getState()
            .stageEntry(stagingKey, intentEntry);
        });
      }

      expect(result.current.target.primaryWorkspacePath).toBe(
        expectedPrimaryWorkspacePath,
      );
      expect(result.current.target.launchWorkspacePath).toBe(
        expectedLaunchWorkspacePath,
      );
    },
  );

  it("a pending capture's host/draft/launchWorkspacePath stay pinned when the live placement moves to another host", () => {
    const { result, rerender } = renderGesture();

    act(() => {
      useWorkspaceFoldersStore
        .getState()
        .addResolvedFolders(HOST_A, [REPO_ROOT]);
    });
    const stagingKey: WorktreeStagingKey = {
      surface: "landing",
      hostId: HOST_A,
      draftId: null,
    };
    act(() => {
      useWorktreeIntentStagingStore
        .getState()
        .stageEntry(
          stagingKey,
          importEntryFor(REPO_ROOT.path, IMPORTED_WORKTREE_PATH),
        );
    });
    // Opens this landing page's panel so the captured gesture actually pins
    // `target` instead of reverting to live focus once it's captured.
    act(() => {
      useLandingTerminalStore
        .getState()
        .setPanelOpen(UNBOUND_LANDING_PAGE_ID, true);
    });
    act(() => {
      result.current.capture();
    });

    expect(result.current.pending).toBe(true);
    expect(result.current.target.hostId).toBe(HOST_A);
    expect(result.current.target.draftId).toBeNull();
    expect(result.current.target.launchWorkspacePath).toBe(
      IMPORTED_WORKTREE_PATH,
    );

    // The live placement moves to another host while the gesture still pins.
    mocks.activeHostId = HOST_B;
    act(() => {
      rerender();
    });

    expect(result.current.pending).toBe(true);
    expect(result.current.target.hostId).toBe(HOST_A);
    expect(result.current.target.draftId).toBeNull();
    expect(result.current.target.launchWorkspacePath).toBe(
      IMPORTED_WORKTREE_PATH,
    );
  });
});
