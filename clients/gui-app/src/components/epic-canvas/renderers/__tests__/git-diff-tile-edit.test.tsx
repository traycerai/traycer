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
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  type RenderResult,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { FileContents } from "@pierre/diffs";
import type { EditorOptions } from "@pierre/diffs/edit";
import type { GitChangedFile, GitStage } from "@traycer/protocol/host";
import type { DiffClickToEditAdapter } from "@/components/diff/use-diff-click-to-edit";
import { makeGitFileDiffTile } from "@/lib/git/git-diff-tile";
import { DEFAULT_DIFF_VIEWER_PREFERENCES } from "@/lib/diff/diff-viewer-preferences";
import { useSettingsStore } from "@/stores/settings/settings-store";
import type { GitDiffTileRef } from "@/stores/epics/canvas/types";
import { fileEditRuntimeRegistry } from "@/lib/workspace/file-edit-runtime-registry";
import { DRIFT_RETRY_BASE_DELAY_MS } from "@/components/epic-canvas/git-diff/git-diff-editing";
import {
  PaneActivationFocusIntentContext,
  usePaneActivationOwnership,
} from "@/components/epic-canvas/pane-activation";

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
  sizeBytes: number;
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
  sizeBytes: 17,
}));

interface DiffSurfaceTestState {
  mountCount: number;
  unmountCount: number;
  readonly editableNewFiles: FileContents[];
  lastIsEmptyFile: boolean | null;
}

const diffSurfaceState = vi.hoisted((): DiffSurfaceTestState => ({
  mountCount: 0,
  unmountCount: 0,
  editableNewFiles: [],
  lastIsEmptyFile: null,
}));

const preloadState = vi.hoisted(() => ({
  preload: vi.fn(() => Promise.resolve()),
}));

const editorOpenState = vi.hoisted(() => ({ mutate: vi.fn() }));

// The tile re-provides its own `StreamRuntimeContext` for the host it is BOUND
// to, so `git.subscribeStatus` cannot ride the window's effective host while
// carrying the tile's host id as a param. `null` is that hook's FOLLOWING
// answer, so the tile falls back to the ambient binding this suite supplies -
// which is what every assertion here is about. Which transport a host resolves
// to is a different question with its own suite:
// `use-surface-host-stream-binding.test.tsx`.
// The hook returns the value to PROVIDE: the ambient binding while following
// (this suite's), the pin's own once built, null while pending. Following here.
vi.mock("@/hooks/host/use-surface-host-stream-binding", async () => {
  const { use } = await import("react");
  const { StreamRuntimeContext } =
    await import("@/lib/host/stream-runtime-context");
  return { useSurfaceHostStreamBinding: () => use(StreamRuntimeContext) };
});

vi.mock("@/components/diff/diff-edit-provider-loader", () => ({
  preloadDiffEditProvider: () => preloadState.preload(),
}));

vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => "host-A",
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
    watcherStatus: null,
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

// The tile dispatches `editor.openPaths` on its TAB client, not the app-wide
// one - `editor.openPaths` resolves paths on the host it is sent to (D15). The
// mocked hook ignores the client it is handed; what this repoint pins is that
// the tile no longer imports the app-wide `useEditorOpen` at all.
vi.mock("@/hooks/editor/use-editor-open-mutation", () => ({
  useEditorOpenForClient: () => ({
    mutate: editorOpenState.mutate,
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
    readonly isEmptyFile?: boolean;
    readonly editSession?: {
      readonly editorOptions: EditorOptions<undefined>;
      readonly oldFile: FileContents | null;
      readonly newFile: FileContents;
    };
  }): ReactNode {
    const [editorDocument, setEditorDocument] = useState(
      () => state.worktreeContent,
    );
    const [editorCaret, setEditorCaret] = useState(0);
    const newFile = props.editSession?.newFile;
    const isEmptyFile = props.isEmptyFile ?? null;

    useEffect(() => {
      diffSurfaceState.mountCount += 1;
      return () => {
        diffSurfaceState.unmountCount += 1;
      };
    }, []);

    useEffect(() => {
      if (
        newFile !== undefined &&
        diffSurfaceState.editableNewFiles.at(-1) !== newFile
      ) {
        diffSurfaceState.editableNewFiles.push(newFile);
      }
    }, [newFile]);

    useEffect(() => {
      diffSurfaceState.lastIsEmptyFile = isEmptyFile;
    }, [isEmptyFile]);

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
        <button
          type="button"
          onClick={() => {
            props.editAdapter?.activateEmptyOrigin();
          }}
        >
          Click empty origin
        </button>
        {props.editSession === undefined ? null : (
          <>
            <button
              type="button"
              onClick={() => {
                changeEditorDocument(
                  state.nextDraftContent,
                  state.nextDraftCaret,
                  true,
                );
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

function RemountingPane(props: {
  readonly render: (active: boolean) => ReactNode;
}): ReactNode {
  const [active, setActive] = useState(true);
  const [generation, setGeneration] = useState(0);
  const activation = usePaneActivationOwnership({
    active,
    activate: () => {
      setActive(true);
      setGeneration((current) => current + 1);
    },
  });
  return (
    <>
      <button type="button" onClick={() => setActive(false)}>
        Deactivate pane
      </button>
      <PaneActivationFocusIntentContext.Provider value={activation.focusIntent}>
        <div
          onFocusCapture={activation.onFocusCapture}
          onPointerCancelCapture={activation.onPointerCancelCapture}
          onPointerDownCapture={activation.onPointerDownCapture}
        >
          <div key={generation}>{props.render(active)}</div>
        </div>
      </PaneActivationFocusIntentContext.Provider>
    </>
  );
}

describe("<GitDiffTile /> editing", () => {
  beforeEach(() => {
    fileEditRuntimeRegistry.resetForTesting();
    useSettingsStore.setState({
      defaultEditor: null,
      diffViewerPreferences: DEFAULT_DIFF_VIEWER_PREFERENCES,
    });
    editorOpenState.mutate.mockReset();
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
    state.sizeBytes = 17;
    diffSurfaceState.mountCount = 0;
    diffSurfaceState.unmountCount = 0;
    diffSurfaceState.editableNewFiles.length = 0;
    diffSurfaceState.lastIsEmptyFile = null;
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

  it("finishes Open in editor before an inactive pane remounts", () => {
    renderTileInRemountingPane(NODE);

    fireEvent.click(screen.getByRole("button", { name: "Diff settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Deactivate pane" }));
    const openInEditor = screen.getByRole("button", {
      name: "Open in editor",
    });
    fireEvent.pointerDown(openInEditor);
    fireEvent.click(openInEditor);

    expect(editorOpenState.mutate).toHaveBeenCalledWith({
      editorId: "vscode",
      paths: ["/work/repo/src/app.ts"],
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

  it("retries a failed drift comparison on a backoff timer, not on every render", async () => {
    const rendered = renderTile(NODE, true);
    fireEvent.click(screen.getByRole("button", { name: "Click code" }));
    expect(
      await screen.findByRole("button", { name: "Change draft" }),
    ).toBeTruthy();
    expect(state.refetchContents).toHaveBeenCalledTimes(1);

    state.refetchContents.mockResolvedValueOnce({
      error: new Error("worktree read offline"),
      data: undefined,
    });
    state.worktreeOid = "worktree-2";

    vi.useFakeTimers();
    try {
      await act(async () => {
        rendered.rerender(tileElement(NODE, true));
        // Flush the failed refetch's own microtask chain (real Promise
        // scheduling, independent of the fake macrotask/timer queue) so
        // `scheduleRetry` runs and arms the backoff timer.
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(state.refetchContents).toHaveBeenCalledTimes(2);
      expect(screen.queryByText("Worktree changed")).toBeNull();

      // A render alone - the same trigger the old, unbounded retry relied on
      // - must NOT retry while the backoff timer is still pending, or a
      // persistently unreachable host would be hit on every render with no
      // delay at all.
      act(() => {
        rendered.rerender(tileElement(NODE, true));
      });
      expect(state.refetchContents).toHaveBeenCalledTimes(2);

      // Once the backoff delay elapses, the retry fires on its own - no
      // render required.
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      state.worktreeContent = "const external = true;\n";
      await act(async () => {
        await vi.advanceTimersByTimeAsync(DRIFT_RETRY_BASE_DELAY_MS);
      });
      expect(state.refetchContents).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }

    const staleStatus = await screen.findByText("Worktree changed");
    expect(staleStatus).toBeTruthy();
  });

  it("backs off exponentially across consecutive failures and recovers once the host reconnects", async () => {
    const rendered = renderTile(NODE, true);
    fireEvent.click(screen.getByRole("button", { name: "Click code" }));
    expect(
      await screen.findByRole("button", { name: "Change draft" }),
    ).toBeTruthy();
    expect(state.refetchContents).toHaveBeenCalledTimes(1);

    const offline = () =>
      Promise.resolve({
        error: new Error("worktree read offline"),
        data: undefined,
      });
    state.refetchContents.mockImplementationOnce(offline);
    state.worktreeOid = "worktree-2";

    vi.useFakeTimers();
    try {
      // First failure - schedules a retry at the base delay.
      await act(async () => {
        rendered.rerender(tileElement(NODE, true));
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(state.refetchContents).toHaveBeenCalledTimes(2);

      // Second consecutive failure - the retry that fires from the base
      // delay above must itself fail again, arming a longer (2x) delay.
      state.refetchContents.mockImplementationOnce(offline);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(DRIFT_RETRY_BASE_DELAY_MS);
      });
      expect(state.refetchContents).toHaveBeenCalledTimes(3);

      // Not enough time has passed for the doubled delay yet - no third
      // retry - proving the backoff genuinely grows instead of staying flat.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(DRIFT_RETRY_BASE_DELAY_MS);
      });
      expect(state.refetchContents).toHaveBeenCalledTimes(3);

      // The rest of the doubled delay elapses and the host has reconnected
      // (the default mock's success path resumes) - drift is still detected
      // once the check finally gets through.
      state.worktreeContent = "const external = true;\n";
      await act(async () => {
        await vi.advanceTimersByTimeAsync(DRIFT_RETRY_BASE_DELAY_MS);
      });
      expect(state.refetchContents).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }

    const staleStatus = await screen.findByText("Worktree changed");
    expect(staleStatus).toBeTruthy();
  });

  it("keeps the editor document, caret, runtime draft, and editSession identity stable through a pending OID rollover", async () => {
    const rendered = renderTile(NODE, true);
    fireEvent.click(screen.getByRole("button", { name: "Click code" }));
    await screen.findByRole("button", { name: "Type draft" });
    await waitFor(() => {
      expect(diffSurfaceState.editableNewFiles).toHaveLength(1);
    });

    const editorBeforeRollover = screen.getByTestId("git-diff-editor-surface");
    const mountsBeforeRollover = diffSurfaceState.mountCount;
    const unmountsBeforeRollover = diffSurfaceState.unmountCount;
    // Stable oldFile/newFile identity is what DiffContentPrimitive keys its
    // hydration memo on - a new object per render would re-derive the diff
    // and reintroduce the partial-diff attach bug.
    const initialNewFile = diffSurfaceState.editableNewFiles[0];

    fireEvent.click(screen.getByRole("button", { name: "Type draft" }));
    expect(editorBeforeRollover.getAttribute("data-editor-document")).toBe(
      "const value = 2;\n",
    );
    expect(editorBeforeRollover.getAttribute("data-editor-caret")).toBe("16");
    expect(currentRuntimeDraft()).toBe("const value = 2;\n");
    expect(diffSurfaceState.editableNewFiles).toEqual([initialNewFile]);

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
    expect(diffSurfaceState.editableNewFiles).toEqual([initialNewFile]);

    state.nextDraftContent = "const value = 23;\n";
    state.nextDraftCaret = 17;
    fireEvent.click(screen.getByRole("button", { name: "Type draft" }));
    expect(editorBeforeRollover.getAttribute("data-editor-document")).toBe(
      "const value = 23;\n",
    );
    expect(editorBeforeRollover.getAttribute("data-editor-caret")).toBe("17");
    expect(currentRuntimeDraft()).toBe("const value = 23;\n");
    expect(diffSurfaceState.editableNewFiles).toEqual([initialNewFile]);

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
    expect(diffSurfaceState.mountCount).toBe(mountsBeforeRollover);
    expect(diffSurfaceState.unmountCount).toBe(unmountsBeforeRollover);
    expect(diffSurfaceState.editableNewFiles).toEqual([initialNewFile]);
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

  it("treats a zero-byte untracked file as empty-editable, activates through the empty-origin path (no clickable line), and autosaves the first typed character to the correct file", async () => {
    state.stage = "untracked";
    state.sizeBytes = 0;
    state.worktreeContent = "";
    state.nextDraftContent = "X";
    state.nextDraftCaret = 1;
    state.refetchContents.mockImplementation(() =>
      Promise.resolve({
        error: null,
        data: {
          runningDir: "/work/repo",
          filePath: "src/app.ts",
          oldFile: null,
          newFile: { name: "src/app.ts", contents: "" },
          worktreeFile: { name: "src/app.ts", contents: "" },
          error: null,
        },
      }),
    );
    const untrackedNode = makeGitFileDiffTile({
      hostId: "host-A",
      runningDir: "/work/repo",
      filePath: "src/app.ts",
      stage: "untracked",
      repositoryContext: null,
    });
    renderTile(untrackedNode, true);

    // `isEmptyFile` reaches FileDiffContent before any click - it must be
    // known while still read-only, to decide whether to show the
    // empty-origin affordance at all.
    await waitFor(() => {
      expect(diffSurfaceState.lastIsEmptyFile).toBe(true);
    });
    expect(screen.queryByRole("button", { name: "Change draft" })).toBeNull();

    // No line/token exists to click for an empty file - activation goes
    // through `activateEmptyOrigin` instead of a diff line/token click, but
    // must land on the exact same real hydration -> ownership -> editSession
    // pipeline (`begin` in `git-diff-editing.tsx`) as a normal code click.
    fireEvent.click(screen.getByRole("button", { name: "Click empty origin" }));
    expect(state.refetchContents).toHaveBeenCalledTimes(1);

    const changeDraft = await screen.findByRole("button", {
      name: "Change draft",
    });
    fireEvent.click(changeDraft);

    await waitFor(() => {
      expect(state.writeFile).toHaveBeenCalledWith({
        workspacePath: "/work/repo",
        filePath: "src/app.ts",
        // SHA-256 of the empty-string baseline (`fileContentRevision("")`),
        // not a guessed placeholder.
        expectedRevision:
          "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        content: "X",
      });
    });
  });

  it("keeps a zero-byte staged file read-only - size alone must not bypass the staged edit gate", async () => {
    state.stage = "staged";
    state.sizeBytes = 0;
    const stagedNode = makeGitFileDiffTile({
      hostId: "host-A",
      runningDir: "/work/repo",
      filePath: "src/app.ts",
      stage: "staged",
      repositoryContext: null,
    });
    renderTile(stagedNode, true);

    await waitFor(() => {
      expect(diffSurfaceState.lastIsEmptyFile).toBe(false);
    });

    fireEvent.click(screen.getByRole("button", { name: "Click empty origin" }));
    expect(state.refetchContents).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Change draft" })).toBeNull();
  });
});

let activeQueryClient: QueryClient | null = null;

function renderTile(node: GitDiffTileRef, isActive: boolean): RenderResult {
  activeQueryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(tileElement(node, isActive));
}

function renderTileInRemountingPane(node: GitDiffTileRef): RenderResult {
  activeQueryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <RemountingPane render={(active) => tileElement(node, active)} />,
  );
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
    sizeBytes: state.sizeBytes,
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
