import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  WorktreeBinding,
  WorktreeBindingEntry,
  WorktreeIntent,
} from "@traycer/protocol/host/worktree-schemas";
import {
  mentionRootsFromWorktreeIntent,
  mentionRootsFromWorktreeBinding,
  useLandingComposerMentionRoots,
  useWorkspaceMentionRoots,
} from "../use-workspace-mention-roots";
import { useWorkspaceFoldersStore } from "@/stores/workspace/workspace-folders-store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { useWorktreeIntentStagingStore } from "@/stores/worktree/worktree-intent-staging-store";

function setGlobalFolders(folders: ReadonlyArray<string>): void {
  useWorkspaceFoldersStore.setState({ folders });
}

function resetStores(): void {
  useWorkspaceFoldersStore.setState({
    folders: [],
    folderInfoByPath: {},
  });
  useLandingDraftStore.setState({
    drafts: [],
    activeDraftId: null,
  });
  useWorktreeIntentStagingStore.setState({ intentByKey: {} });
}

function bindingEntry(
  overrides: Partial<WorktreeBindingEntry>,
): WorktreeBindingEntry {
  return {
    workspacePath: "/repo",
    mode: "local",
    repoIdentifier: null,
    worktreePath: null,
    branch: null,
    isPrimary: true,
    isImported: false,
    setupState: "not_required",
    setupTerminalSessionId: null,
    setupExitCode: null,
    setupFailedAt: null,
    createdAt: 0,
    ownedSubmodules: [],
    ...overrides,
  };
}

function binding(
  entries: ReadonlyArray<WorktreeBindingEntry>,
): WorktreeBinding {
  return { entries: [...entries] };
}

function worktreeIntent(
  workspacePath: string,
  intent: "local" | "create" | "import",
  worktreePath: string | null,
): WorktreeIntent {
  const base = {
    workspacePath,
    isPrimary: true,
    repoIdentifier: null,
  } as const;
  if (intent === "local") {
    return { entries: [{ kind: "local", ...base }] };
  }
  if (intent === "import") {
    return {
      entries: [{ kind: "import", ...base, worktreePath: worktreePath ?? "" }],
    };
  }
  return {
    entries: [
      {
        kind: "worktree",
        scripts: null,
        ...base,
        branch: {
          type: "new",
          name: "feature/test",
          source: "main",
          carryUncommittedChanges: false,
        },
      },
    ],
  };
}

describe("useWorkspaceMentionRoots", () => {
  beforeEach(() => {
    resetStores();
  });
  afterEach(() => {
    cleanup();
    resetStores();
  });

  it("uses the preferred roots when they are non-empty", () => {
    setGlobalFolders(["/global/a"]);
    const { result } = renderHook(() =>
      useWorkspaceMentionRoots(["/epic/x", "/epic/y"], true),
    );
    expect(result.current).toEqual(["/epic/x", "/epic/y"]);
  });

  it("falls back to the global folders when preferred roots are null (landing composer)", () => {
    setGlobalFolders(["/global/a", "/global/b"]);
    const { result } = renderHook(() => useWorkspaceMentionRoots(null, true));
    expect(result.current).toEqual(["/global/a", "/global/b"]);
  });

  it("falls back to the global folders when preferred roots are empty (binding not loaded yet)", () => {
    setGlobalFolders(["/global/a"]);
    const { result } = renderHook(() => useWorkspaceMentionRoots([], true));
    expect(result.current).toEqual(["/global/a"]);
  });

  it("does not fall back to global folders when an empty source is explicit", () => {
    setGlobalFolders(["/global/a"]);
    const { result } = renderHook(() => useWorkspaceMentionRoots([], false));
    expect(result.current).toEqual([]);
  });

  it("returns an empty list when neither preferred nor global folders exist", () => {
    const { result } = renderHook(() => useWorkspaceMentionRoots([], true));
    expect(result.current).toEqual([]);
  });

  it("dedupes and trims the resolved roots", () => {
    const { result } = renderHook(() =>
      useWorkspaceMentionRoots([" /epic/x ", "/epic/x", ""], true),
    );
    expect(result.current).toEqual(["/epic/x"]);
  });
});

describe("useLandingComposerMentionRoots", () => {
  beforeEach(() => {
    resetStores();
  });
  afterEach(() => {
    cleanup();
    resetStores();
  });

  it("uses an imported global worktree path for the base landing composer", () => {
    setGlobalFolders(["/repo"]);
    useWorktreeIntentStagingStore
      .getState()
      .stageIntent(
        { surface: "landing", draftId: null },
        worktreeIntent("/repo", "import", "/worktrees/repo-feature"),
      );

    const { result } = renderHook(() => useLandingComposerMentionRoots(null));

    expect(result.current).toEqual(["/worktrees/repo-feature"]);
  });

  it("uses an imported draft worktree path for draft-scoped landing composers", () => {
    setGlobalFolders(["/repo"]);
    const draftId = useLandingDraftStore.getState().createDraft(null);
    useWorktreeIntentStagingStore
      .getState()
      .stageIntent(
        { surface: "landing", draftId },
        worktreeIntent("/repo", "import", "/worktrees/repo-feature"),
      );

    const { result } = renderHook(() =>
      useLandingComposerMentionRoots(draftId),
    );

    expect(result.current).toEqual(["/worktrees/repo-feature"]);
  });
});

describe("mentionRootsFromWorktreeBinding", () => {
  it("returns an empty list for a null binding", () => {
    expect(mentionRootsFromWorktreeBinding(null)).toEqual([]);
  });

  it("uses the workspace path for local-mode entries", () => {
    const roots = mentionRootsFromWorktreeBinding(
      binding([
        bindingEntry({
          workspacePath: "/Users/me/Work/traycer",
          mode: "local",
        }),
      ]),
    );
    expect(roots).toEqual(["/Users/me/Work/traycer"]);
  });

  it("uses the worktree path for worktree-mode entries", () => {
    const roots = mentionRootsFromWorktreeBinding(
      binding([
        bindingEntry({
          workspacePath: "/repo",
          mode: "worktree",
          worktreePath: "/repo-worktrees/feature",
        }),
      ]),
    );
    expect(roots).toEqual(["/repo-worktrees/feature"]);
  });

  it("falls back to the workspace path when a worktree-mode entry has no worktree path", () => {
    const roots = mentionRootsFromWorktreeBinding(
      binding([
        bindingEntry({
          workspacePath: "/repo",
          mode: "worktree",
          worktreePath: null,
        }),
      ]),
    );
    expect(roots).toEqual(["/repo"]);
  });

  it("collects and dedupes roots across multiple entries", () => {
    const roots = mentionRootsFromWorktreeBinding(
      binding([
        bindingEntry({ workspacePath: "/repo-a", mode: "local" }),
        bindingEntry({
          workspacePath: "/repo-b",
          mode: "worktree",
          worktreePath: "/wt/b",
        }),
        bindingEntry({ workspacePath: "/repo-a", mode: "local" }),
      ]),
    );
    expect(roots).toEqual(["/repo-a", "/wt/b"]);
  });
});

describe("mentionRootsFromWorktreeIntent", () => {
  it("uses the selected imported worktree path for matching workspace rows", () => {
    expect(
      mentionRootsFromWorktreeIntent(
        ["/repo"],
        worktreeIntent("/repo", "import", "/worktrees/repo-feature"),
      ),
    ).toEqual(["/worktrees/repo-feature"]);
  });

  it("keeps local and pending create rows rooted at the workspace path", () => {
    expect(
      mentionRootsFromWorktreeIntent(["/repo-local", "/repo-create"], {
        entries: [
          ...worktreeIntent("/repo-local", "local", null).entries,
          ...worktreeIntent("/repo-create", "create", null).entries,
        ],
      }),
    ).toEqual(["/repo-local", "/repo-create"]);
  });
});
