import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { cleanup, renderHook } from "@testing-library/react";
import { PaletteQueryProvider } from "@/lib/commands/palette-query-context";
import type {
  GitChangedFile,
  WorktreeBindingSelectorRow,
} from "@traycer/protocol/host";
import type { CommandContext, CommandItem } from "@/lib/commands/types";
import type { KeybindingRouter } from "@/lib/keybindings/dispatch";
import type { OpenTileIntoTargetGroupArgs } from "@/lib/commands/actions/open-into-target";
import { DEFAULT_DIFF_VIEWER_PREFERENCES } from "@/lib/diff/diff-viewer-preferences";
import { getBasename } from "@/lib/path/cross-platform-path";
import { useSettingsStore } from "@/stores/settings/settings-store";

interface FileNode {
  readonly path: string;
  readonly name: string;
}
interface GitListChangedFilesArgs {
  readonly hostId: string;
  readonly runningDir: string | null;
  readonly ignoreWhitespace: boolean;
  readonly enabled: boolean;
}

const state = vi.hoisted(() => ({
  openTileIntoTargetGroup: vi.fn<(args: OpenTileIntoTargetGroupArgs) => void>(),
  query: "",
  rows: [] as ReadonlyArray<WorktreeBindingSelectorRow>,
  files: [] as ReadonlyArray<FileNode>,
  truncated: false,
  changedFiles: [] as ReadonlyArray<GitChangedFile>,
  gitListChangedFilesArgs: [] as GitListChangedFilesArgs[],
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
vi.mock("@/hooks/workspace/use-list-file-tree-query", () => ({
  useWorkspaceListFileTree: (workspacePath: string | null) => ({
    data:
      workspacePath === null
        ? undefined
        : {
            workspacePath,
            files: state.files,
            gitStatus: [],
            truncated: state.truncated,
          },
  }),
}));
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
): WorktreeBindingSelectorRow {
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
  };
}

function worktreeBindingRow(
  workspacePath: string,
  runningDir: string,
): WorktreeBindingSelectorRow {
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

function queryWrapper(
  query: string,
): (props: { readonly children: ReactNode }) => ReactNode {
  return ({ children }) =>
    createElement(PaletteQueryProvider, { value: query }, children);
}

function renderItemsWithQuery(
  hook: (ctx: CommandContext) => ReadonlyArray<CommandItem>,
  query: string,
): ReadonlyArray<CommandItem> {
  return renderHook<ReadonlyArray<CommandItem>, unknown>(() => hook(CTX), {
    wrapper: queryWrapper(query),
  }).result.current;
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
  state.files = [];
  state.truncated = false;
  state.changedFiles = [];
  state.gitListChangedFilesArgs = [];
  useSettingsStore.setState({
    diffViewerPreferences: DEFAULT_DIFF_VIEWER_PREFERENCES,
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Files opener sub-page", () => {
  it("multi-workspace shows a workspace step that drills into files", () => {
    state.rows = [bindingRow("/ws/alpha", true), bindingRow("/ws/beta", false)];
    state.files = [{ path: "src/a.ts", name: "a.ts" }];
    const items = renderItems(useFilesOpenerItems);
    expect(items.map((i) => i.id)).toEqual([
      "open:files:ws:default-host:%2Fws%2Falpha",
      "open:files:ws:default-host:%2Fws%2Fbeta",
    ]);
    const fileItems = renderSubpageItems(items[0]);
    expect(fileItems[0].id).toBe("open:files:/ws/alpha:src/a.ts");
    runById(fileItems, "open:files:/ws/alpha:src/a.ts");
    const opened = lastTileOpen();
    expect(opened.groupId).toBe("group-1");
    expect(opened.ref.type).toBe("workspace-file");
    expect(opened.ref.id).toContain("src%2Fa.ts");
  });

  it("single-workspace skips straight to the file step", () => {
    state.rows = [bindingRow("/ws/only", true)];
    state.files = [{ path: "src/b.ts", name: "b.ts" }];
    const items = renderItems(useFilesOpenerItems);
    expect(items.map((i) => i.id)).toEqual(["open:files:/ws/only:src/b.ts"]);
    runById(items, "open:files:/ws/only:src/b.ts");
    expect(lastTileOpen().ref.type).toBe("workspace-file");
  });

  it("caps a large tree and appends a truncated hint", () => {
    state.rows = [bindingRow("/ws/only", true)];
    state.files = Array.from({ length: 250 }, (_, i) => ({
      path: `src/f${i}.ts`,
      name: `f${i}.ts`,
    }));
    const items = renderItems(useFilesOpenerItems);
    expect(items.length).toBe(101); // OPENER_RESULT_CAP (100) + hint row
    expect(items[items.length - 1].id).toBe("open:files:truncated");
  });

  it("filters the file step by the surface's live query, not the global store", () => {
    // The store query is left empty; only the provided surface query should
    // narrow the list. This guards against the modal palette's query bleeding
    // into an open in-pane opener (they keep independent query state).
    state.query = "";
    state.rows = [bindingRow("/ws/only", true)];
    state.files = [
      { path: "src/alpha.ts", name: "alpha.ts" },
      { path: "src/beta.ts", name: "beta.ts" },
    ];
    const items = renderItemsWithQuery(useFilesOpenerItems, "alpha");
    expect(items.map((i) => i.id)).toEqual([
      "open:files:/ws/only:src/alpha.ts",
    ]);
  });

  it("narrows a large tree by a bare filename query", () => {
    state.rows = [bindingRow("/ws/only", true)];
    state.files = [
      ...Array.from({ length: 250 }, (_, i) => ({
        path: `src/f${i}.ts`,
        name: `f${i}.ts`,
      })),
      { path: "src/deep/needle.tsx", name: "needle.tsx" },
    ];
    const items = renderItemsWithQuery(useFilesOpenerItems, "needle.tsx");
    expect(items.map((i) => i.id)).toEqual([
      "open:files:/ws/only:src/deep/needle.tsx",
    ]);
  });

  it("resolves a pasted absolute path to its workspace-relative file", () => {
    state.rows = [bindingRow("/ws/only", true)];
    state.files = [
      { path: "src/a.ts", name: "a.ts" },
      { path: "src/components/foo.tsx", name: "foo.tsx" },
    ];
    const items = renderItemsWithQuery(
      useFilesOpenerItems,
      "/ws/only/src/components/foo.tsx",
    );
    expect(items.map((i) => i.id)).toEqual([
      "open:files:/ws/only:src/components/foo.tsx",
    ]);
  });

  it("includes bound worktree roots in the workspace step", () => {
    state.rows = [
      bindingRow("/ws/main", true),
      worktreeBindingRow("/ws/main", "/worktrees/feature"),
    ];
    state.files = [{ path: "src/wt.ts", name: "wt.ts" }];
    const items = renderItems(useFilesOpenerItems);
    expect(items.map((i) => i.id)).toEqual([
      "open:files:ws:default-host:%2Fws%2Fmain",
      "open:files:ws:default-host:%2Fworktrees%2Ffeature",
    ]);
    const fileItems = renderSubpageItems(items[1]);
    expect(fileItems[0].id).toBe("open:files:/worktrees/feature:src/wt.ts");
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
