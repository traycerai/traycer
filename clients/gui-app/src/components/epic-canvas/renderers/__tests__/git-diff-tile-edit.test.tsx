import "../../../../../__tests__/test-browser-apis";
import { useEffect, useState, type ReactNode } from "react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  type RenderResult,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { FileDiffContentsLoader, FileDiffMetadata } from "@pierre/diffs";
import type { EditorOptions } from "@pierre/diffs/edit";
import type { GitChangedFile, GitStage } from "@traycer/protocol/host";
import type { DiffClickToEditAdapter } from "@/components/diff/use-diff-click-to-edit";
import { makeGitFileDiffTile } from "@/lib/git/git-diff-tile";
import { DEFAULT_DIFF_VIEWER_PREFERENCES } from "@/lib/diff/diff-viewer-preferences";
import { useSettingsStore } from "@/stores/settings/settings-store";
import type { GitDiffTileRef } from "@/stores/epics/canvas/types";
import { fileEditRuntimeRegistry } from "@/lib/workspace/file-edit-runtime-registry";

interface EditTestState {
  readonly refetchContents: Mock;
  readonly writeFile: Mock;
  stage: GitStage;
  supportsEditing: boolean;
  diffPending: boolean;
  worktreeOid: string;
  worktreeContent: string;
  nextDraftContent: string;
  nextDraftCaret: number;
}

const state = vi.hoisted((): EditTestState => ({
  refetchContents: vi.fn(),
  writeFile: vi.fn(),
  stage: "unstaged",
  supportsEditing: true,
  diffPending: false,
  worktreeOid: "worktree-1",
  worktreeContent: "const value = 1;\n",
  nextDraftContent: "const value = 2;\n",
  nextDraftCaret: 16,
}));

interface DiffSurfaceTestState {
  mountCount: number;
  unmountCount: number;
  readonly loaders: FileDiffContentsLoader[];
}

const diffSurfaceState = vi.hoisted((): DiffSurfaceTestState => ({
  mountCount: 0,
  unmountCount: 0,
  loaders: [],
}));

const preloadState = vi.hoisted(() => ({
  preload: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/components/diff/diff-edit-provider-loader", () => ({
  preloadDiffEditProvider: () => preloadState.preload(),
}));

vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => "host-A",
}));

vi.mock("@/hooks/agent/use-host-reachability", () => ({
  useHostReachability: () => ({
    status: "reachable",
    hostLabel: "Host A",
  }),
}));

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostSupportsMethod: () => state.supportsEditing,
}));

vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => null,
}));

vi.mock("@/hooks/git/use-git-list-changed-files-subscription", () => ({
  useGitListChangedFilesSubscription: () => ({
    data: {
      branch: "main",
      headSha: "head-1",
      files: [changedFile(state.stage)],
    },
    error: null,
    isPending: false,
    repoState: null,
    repoMode: "normal",
    pollStartedAtMs: 1,
  }),
}));

vi.mock("@/hooks/git/use-git-get-file-diff-query", () => ({
  useGitGetFileDiffQuery: () => ({
    data: state.diffPending
      ? undefined
      : {
          filePath: "src/app.ts",
          headSha: "head-1",
          stagedOid: "index-1",
          worktreeOid: state.worktreeOid,
          patch: "diff --git a/src/app.ts b/src/app.ts\n",
          isTruncated: false,
          truncatedAfterBytes: null,
          isBinary: false,
        },
    error: null,
    isPending: state.diffPending,
  }),
}));

vi.mock("@/hooks/git/use-git-get-file-contents-query", () => ({
  useGitGetFileContentsQuery: () => ({
    isFetching: false,
    refetch: state.refetchContents,
  }),
}));

vi.mock("@/hooks/workspace/use-workspace-write-file-mutation", () => ({
  useWorkspaceWriteFile: () => ({
    isPending: false,
    mutateAsync: state.writeFile,
  }),
}));

vi.mock("@/hooks/git/use-git-refresh-worktree-status", () => ({
  useGitRefreshWorktreeStatus: () => ({
    mutateAsync: vi.fn(() => Promise.resolve()),
  }),
}));

vi.mock("@/hooks/editor/use-editor-open-mutation", () => ({
  useEditorOpen: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
}));

vi.mock("@/components/diff/use-register-diff-tile-find-adapter", () => ({
  useRegisterDiffTileFindAdapter: vi.fn(),
}));

vi.mock("@/components/diff/diff-find-navigation", () => ({
  useDiffFindNavigation: () => ({ setScrollContainer: vi.fn() }),
}));

vi.mock("@/components/epic-canvas/git-diff/file-diff-content", () => ({
  FileDiffContent: function FileDiffContentMock(props: {
    readonly editStatus?: ReactNode;
    readonly editAdapter?: DiffClickToEditAdapter;
    readonly editSession?: {
      readonly editorOptions: EditorOptions<undefined>;
      readonly loadDiffFiles: FileDiffContentsLoader;
    };
  }): ReactNode {
    const [editorDocument, setEditorDocument] = useState(
      () => state.worktreeContent,
    );
    const [editorCaret, setEditorCaret] = useState(0);
    const loader = props.editSession?.loadDiffFiles;

    useEffect(() => {
      diffSurfaceState.mountCount += 1;
      return () => {
        diffSurfaceState.unmountCount += 1;
      };
    }, []);

    useEffect(() => {
      if (loader !== undefined && diffSurfaceState.loaders.at(-1) !== loader) {
        diffSurfaceState.loaders.push(loader);
      }
    }, [loader]);

    const changeEditorDocument = (
      content: string,
      caret: number,
      blur: boolean,
    ): void => {
      setEditorDocument(content);
      setEditorCaret(caret);
      const changedFile = { name: "src/app.ts", contents: content };
      props.editSession?.editorOptions.onChange?.(changedFile, undefined, {
        changes: [],
        file: changedFile,
      });
      if (blur) props.editSession?.editorOptions.onBlur?.();
    };

    return (
      <div
        data-testid="git-diff-editor-surface"
        data-editor-document={editorDocument}
        data-editor-caret={editorCaret}
      >
        {props.editStatus}
        <button
          type="button"
          onClick={() => {
            props.editAdapter?.diffOptions.onLineClick?.({
              type: "diff-line",
              annotationSide: "additions",
              lineType: "change-addition",
              lineNumber: 1,
              lineElement: document.createElement("div"),
              numberElement: document.createElement("div"),
              numberColumn: false,
              event: new PointerEvent("click", { button: 0 }),
            });
          }}
        >
          Click code
        </button>
        {props.editSession === undefined ? null : (
          <>
            <button
              type="button"
              onClick={() => {
                changeEditorDocument("const value = 2;\n", 16, true);
              }}
            >
              Change draft
            </button>
            <button
              type="button"
              onClick={() => {
                changeEditorDocument(
                  state.nextDraftContent,
                  state.nextDraftCaret,
                  false,
                );
              }}
            >
              Type draft
            </button>
          </>
        )}
      </div>
    );
  },
}));

import { GitDiffTile } from "../git-diff-tile";
import { TabHostProvider } from "../../tab-host-provider";

const NODE = makeGitFileDiffTile({
  hostId: "host-A",
  runningDir: "/work/repo",
  filePath: "src/app.ts",
  stage: "unstaged",
  repositoryContext: null,
});

const EDITABLE_FILE_DIFF: FileDiffMetadata = {
  name: "src/app.ts",
  type: "change",
  hunks: [],
  splitLineCount: 0,
  unifiedLineCount: 0,
  isPartial: true,
  deletionLines: [],
  additionLines: [],
};

describe("<GitDiffTile /> editing", () => {
  beforeEach(() => {
    fileEditRuntimeRegistry.resetForTesting();
    useSettingsStore.setState({
      diffViewerPreferences: DEFAULT_DIFF_VIEWER_PREFERENCES,
    });
    state.refetchContents.mockReset();
    preloadState.preload.mockReset();
    preloadState.preload.mockImplementation(() => Promise.resolve());
    state.stage = "unstaged";
    state.supportsEditing = true;
    state.diffPending = false;
    state.worktreeOid = "worktree-1";
    state.worktreeContent = "const value = 1;\n";
    state.nextDraftContent = "const value = 2;\n";
    state.nextDraftCaret = 16;
    diffSurfaceState.mountCount = 0;
    diffSurfaceState.unmountCount = 0;
    diffSurfaceState.loaders.length = 0;
    state.refetchContents.mockImplementation(() =>
      Promise.resolve({
        error: null,
        data: {
          runningDir: "/work/repo",
          filePath: "src/app.ts",
          oldFile: { name: "src/app.ts", contents: "const value = 0;\n" },
          newFile: { name: "src/app.ts", contents: state.worktreeContent },
          worktreeFile: {
            name: "src/app.ts",
            contents: state.worktreeContent,
          },
          error: null,
        },
      }),
    );
    state.writeFile.mockReset();
    state.writeFile.mockResolvedValue({
      workspacePath: "/work/repo",
      filePath: "src/app.ts",
      status: "saved",
      revision:
        "bf9b806c23729c31c50fef0960d803b70877711ddc1f0cc57181d02c9fcc5542",
    });
  });

  afterEach(() => {
    cleanup();
    fileEditRuntimeRegistry.resetForTesting();
    vi.restoreAllMocks();
  });

  it("hydrates on a code click and autosaves the edited worktree text on blur", async () => {
    renderTile(NODE, true);

    fireEvent.click(screen.getByRole("button", { name: "Click code" }));

    expect(state.refetchContents).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(
        fileEditRuntimeRegistry
          .get({
            userId: null,
            hostId: "host-A",
            workspacePath: "/work/repo",
            filePath: "src/app.ts",
          })
          ?.store.getState().ownerSurfaceId,
      ).toBe(`git-diff:${NODE.instanceId}`);
    });
    const changeDraft = await screen.findByRole("button", {
      name: "Change draft",
    });
    const editingStatus = screen.getByTestId("file-autosave-status");
    expect(
      screen.getByTestId("diff-tab-header-accessory").contains(editingStatus),
    ).toBe(true);
    fireEvent.click(changeDraft);

    await waitFor(() => {
      expect(state.writeFile).toHaveBeenCalledWith({
        workspacePath: "/work/repo",
        filePath: "src/app.ts",
        expectedRevision:
          "8de5c07db8deb3b75dedd9b5bc999669936cea181ae0033c27c4e2071a6e434d",
        content: "const value = 2;\n",
      });
    });
  });

  it("keeps the Git draft when conflict resolution cannot read fresh worktree content", async () => {
    state.writeFile.mockResolvedValue({
      workspacePath: "/work/repo",
      filePath: "src/app.ts",
      status: "conflict",
      currentRevision: "external-revision",
      error: "The file changed on disk.",
    });
    renderTile(NODE, true);
    fireEvent.click(screen.getByRole("button", { name: "Click code" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Change draft" }),
    );
    state.refetchContents.mockResolvedValueOnce({
      error: new Error("worktree read offline"),
      data: undefined,
    });
    fireEvent.click(await screen.findByRole("button", { name: "Conflict" }));
    fireEvent.click(screen.getByRole("button", { name: "Use disk" }));

    expect(await screen.findByText("worktree read offline")).toBeTruthy();
    expect(currentRuntimeDraft()).toBe("const value = 2;\n");
    expect(screen.getByRole("button", { name: "Change draft" })).toBeTruthy();
  });

  it("keeps staged diffs read-only", () => {
    state.stage = "staged";
    const stagedNode = makeGitFileDiffTile({
      hostId: "host-A",
      runningDir: "/work/repo",
      filePath: "src/app.ts",
      stage: "staged",
      repositoryContext: null,
    });
    renderTile(stagedNode, true);

    fireEvent.click(screen.getByRole("button", { name: "Click code" }));

    expect(state.refetchContents).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Change draft" })).toBeNull();
  });

  it("allows an untracked new side and keeps unsupported hosts read-only", async () => {
    state.stage = "untracked";
    const untrackedNode = makeGitFileDiffTile({
      hostId: "host-A",
      runningDir: "/work/repo",
      filePath: "src/app.ts",
      stage: "untracked",
      repositoryContext: null,
    });
    renderTile(untrackedNode, true);
    fireEvent.click(screen.getByRole("button", { name: "Click code" }));
    expect(
      await screen.findByRole("button", { name: "Change draft" }),
    ).toBeTruthy();

    cleanup();
    fileEditRuntimeRegistry.resetForTesting();
    state.stage = "unstaged";
    state.supportsEditing = false;
    renderTile(NODE, true);
    fireEvent.click(screen.getByRole("button", { name: "Click code" }));
    await Promise.resolve();
    expect(screen.queryByRole("button", { name: "Change draft" })).toBeNull();
  });

  it("pins the active comparison and marks real background worktree drift stale", async () => {
    const rendered = renderTile(NODE, true);
    fireEvent.click(screen.getByRole("button", { name: "Click code" }));
    expect(
      await screen.findByRole("button", { name: "Change draft" }),
    ).toBeTruthy();

    state.worktreeOid = "worktree-2";
    state.worktreeContent = "const external = true;\n";
    rendered.rerender(tileElement(NODE, true));

    const staleStatus = await screen.findByText("Worktree changed");
    expect(
      screen.getByTestId("diff-tab-header-accessory").contains(staleStatus),
    ).toBe(true);
  });

  it("keeps the editor document, caret, runtime draft, and loader stable through a pending OID rollover", async () => {
    const rendered = renderTile(NODE, true);
    fireEvent.click(screen.getByRole("button", { name: "Click code" }));
    await screen.findByRole("button", { name: "Type draft" });
    await waitFor(() => {
      expect(diffSurfaceState.loaders).toHaveLength(1);
    });

    const editorBeforeRollover = screen.getByTestId("git-diff-editor-surface");
    const mountsBeforeRollover = diffSurfaceState.mountCount;
    const unmountsBeforeRollover = diffSurfaceState.unmountCount;
    const initialLoader = diffSurfaceState.loaders[0];

    fireEvent.click(screen.getByRole("button", { name: "Type draft" }));
    expect(editorBeforeRollover.getAttribute("data-editor-document")).toBe(
      "const value = 2;\n",
    );
    expect(editorBeforeRollover.getAttribute("data-editor-caret")).toBe("16");
    expect(currentRuntimeDraft()).toBe("const value = 2;\n");
    expect((await initialLoader(EDITABLE_FILE_DIFF)).newFile.contents).toBe(
      "const value = 2;\n",
    );
    expect(diffSurfaceState.loaders).toEqual([initialLoader]);

    state.worktreeOid = "worktree-2";
    state.diffPending = true;
    rendered.rerender(tileElement(NODE, true));

    expect(screen.getByTestId("git-diff-editor-surface")).toBe(
      editorBeforeRollover,
    );
    expect(editorBeforeRollover.getAttribute("data-editor-document")).toBe(
      "const value = 2;\n",
    );
    expect(editorBeforeRollover.getAttribute("data-editor-caret")).toBe("16");
    expect(diffSurfaceState.mountCount).toBe(mountsBeforeRollover);
    expect(diffSurfaceState.unmountCount).toBe(unmountsBeforeRollover);
    expect(diffSurfaceState.loaders).toEqual([initialLoader]);

    state.nextDraftContent = "const value = 23;\n";
    state.nextDraftCaret = 17;
    fireEvent.click(screen.getByRole("button", { name: "Type draft" }));
    expect(editorBeforeRollover.getAttribute("data-editor-document")).toBe(
      "const value = 23;\n",
    );
    expect(editorBeforeRollover.getAttribute("data-editor-caret")).toBe("17");
    expect(currentRuntimeDraft()).toBe("const value = 23;\n");
    expect((await initialLoader(EDITABLE_FILE_DIFF)).newFile.contents).toBe(
      "const value = 23;\n",
    );
    expect(diffSurfaceState.loaders).toEqual([initialLoader]);

    state.diffPending = false;
    rendered.rerender(tileElement(NODE, true));
    expect(screen.getByTestId("git-diff-editor-surface")).toBe(
      editorBeforeRollover,
    );
    expect(editorBeforeRollover.getAttribute("data-editor-document")).toBe(
      "const value = 23;\n",
    );
    expect(editorBeforeRollover.getAttribute("data-editor-caret")).toBe("17");
    expect(currentRuntimeDraft()).toBe("const value = 23;\n");
    expect((await initialLoader(EDITABLE_FILE_DIFF)).newFile.contents).toBe(
      "const value = 23;\n",
    );
    expect(diffSurfaceState.mountCount).toBe(mountsBeforeRollover);
    expect(diffSurfaceState.unmountCount).toBe(unmountsBeforeRollover);
    expect(diffSurfaceState.loaders).toEqual([initialLoader]);
  });

  it("starts Git hydration and editor preload in parallel and only activates after both settle", async () => {
    let resolveHydration!: (value: unknown) => void;
    let resolvePreload!: () => void;
    const hydrationPromise = new Promise((resolve) => {
      resolveHydration = resolve;
    });
    const preloadPromise = new Promise<void>((resolve) => {
      resolvePreload = resolve;
    });

    state.refetchContents.mockImplementation(() => hydrationPromise);
    preloadState.preload.mockReturnValue(preloadPromise);

    renderTile(NODE, true);
    fireEvent.click(screen.getByRole("button", { name: "Click code" }));

    // Both sides of Promise.all must be in flight before either settles.
    await waitFor(() => {
      expect(state.refetchContents).toHaveBeenCalledTimes(1);
      expect(preloadState.preload).toHaveBeenCalled();
    });
    expect(screen.queryByRole("button", { name: "Change draft" })).toBeNull();
    expect(
      fileEditRuntimeRegistry
        .get({
          userId: null,
          hostId: "host-A",
          workspacePath: "/work/repo",
          filePath: "src/app.ts",
        })
        ?.store.getState().ownerSurfaceId ?? null,
    ).toBeNull();

    // Completing only preload is not enough.
    resolvePreload();
    await preloadPromise;
    await Promise.resolve();
    expect(screen.queryByRole("button", { name: "Change draft" })).toBeNull();

    resolveHydration({
      error: null,
      data: {
        runningDir: "/work/repo",
        filePath: "src/app.ts",
        oldFile: { name: "src/app.ts", contents: "const value = 0;\n" },
        newFile: { name: "src/app.ts", contents: state.worktreeContent },
        worktreeFile: {
          name: "src/app.ts",
          contents: state.worktreeContent,
        },
        error: null,
      },
    });

    expect(
      await screen.findByRole("button", { name: "Change draft" }),
    ).toBeTruthy();
    expect(
      fileEditRuntimeRegistry
        .get({
          userId: null,
          hostId: "host-A",
          workspacePath: "/work/repo",
          filePath: "src/app.ts",
        })
        ?.store.getState().ownerSurfaceId,
    ).toBe(`git-diff:${NODE.instanceId}`);
  });

  it("releases ownership when an LRU keep-alive tab goes inactive while editing", async () => {
    const rendered = renderTile(NODE, true);
    fireEvent.click(screen.getByRole("button", { name: "Click code" }));
    await waitFor(() => {
      expect(
        fileEditRuntimeRegistry
          .get({
            userId: null,
            hostId: "host-A",
            workspacePath: "/work/repo",
            filePath: "src/app.ts",
          })
          ?.store.getState().ownerSurfaceId,
      ).toBe(`git-diff:${NODE.instanceId}`);
    });

    rendered.rerender(tileElement(NODE, false));

    await waitFor(() => {
      expect(
        fileEditRuntimeRegistry
          .get({
            userId: null,
            hostId: "host-A",
            workspacePath: "/work/repo",
            filePath: "src/app.ts",
          })
          ?.store.getState().ownerSurfaceId,
      ).toBeNull();
    });
  });

  it("dedupes the drift refetch across renders while the check is still pending", async () => {
    const rendered = renderTile(NODE, true);
    fireEvent.click(screen.getByRole("button", { name: "Click code" }));
    expect(
      await screen.findByRole("button", { name: "Change draft" }),
    ).toBeTruthy();
    expect(state.refetchContents).toHaveBeenCalledTimes(1);

    let resolveDrift!: (value: unknown) => void;
    const driftPromise = new Promise((resolve) => {
      resolveDrift = resolve;
    });
    state.refetchContents.mockImplementation(() => driftPromise);
    state.worktreeOid = "worktree-2";

    // Two rerenders while the drift check is still pending on the SAME stale
    // comparison identity. The mocked query result (like TanStack Query's
    // real one) is a fresh object every render, so without a synchronous
    // per-identity guard each rerender would start another overlapping
    // `git.getFileContents` refetch instead of joining the first attempt.
    rendered.rerender(tileElement(NODE, true));
    rendered.rerender(tileElement(NODE, true));
    await Promise.resolve();

    expect(state.refetchContents).toHaveBeenCalledTimes(2);

    resolveDrift({
      error: null,
      data: {
        runningDir: "/work/repo",
        filePath: "src/app.ts",
        oldFile: { name: "src/app.ts", contents: "const value = 0;\n" },
        newFile: {
          name: "src/app.ts",
          contents: "const external = true;\n",
        },
        worktreeFile: {
          name: "src/app.ts",
          contents: "const external = true;\n",
        },
        error: null,
      },
    });

    const staleStatus = await screen.findByText("Worktree changed");
    expect(
      screen.getByTestId("diff-tab-header-accessory").contains(staleStatus),
    ).toBe(true);
    expect(state.refetchContents).toHaveBeenCalledTimes(2);
  });
});

let activeQueryClient: QueryClient | null = null;

function renderTile(node: GitDiffTileRef, isActive: boolean): RenderResult {
  activeQueryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(tileElement(node, isActive));
}

// Reuses the QueryClient created by `renderTile` so `rendered.rerender(...)`
// calls below replace only the tile's props, not the cache-owning provider -
// production keeps one client for the tile's lifetime, and a fresh client per
// call would silently stop these rerender assertions from exercising cache
// continuity.
function tileElement(node: GitDiffTileRef, isActive: boolean): ReactNode {
  const queryClient = activeQueryClient;
  if (queryClient === null) throw new Error("Render the tile first.");
  return (
    <QueryClientProvider client={queryClient}>
      <TabHostProvider hostId="host-A">
        <GitDiffTile
          node={node}
          viewTabId="view-1"
          tileId={node.id}
          isActive={isActive}
        />
      </TabHostProvider>
    </QueryClientProvider>
  );
}

function changedFile(stage: GitStage): GitChangedFile {
  return {
    path: "src/app.ts",
    previousPath: null,
    status: "modified",
    stage,
    insertions: 1,
    deletions: 1,
    isBinary: false,
    sizeBytes: 17,
    stagedOid: "index-1",
    worktreeOid: state.worktreeOid,
  };
}

function currentRuntimeDraft(): string | null {
  return (
    fileEditRuntimeRegistry
      .get({
        userId: null,
        hostId: "host-A",
        workspacePath: "/work/repo",
        filePath: "src/app.ts",
      })
      ?.store.getState().draftContent ?? null
  );
}
