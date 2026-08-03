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
import type { FileContents } from "@pierre/diffs";
import type { EditorOptions } from "@pierre/diffs/edit";
import type { GitChangedFile } from "@traycer/protocol/host";
import { EpicSessionContext } from "@/lib/registries/epic-session-registry";
import { DEFAULT_DIFF_VIEWER_PREFERENCES } from "@/lib/diff/diff-viewer-preferences";
import { makeGitBundleDiffTile } from "@/lib/git/git-diff-tile";
import { fileEditRuntimeRegistry } from "@/lib/workspace/file-edit-runtime-registry";
import {
  createOpenEpicStore,
  type EpicStreamClientFactory,
  type OpenEpicStoreHandle,
} from "@/stores/epics/open-epic/store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type { DiffClickToEditAdapter } from "@/components/diff/use-diff-click-to-edit";
import { TabHostProvider } from "../../tab-host-provider";
import { BundleFileSection } from "../git-bundle-file-section";
import type { GitBundleDiffTileRef } from "../git-diff-tile-shared";

interface BundleEditTestState {
  readonly refetchContents: Mock;
  readonly writeFile: Mock;
  diffPending: boolean;
  worktreeOid: string;
  worktreeContent: string;
  nextDraftContent: string;
  nextDraftCaret: number;
}

const state = vi.hoisted((): BundleEditTestState => ({
  refetchContents: vi.fn(),
  writeFile: vi.fn(),
  diffPending: false,
  worktreeOid: "worktree-1",
  worktreeContent: "const value = 1;\n",
  nextDraftContent: "const value = 2;\n",
  nextDraftCaret: 16,
}));

interface BundleDiffSurfaceTestState {
  mountCount: number;
  unmountCount: number;
  readonly editableNewFiles: FileContents[];
}

const diffSurfaceState = vi.hoisted((): BundleDiffSurfaceTestState => ({
  mountCount: 0,
  unmountCount: 0,
  editableNewFiles: [],
}));

const preloadState = vi.hoisted(() => ({
  preload: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/components/diff/diff-edit-provider-loader", () => ({
  preloadDiffEditProvider: () => preloadState.preload(),
}));

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostSupportsMethod: () => true,
}));

vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => null,
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

vi.mock("@/components/epic-canvas/git-diff/file-diff-content", () => ({
  FileDiffContent: function FileDiffContentMock(props: {
    readonly editStatus?: ReactNode;
    readonly editAdapter?: DiffClickToEditAdapter;
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

    useEffect(() => {
      diffSurfaceState.mountCount += 1;
      return () => {
        diffSurfaceState.unmountCount += 1;
      };
    }, []);

    useEffect(() => {
      if (newFile === undefined) return;
      if (diffSurfaceState.editableNewFiles.at(-1) !== newFile) {
        diffSurfaceState.editableNewFiles.push(newFile);
      }
      setEditorDocument(newFile.contents);
    }, [newFile]);

    return (
      <div
        data-testid="bundle-diff-editor-surface"
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
          Click bundle code
        </button>
        {props.editSession === undefined ? null : (
          <button
            type="button"
            onClick={() => {
              setEditorDocument(state.nextDraftContent);
              setEditorCaret(state.nextDraftCaret);
              const changedFile = {
                name: "src/app.ts",
                contents: state.nextDraftContent,
              };
              props.editSession?.editorOptions.onChange?.(
                changedFile,
                undefined,
                { changes: [], file: changedFile },
              );
            }}
          >
            Type bundle draft
          </button>
        )}
      </div>
    );
  },
}));

function bundleNode(): GitBundleDiffTileRef {
  const node = makeGitBundleDiffTile({
    hostId: "host-A",
    runningDir: "/work/repo",
    bundleGroup: "changes",
    repositoryContext: null,
  });
  if (node.diff.kind !== "bundle") throw new Error("expected bundle node");
  return { ...node, diff: node.diff };
}

const NODE = bundleNode();

const fakeStreamClientFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});

let epicSessionHandle: OpenEpicStoreHandle;
let queryClient: QueryClient;
let viewTabId: string;

describe("<BundleFileSection /> editing", () => {
  beforeEach(() => {
    window.localStorage.clear();
    fileEditRuntimeRegistry.resetForTesting();
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    epicSessionHandle = createOpenEpicStore({
      epicId: "epic-1",
      userId: null,
      streamClientFactory: fakeStreamClientFactory,
      onAuthError: null,
    });
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    viewTabId = useEpicCanvasStore.getState().openEpicTab("epic-1", "Epic 1");
    state.diffPending = false;
    state.worktreeOid = "worktree-1";
    state.worktreeContent = "const value = 1;\n";
    state.nextDraftContent = "const value = 2;\n";
    state.nextDraftCaret = 16;
    state.refetchContents.mockReset();
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
    preloadState.preload.mockReset();
    preloadState.preload.mockImplementation(() => Promise.resolve());
    diffSurfaceState.mountCount = 0;
    diffSurfaceState.unmountCount = 0;
    diffSurfaceState.editableNewFiles.length = 0;
  });

  afterEach(() => {
    cleanup();
    fileEditRuntimeRegistry.resetForTesting();
    epicSessionHandle.dispose();
    vi.restoreAllMocks();
  });

  it("activates an eligible aggregate file and keeps one editor surface and loader while typing", async () => {
    renderBundleFile(true);

    fireEvent.click(screen.getByRole("button", { name: "Click bundle code" }));
    const typeDraft = await screen.findByRole("button", {
      name: "Type bundle draft",
    });
    await waitFor(() => {
      expect(diffSurfaceState.editableNewFiles).toHaveLength(1);
    });

    const surface = screen.getByTestId("bundle-diff-editor-surface");
    const editableNewFile = diffSurfaceState.editableNewFiles[0];
    const mounts = diffSurfaceState.mountCount;
    const unmounts = diffSurfaceState.unmountCount;
    const autosaveStatus = screen.getByTestId("file-autosave-status");
    const headerAccessory = screen.getByTestId("bundle-file-header-accessory");
    const stats = screen.getByTestId("git-changed-file-stats");
    expect(headerAccessory.contains(autosaveStatus)).toBe(true);
    expect(
      headerAccessory.compareDocumentPosition(stats) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    const statusPill = screen.getByTestId("file-autosave-pill");
    expect(statusPill.getAttribute("data-appearance")).toBe("quiet");
    expect(statusPill.className).toContain("h-5");
    expect(statusPill.className).not.toContain("bg-muted/45");
    expect(statusPill.className).not.toContain("shadow-xs");

    fireEvent.click(typeDraft);
    expect(screen.getByTestId("bundle-diff-editor-surface")).toBe(surface);
    expect(surface.getAttribute("data-editor-document")).toBe(
      "const value = 2;\n",
    );
    expect(surface.getAttribute("data-editor-caret")).toBe("16");
    expect(currentRuntimeDraft()).toBe("const value = 2;\n");
    expect(diffSurfaceState.mountCount).toBe(mounts);
    expect(diffSurfaceState.unmountCount).toBe(unmounts);
    // Stable oldFile/newFile identity is what DiffContentPrimitive keys its
    // hydration memo on - a new object per render would re-derive the diff
    // and reintroduce the partial-diff attach bug.
    expect(diffSurfaceState.editableNewFiles).toEqual([editableNewFile]);
  });

  it("restores a retained draft when virtualization remounts the file section", async () => {
    state.writeFile.mockRejectedValue(new Error("offline"));
    const rendered = renderBundleFile(true);
    fireEvent.click(screen.getByRole("button", { name: "Click bundle code" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Type bundle draft" }),
    );
    expect(currentRuntimeDraft()).toBe("const value = 2;\n");

    rendered.rerender(bundleFileElement(false));
    await waitFor(() => {
      expect(currentRuntimeState()?.ownerSurfaceId).toBeNull();
      expect(currentRuntimeState()?.isDirty).toBe(true);
    });

    rendered.rerender(bundleFileElement(true));
    await screen.findByRole("button", { name: "Type bundle draft" });
    await waitFor(() => {
      expect(currentRuntimeState()?.ownerSurfaceId).toBe(bundleSurfaceId());
      expect(
        screen
          .getByTestId("bundle-diff-editor-surface")
          .getAttribute("data-editor-document"),
      ).toBe("const value = 2;\n");
    });

    expect(currentRuntimeDraft()).toBe("const value = 2;\n");
    expect(state.refetchContents).toHaveBeenCalledTimes(2);
    expect(diffSurfaceState.mountCount).toBe(2);
    expect(diffSurfaceState.unmountCount).toBe(1);
  });

  it("pins the aggregate editor and draft through a pending worktree OID rollover", async () => {
    const rendered = renderBundleFile(true);
    fireEvent.click(screen.getByRole("button", { name: "Click bundle code" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Type bundle draft" }),
    );
    await waitFor(() => {
      expect(diffSurfaceState.editableNewFiles).toHaveLength(1);
    });

    const surface = screen.getByTestId("bundle-diff-editor-surface");
    const editableNewFile = diffSurfaceState.editableNewFiles[0];
    const mounts = diffSurfaceState.mountCount;
    const unmounts = diffSurfaceState.unmountCount;

    state.worktreeOid = "worktree-2";
    state.diffPending = true;
    rendered.rerender(bundleFileElement(true));

    expect(screen.getByTestId("bundle-diff-editor-surface")).toBe(surface);
    expect(surface.getAttribute("data-editor-document")).toBe(
      "const value = 2;\n",
    );
    expect(surface.getAttribute("data-editor-caret")).toBe("16");
    expect(currentRuntimeDraft()).toBe("const value = 2;\n");
    expect(diffSurfaceState.mountCount).toBe(mounts);
    expect(diffSurfaceState.unmountCount).toBe(unmounts);
    expect(diffSurfaceState.editableNewFiles).toEqual([editableNewFile]);
  });
});

function renderBundleFile(show: boolean): RenderResult {
  return render(bundleFileElement(show));
}

function bundleFileElement(show: boolean): ReactNode {
  return (
    <QueryClientProvider client={queryClient}>
      <TabHostProvider hostId="host-A">
        <EpicSessionContext.Provider value={epicSessionHandle}>
          {show ? (
            <BundleFileSection
              node={NODE}
              viewTabId={viewTabId}
              file={changedFile()}
              headSha="head-1"
              diffViewerPreferences={DEFAULT_DIFF_VIEWER_PREFERENCES}
              isActive
            />
          ) : null}
        </EpicSessionContext.Provider>
      </TabHostProvider>
    </QueryClientProvider>
  );
}

function changedFile(): GitChangedFile {
  return {
    path: "src/app.ts",
    previousPath: null,
    status: "modified",
    stage: "unstaged",
    insertions: 1,
    deletions: 1,
    isBinary: false,
    sizeBytes: 17,
    stagedOid: "index-1",
    worktreeOid: state.worktreeOid,
  };
}

function currentRuntimeState() {
  return fileEditRuntimeRegistry
    .get({
      userId: null,
      hostId: "host-A",
      workspacePath: "/work/repo",
      filePath: "src/app.ts",
    })
    ?.store.getState();
}

function currentRuntimeDraft(): string | null {
  return currentRuntimeState()?.draftContent ?? null;
}

function bundleSurfaceId(): string {
  return `git-diff:${NODE.instanceId}:bundle:src%2Fapp.ts:unstaged`;
}
