import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import type {
  GitChangedFile,
  WorktreeBindingSelectorRowV12,
} from "@traycer/protocol/host";
import type {
  WorkspaceSearchPathResult,
  WorkspaceSearchPathsOutcome,
  WorkspaceSearchPathsResponse,
  WorkspaceSearchSource,
} from "@traycer/protocol/host/workspace/unary-schemas";
import type { CommandContext, CommandItem } from "@/lib/commands/types";
import type { KeybindingRouter } from "@/lib/keybindings/dispatch";
import type { OpenTileIntoTargetGroupArgs } from "@/lib/commands/actions/open-into-target";
import type { NavigateNestedFocus } from "@/lib/epic-nested-focus-navigation";
import {
  EMPTY_PROJECTED_SLICES,
  type ArtifactProjection,
  type EpicProjectedSlices,
  type TreeNode,
} from "@/stores/epics/open-epic/types";
import { DEFAULT_DIFF_VIEWER_PREFERENCES } from "@/lib/diff/diff-viewer-preferences";
import { getBasename } from "@/lib/path/cross-platform-path";
import { useSettingsStore } from "@/stores/settings/settings-store";

interface GitListChangedFilesArgs {
  readonly hostId: string;
  readonly runningDir: string | null;
  readonly ignoreWhitespace: boolean;
  readonly enabled: boolean;
}

const state = vi.hoisted(() => ({
  openTileIntoTargetGroup: vi.fn<(args: OpenTileIntoTargetGroupArgs) => void>(),
  query: "",
  rows: [] as ReadonlyArray<WorktreeBindingSelectorRowV12>,
  changedFiles: [] as ReadonlyArray<GitChangedFile>,
  gitListChangedFilesArgs: [] as GitListChangedFilesArgs[],
  // workspace.searchPaths mock knobs
  searchResults: [] as ReadonlyArray<WorkspaceSearchPathResult>,
  // `true` yields the typed `root_unavailable` outcome, else `ready`.
  searchRootUnavailable: false,
  searchTruncated: false,
  searchIsError: false,
  // Force the echoed source to a different root, to exercise the stale-reply
  // guard (a late response for a workspace the user has since left).
  echoRootOverride: null as string | null,
  projection: null as EpicProjectedSlices | null,
  defaultHostId: "default-host",
}));

vi.mock("@/lib/commands/actions", () => ({
  openTileIntoTargetGroup: state.openTileIntoTargetGroup,
}));
vi.mock("@/hooks/worktree/use-worktree-list-bindings-for-epic-query", () => ({
  useWorktreeListBindingsForEpic: () => ({
    data: { rows: state.rows },
    isPending: false,
    isError: false,
  }),
}));
vi.mock("@/lib/host", () => ({ useHostClient: () => ({}) }));
vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => state.defaultHostId,
}));
vi.mock("@/hooks/ui/use-debounced-value", () => ({
  useDebouncedValue: (value: unknown) => value,
}));
vi.mock("@/lib/commands/sources/open/use-active-epic-projection", () => ({
  useActiveEpicProjection: () => state.projection,
}));
vi.mock("@/hooks/workspace/use-workspace-search-paths-query", async () => {
  const actual = await vi.importActual(
    "@/hooks/workspace/use-workspace-search-paths-query",
  );
  return {
    ...actual,
    // Echo the requested source (or a forced-different root) so the REAL
    // `readSearchPathsResponseForSource` guard is exercised end-to-end.
    useWorkspaceSearchPathsForSource: (args: {
      readonly source: WorkspaceSearchSource | null;
      readonly epicId: string;
    }) => ({
      data:
        args.source === null
          ? undefined
          : buildSearchResponse(args.source, args.epicId),
      isError: state.searchIsError,
    }),
  };
});

function buildSearchResponse(
  source: WorkspaceSearchSource,
  epicId: string,
): WorkspaceSearchPathsResponse {
  const outcome: WorkspaceSearchPathsOutcome = state.searchRootUnavailable
    ? "root_unavailable"
    : "ready";
  const common = {
    epicId,
    outcome,
    results: [...state.searchResults],
    truncated: state.searchTruncated,
  };
  if ("kind" in source) {
    return { ...common, source: { kind: "epic-artifacts" } };
  }
  return { ...common, root: state.echoRootOverride ?? source.root };
}

vi.mock("@/hooks/git/use-git-list-changed-files-subscription", () => ({
  useGitListChangedFilesSubscription: (args: GitListChangedFilesArgs) => {
    state.gitListChangedFilesArgs.push(args);
    return {
      data:
        args.runningDir === null
          ? null
          : { runningDir: args.runningDir, files: state.changedFiles },
    };
  },
}));
vi.mock("@/stores/command-palette/command-palette-store", () => ({
  useCommandPaletteStore: (selector: (s: { query: string }) => unknown) =>
    selector({ query: state.query }),
}));

import { useFilesOpenerItems } from "@/lib/commands/sources/open/files-subpage";
import { useDiffOpenerItems } from "@/lib/commands/sources/open/diff-subpage";

const navigateNestedFocusSpy = vi.fn<NavigateNestedFocus>();

function noopRouter(): KeybindingRouter {
  return {
    getPathname: () => "/",
    navigateHome: () => undefined,
    navigateSettings: () => undefined,
    navigateToEpic: () => undefined,
    navigateToEpicTab: () => undefined,
    navigateToEpicList: () => undefined,
    navigateSettingsSection: () => undefined,
    navigateToTabIntent: () => undefined,
    goBack: () => undefined,
    goForward: () => undefined,
    isHistoryNavAvailable: () => false,
    canGoBack: () => false,
    canGoForward: () => false,
    navigateNestedFocus: navigateNestedFocusSpy,
  };
}

const CTX: CommandContext = {
  pathname: "/",
  router: noopRouter(),
  activeTabId: "tab-1",
  activeEpicId: "epic-1",
  focusedComposerKind: null,
  targetGroupId: "group-1",
};

function changedFile(path: string): GitChangedFile {
  return {
    path,
    previousPath: null,
    status: "modified",
    stage: "unstaged",
    isBinary: false,
    insertions: 1,
    deletions: 0,
    sizeBytes: 10,
    stagedOid: null,
    worktreeOid: null,
  };
}

function bindingRow(
  runningDir: string,
  isGitRepo: boolean,
): WorktreeBindingSelectorRowV12 {
  return {
    hostId: "default-host",
    runningDir,
    workspacePath: runningDir,
    worktreePath: null,
    mode: "local",
    isGitRepo,
    repoIdentifier: isGitRepo
      ? { owner: "acme", repo: getBasename(runningDir) }
      : null,
    branch: isGitRepo ? "main" : null,
    isPrimary: false,
    isImported: false,
    setupState: "not_required",
    disabledReason: null,
    sources: [],
    isGitResolvePending: false,
  };
}

function worktreeBindingRow(
  workspacePath: string,
  runningDir: string,
): WorktreeBindingSelectorRowV12 {
  return {
    ...bindingRow(runningDir, true),
    workspacePath,
    worktreePath: runningDir,
    mode: "worktree",
    branch: "feature",
  };
}

function renderItems(
  hook: (ctx: CommandContext) => ReadonlyArray<CommandItem>,
): ReadonlyArray<CommandItem> {
  return renderHook<ReadonlyArray<CommandItem>, unknown>(() => hook(CTX)).result
    .current;
}

function renderSubpageItems(item: CommandItem): ReadonlyArray<CommandItem> {
  if (item.subpage === null) throw new Error(`${item.id} has no sub-page`);
  const subpage = item.subpage;
  return renderHook<ReadonlyArray<CommandItem>, unknown>(() =>
    subpage.useItems(CTX),
  ).result.current;
}

function runById(items: ReadonlyArray<CommandItem>, id: string): void {
  const item = items.find((entry) => entry.id === id);
  if (item === undefined) throw new Error(`no opener item ${id}`);
  void item.run(CTX);
}

function lastTileOpen(): OpenTileIntoTargetGroupArgs {
  const call = state.openTileIntoTargetGroup.mock.calls.at(-1);
  if (call === undefined) throw new Error("openTileIntoTargetGroup not called");
  return call[0];
}

beforeEach(() => {
  state.query = "";
  state.rows = [];
  state.changedFiles = [];
  state.gitListChangedFilesArgs = [];
  state.searchResults = [];
  state.searchRootUnavailable = false;
  state.searchTruncated = false;
  state.searchIsError = false;
  state.echoRootOverride = null;
  state.projection = null;
  state.defaultHostId = "default-host";
  useSettingsStore.setState({
    diffViewerPreferences: DEFAULT_DIFF_VIEWER_PREFERENCES,
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function fileResult(relPath: string, name: string): WorkspaceSearchPathResult {
  return { kind: "file", relPath, name };
}

interface ArtifactSpec {
  readonly id: string;
  readonly folderName: string;
  readonly title: string;
  readonly parentId: string | null;
}

function projectionOf(specs: ReadonlyArray<ArtifactSpec>): EpicProjectedSlices {
  const byId: Record<string, ArtifactProjection> = {};
  const nodeById: Record<string, TreeNode> = {};
  for (const spec of specs) {
    byId[spec.id] = {
      id: spec.id,
      kind: "spec",
      title: spec.title,
      folderName: spec.folderName,
      parentId: spec.parentId,
      artifactRoomId: null,
      createdAt: 0,
      updatedAt: 0,
      status: null,
      createdManually: false,
    };
    nodeById[spec.id] = {
      id: spec.id,
      parentId: spec.parentId,
      title: spec.title,
      type: "spec",
      status: null,
      createdAt: 0,
      updatedAt: 0,
    };
  }
  return {
    ...EMPTY_PROJECTED_SLICES,
    artifacts: { allIds: specs.map((spec) => spec.id), byId },
    tree: {
      rootIds: specs
        .filter((spec) => spec.parentId === null)
        .map((spec) => spec.id),
      childrenByParent: {},
      nodeById,
    },
  };
}

describe("Files opener sub-page (source list)", () => {
  it("always offers Artifacts first, then each browsable root - no single-workspace shortcut", () => {
    state.rows = [bindingRow("/ws/alpha", true), bindingRow("/ws/only", true)];
    const items = renderItems(useFilesOpenerItems);
    expect(items.map((i) => i.id)).toEqual([
      "open:files:artifacts",
      "open:files:ws:default-host:%2Fws%2Falpha",
      "open:files:ws:default-host:%2Fws%2Fonly",
    ]);
    // Every entry is a step (subpage), never an immediate file open.
    expect(items.every((i) => i.subpage !== null)).toBe(true);
  });

  it("keeps Artifacts available even with a single workspace (no auto-skip)", () => {
    state.rows = [bindingRow("/ws/only", true)];
    const items = renderItems(useFilesOpenerItems);
    expect(items.map((i) => i.id)).toEqual([
      "open:files:artifacts",
      "open:files:ws:default-host:%2Fws%2Fonly",
    ]);
  });

  it("offers Artifacts for an Epic with no attached code workspace", () => {
    state.rows = [];
    const items = renderItems(useFilesOpenerItems);
    expect(items.map((i) => i.id)).toEqual(["open:files:artifacts"]);
  });

  it("includes bound worktree roots as sources", () => {
    state.rows = [
      bindingRow("/ws/main", true),
      worktreeBindingRow("/ws/main", "/worktrees/feature"),
    ];
    const items = renderItems(useFilesOpenerItems);
    expect(items.map((i) => i.id)).toEqual([
      "open:files:artifacts",
      "open:files:ws:default-host:%2Fws%2Fmain",
      "open:files:ws:default-host:%2Fworktrees%2Ffeature",
    ]);
  });
});

describe("Files opener sub-page (code root step)", () => {
  function codeStepItems(root: string): ReadonlyArray<CommandItem> {
    state.rows = [bindingRow(root, true)];
    const items = renderItems(useFilesOpenerItems);
    const rootItem = items.find((i) => i.id.startsWith("open:files:ws:"));
    if (rootItem === undefined) throw new Error("no code-root source");
    return renderSubpageItems(rootItem);
  }

  it("opens a host-ranked file result as a WorkspaceFileRef", () => {
    state.searchResults = [fileResult("src/a.ts", "a.ts")];
    const fileItems = codeStepItems("/ws/only");
    expect(fileItems.map((i) => i.id)).toEqual([
      "open:files:/ws/only:src/a.ts",
    ]);
    runById(fileItems, "open:files:/ws/only:src/a.ts");
    const opened = lastTileOpen();
    expect(opened.groupId).toBe("group-1");
    expect(opened.navigateNestedFocus).toBe(navigateNestedFocusSpy);
    expect(opened.ref.type).toBe("workspace-file");
    expect(opened.ref.id).toContain("src%2Fa.ts");
  });

  it("appends a truncated hint when the host caps the result set", () => {
    state.searchResults = [fileResult("src/a.ts", "a.ts")];
    state.searchTruncated = true;
    const fileItems = codeStepItems("/ws/only");
    expect(fileItems.map((i) => i.id)).toEqual([
      "open:files:/ws/only:src/a.ts",
      "open:files:truncated",
    ]);
  });

  it("shows a distinct notice when the workspace root is unavailable", () => {
    state.searchRootUnavailable = true;
    const fileItems = codeStepItems("/ws/only");
    expect(fileItems.map((i) => i.id)).toEqual([
      "open:files:ws:/ws/only:unavailable",
    ]);
    expect(fileItems.every((i) => i.subpage === null)).toBe(true);
  });

  it("shows a distinct notice when the host lacks the search RPC", () => {
    state.searchIsError = true;
    const fileItems = codeStepItems("/ws/only");
    expect(fileItems.map((i) => i.id)).toEqual([
      "open:files:ws:/ws/only:unsupported",
    ]);
  });

  it("returns no rows for a ready-but-empty search (distinct from unavailable)", () => {
    state.searchResults = [];
    state.searchRootUnavailable = false;
    const fileItems = codeStepItems("/ws/only");
    expect(fileItems).toEqual([]);
  });

  it("drops a late reply echoing a different root (stale-selection guard)", () => {
    state.searchResults = [fileResult("src/a.ts", "a.ts")];
    state.echoRootOverride = "/ws/some-previous-workspace";
    const fileItems = codeStepItems("/ws/only");
    expect(fileItems).toEqual([]);
  });

  it("keeps a Windows workspace root verbatim in the opened ref", () => {
    state.searchResults = [fileResult("src/win.ts", "win.ts")];
    const fileItems = codeStepItems("C:\\repo");
    runById(fileItems, "open:files:C:\\repo:src/win.ts");
    const opened = lastTileOpen();
    expect(opened.ref.type).toBe("workspace-file");
    // The host-canonical relPath and native root both survive into the ref id.
    expect(opened.ref.id).toContain("src%2Fwin.ts");
  });
});

describe("Files opener sub-page (Artifacts step)", () => {
  function artifactStepItems(): ReadonlyArray<CommandItem> {
    const items = renderItems(useFilesOpenerItems);
    const artifactsItem = items.find((i) => i.id === "open:files:artifacts");
    if (artifactsItem === undefined) throw new Error("no artifacts source");
    return renderSubpageItems(artifactsItem);
  }

  it("resolves a logical artifact path to an authoritative artifact and opens it", () => {
    state.projection = projectionOf([
      { id: "a1", folderName: "one", title: "First Spec", parentId: null },
    ]);
    state.searchResults = [fileResult("one", "one")];
    const items = artifactStepItems();
    expect(items.map((i) => i.id)).toEqual(["open:files:artifacts:a1"]);
    expect(items[0].label).toBe("First Spec");
    runById(items, "open:files:artifacts:a1");
    const opened = lastTileOpen();
    expect(opened.ref.type).toBe("spec");
    expect(opened.ref.id).toBe("a1");
    expect(opened.ref.name).toBe("First Spec");
  });

  it("disambiguates duplicate leaf titles by their ancestor-title path", () => {
    state.projection = projectionOf([
      { id: "p1", folderName: "parent-a", title: "Parent A", parentId: null },
      { id: "p2", folderName: "parent-b", title: "Parent B", parentId: null },
      { id: "c1", folderName: "child", title: "Notes", parentId: "p1" },
      { id: "c2", folderName: "child", title: "Notes", parentId: "p2" },
    ]);
    state.searchResults = [
      fileResult("parent-a/child", "child"),
      fileResult("parent-b/child", "child"),
    ];
    const items = artifactStepItems();
    expect(items.map((i) => i.label)).toEqual([
      "Parent A / Notes",
      "Parent B / Notes",
    ]);
    expect(items.map((i) => i.id)).toEqual([
      "open:files:artifacts:c1",
      "open:files:artifacts:c2",
    ]);
  });

  it("drops a stale/deleted artifact whose path is not in authoritative state", () => {
    state.projection = projectionOf([
      { id: "a1", folderName: "kept", title: "Kept", parentId: null },
    ]);
    state.searchResults = [
      fileResult("kept", "kept"),
      fileResult("deleted-on-disk", "deleted-on-disk"),
    ];
    const items = artifactStepItems();
    // Only the still-projected artifact survives; the orphan disk row is gone.
    expect(items.map((i) => i.id)).toEqual(["open:files:artifacts:a1"]);
  });

  it("fails closed on an ambiguous logical path - no row, no open", () => {
    // Two live artifacts claim the same folder chain "dup" (a malformed
    // projection). The shared fail-closed index resolves it to no identity, so
    // the result row is dropped and clicking opens nothing.
    state.projection = projectionOf([
      { id: "a", folderName: "dup", title: "A", parentId: null },
      { id: "b", folderName: "dup", title: "B", parentId: null },
    ]);
    state.searchResults = [fileResult("dup", "dup")];
    const items = artifactStepItems();
    expect(items.some((i) => i.id.startsWith("open:files:artifacts:"))).toBe(
      false,
    );
    expect(state.openTileIntoTargetGroup).not.toHaveBeenCalled();
  });

  it("shows a distinct notice when the artifact mirror is unavailable", () => {
    state.projection = projectionOf([]);
    state.searchRootUnavailable = true;
    const items = artifactStepItems();
    expect(items.map((i) => i.id)).toEqual([
      "open:files:artifacts:unavailable",
    ]);
  });

  it("shows a distinct notice when the host lacks the search RPC", () => {
    state.projection = projectionOf([]);
    state.searchIsError = true;
    const items = artifactStepItems();
    expect(items.map((i) => i.id)).toEqual([
      "open:files:artifacts:unsupported",
    ]);
  });

  it("appends a truncated hint for a capped artifact result set", () => {
    state.projection = projectionOf([
      { id: "a1", folderName: "one", title: "One", parentId: null },
    ]);
    state.searchResults = [fileResult("one", "one")];
    state.searchTruncated = true;
    const items = artifactStepItems();
    expect(items.map((i) => i.id)).toEqual([
      "open:files:artifacts:a1",
      "open:files-artifacts:truncated",
    ]);
  });
});

describe("Diff opener sub-page", () => {
  it("excludes non-git workspaces and drills into changed files", () => {
    state.rows = [
      bindingRow("/ws/alpha", true),
      bindingRow("/ws/beta", true),
      bindingRow("/ws/plain", false),
    ];
    state.changedFiles = [changedFile("src/changed.ts")];
    const items = renderItems(useDiffOpenerItems);
    expect(items.map((i) => i.id)).toEqual([
      "open:diff:ws:default-host:%2Fws%2Falpha",
      "open:diff:ws:default-host:%2Fws%2Fbeta",
    ]);
    const diffItems = renderSubpageItems(items[0]);
    runById(diffItems, "open:diff:/ws/alpha:src/changed.ts:unstaged");
    const opened = lastTileOpen();
    expect(opened.groupId).toBe("group-1");
    // Proves the opener leaf threads the ctx.router navigation seam through
    // to openTileIntoTargetGroup instead of bypassing it.
    expect(opened.navigateNestedFocus).toBe(navigateNestedFocusSpy);
    expect(opened.ref.type).toBe("git-diff");
  });

  it("single git-workspace skips straight to the changed-file step", () => {
    state.rows = [bindingRow("/ws/only", true)];
    state.changedFiles = [changedFile("src/x.ts")];
    const items = renderItems(useDiffOpenerItems);
    expect(items.map((i) => i.id)).toEqual([
      "open:diff:/ws/only:src/x.ts:unstaged",
    ]);
    runById(items, "open:diff:/ws/only:src/x.ts:unstaged");
    expect(lastTileOpen().ref.type).toBe("git-diff");
  });

  it("uses the global whitespace preference for changed-file subscriptions", () => {
    useSettingsStore.getState().setDiffViewerPreferences({
      ...DEFAULT_DIFF_VIEWER_PREFERENCES,
      ignoreWhitespace: true,
    });
    state.rows = [bindingRow("/ws/only", true)];
    state.changedFiles = [changedFile("src/x.ts")];

    renderItems(useDiffOpenerItems);

    expect(state.gitListChangedFilesArgs.at(-1)).toEqual({
      hostId: "default-host",
      runningDir: "/ws/only",
      ignoreWhitespace: true,
      enabled: true,
    });
  });

  it("includes bound git worktree roots in the workspace step", () => {
    state.rows = [
      bindingRow("/ws/main", true),
      worktreeBindingRow("/ws/main", "/worktrees/feature"),
      bindingRow("/ws/plain", false),
      {
        ...worktreeBindingRow("/ws/plain", "/worktrees/plain"),
        isGitRepo: false,
      },
    ];
    state.changedFiles = [changedFile("src/diff.ts")];
    const items = renderItems(useDiffOpenerItems);
    expect(items.map((i) => i.id)).toEqual([
      "open:diff:ws:default-host:%2Fws%2Fmain",
      "open:diff:ws:default-host:%2Fworktrees%2Ffeature",
    ]);
    const diffItems = renderSubpageItems(items[1]);
    runById(diffItems, "open:diff:/worktrees/feature:src/diff.ts:unstaged");
    expect(lastTileOpen().ref.type).toBe("git-diff");
  });
});
