/**
 * Independent coverage for the `editableFiles` memo in `useGitDiffEditing`.
 *
 * `DiffContentPrimitive` keys its synchronous hydration on the identity of
 * `editSession.oldFile` / `editSession.newFile`. If either got a new object on
 * every draft store update, the primitive would re-derive a fresh
 * `FileDiffMetadata` every keystroke - not the original partial-swap bug, but
 * still a destructive re-attach. This suite drives the real hook (host queries
 * mocked) and asserts the exported `editableFiles` references stay stable
 * across draft updates.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
  type Mock,
} from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode, type ReactNode } from "react";
import type {
  GitChangedFile,
  GitGetFileDiffResponse,
} from "@traycer/protocol/host";
import { fileEditRuntimeRegistry } from "@/lib/workspace/file-edit-runtime-registry";
import {
  useGitDiffEditing,
  type EditableDiffFiles,
} from "@/components/epic-canvas/git-diff/git-diff-editing";

const state = vi.hoisted(() => ({
  refetchContents: vi.fn() as Mock,
  worktreeContent: "const value = 1;\n",
}));

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostSupportsMethod: () => true,
}));

vi.mock("@/components/diff/diff-edit-provider-loader", () => ({
  preloadDiffEditProvider: () => Promise.resolve(),
}));

vi.mock("@/hooks/git/use-git-get-file-contents-query", () => ({
  useGitGetFileContentsQuery: () => ({
    isFetching: false,
    refetch: state.refetchContents,
  }),
}));

vi.mock("@/hooks/workspace/use-workspace-write-file-mutation", () => ({
  useWorkspaceWriteFile: () => ({
    mutateAsync: vi.fn(() =>
      Promise.resolve({
        workspacePath: "/work/repo",
        filePath: "src/app.ts",
        status: "saved" as const,
        revision: "rev-1",
      }),
    ),
  }),
}));

vi.mock("@/stores/auth/auth-store", () => ({
  useAuthStore: (
    selector: (s: { contextMetadata: { userId: null } }) => unknown,
  ) => selector({ contextMetadata: { userId: null } }),
}));

const FILE: GitChangedFile = {
  path: "src/app.ts",
  previousPath: null,
  status: "modified",
  stage: "unstaged",
  insertions: 1,
  deletions: 1,
  isBinary: false,
  sizeBytes: 17,
  stagedOid: "index-1",
  worktreeOid: "worktree-1",
};

const CURRENT_DIFF: GitGetFileDiffResponse = {
  filePath: "src/app.ts",
  headSha: "head-1",
  stagedOid: "index-1",
  worktreeOid: "worktree-1",
  patch: "diff --git a/src/app.ts b/src/app.ts\n",
  isTruncated: false,
  truncatedAfterBytes: null,
  isBinary: false,
};

const SURFACE_ID = "surface-edit-stability";

describe("useGitDiffEditing editableFiles stability", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    fileEditRuntimeRegistry.resetForTesting();
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    state.worktreeContent = "const value = 1;\n";
    state.refetchContents.mockReset();
    state.refetchContents.mockImplementation(() =>
      Promise.resolve({
        error: null,
        data: {
          runningDir: "/work/repo",
          filePath: "src/app.ts",
          oldFile: { name: "src/app.ts", contents: "const value = 0;\n" },
          newFile: {
            name: "src/app.ts",
            contents: state.worktreeContent,
          },
          worktreeFile: {
            name: "src/app.ts",
            contents: state.worktreeContent,
          },
          error: null,
        },
      }),
    );
  });

  afterEach(() => {
    cleanup();
    fileEditRuntimeRegistry.resetForTesting();
    queryClient.clear();
  });

  it("keeps editableFiles.oldFile/newFile identity stable across draft keystrokes", async () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const { result, rerender } = renderHook(
      () =>
        useGitDiffEditing({
          client: null,
          hostId: "host-A",
          runningDir: "/work/repo",
          file: FILE,
          surfaceId: SURFACE_ID,
          isActive: true,
          interactionEnabled: true,
          currentDiff: CURRENT_DIFF,
          currentComparisonIdentity: "cmp-1",
          resumeDetachedDraft: false,
        }),
      { wrapper },
    );

    expect(result.current.canOfferEdit).toBe(true);
    expect(result.current.editableFiles).toBeNull();

    const lineElement = document.createElement("div");
    lineElement.append("const value = 1;");
    document.body.append(lineElement);
    onTestFinished(() => {
      lineElement.remove();
    });

    await act(async () => {
      result.current.editAdapter.diffOptions.onLineClick?.({
        type: "diff-line",
        annotationSide: "additions",
        lineType: "change-addition",
        lineNumber: 1,
        lineElement,
        numberElement: document.createElement("div"),
        numberColumn: false,
        event: new PointerEvent("click", { button: 0, clientX: 4 }),
      });
      // onActivate is fire-and-forget; flush its promise chain.
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(result.current.active).toBe(true);
      expect(result.current.hydrated).toBe(true);
      expect(result.current.editableFiles).not.toBeNull();
    });

    const initial = result.current.editableFiles as EditableDiffFiles;
    expect(initial.oldFile?.contents).toBe("const value = 0;\n");
    expect(initial.newFile.contents).toBe("const value = 1;\n");

    // Simulate keystrokes: the editor's onChange path writes the draft store.
    // editableFiles must keep the same object identities so DiffContentPrimitive
    // does not re-run hydrateFileDiffForEdit on every character.
    const draftOnce = {
      name: "src/app.ts",
      contents: "const value = 12;\n",
    };
    await act(async () => {
      result.current.editAdapter.editorOptions.onChange?.(
        draftOnce,
        undefined,
        {
          changes: [],
          file: draftOnce,
        },
      );
      await Promise.resolve();
    });
    expect(result.current.editableFiles).toBe(initial);
    expect(result.current.editableFiles?.newFile).toBe(initial.newFile);
    expect(result.current.editableFiles?.oldFile).toBe(initial.oldFile);

    const draftTwice = {
      name: "src/app.ts",
      contents: "const value = 123;\n",
    };
    await act(async () => {
      result.current.editAdapter.editorOptions.onChange?.(
        draftTwice,
        undefined,
        {
          changes: [],
          file: draftTwice,
        },
      );
      await Promise.resolve();
    });
    expect(result.current.editableFiles).toBe(initial);
    expect(result.current.state?.draftContent).toBe("const value = 123;\n");
    // Snapshot at memo time stays on baseline; live draft lives in the runtime.
    expect(result.current.editableFiles?.newFile.contents).toBe(
      "const value = 1;\n",
    );

    // A re-render for reasons unrelated to a real hydration change - a
    // discarded render, React re-invoking the component body - must not
    // read the store a second time and produce a different object: the
    // `hydration` identity this cycle is keyed on has not changed, so the
    // captured seed must stay exactly as it was.
    act(() => {
      rerender();
    });
    expect(result.current.editableFiles).toBe(initial);
    expect(result.current.editableFiles?.newFile).toBe(initial.newFile);
  });

  it("captures the same seed under Strict Mode's double-invoked render", async () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <StrictMode>
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
      </StrictMode>
    );

    const { result } = renderHook(
      () =>
        useGitDiffEditing({
          client: null,
          hostId: "host-A",
          runningDir: "/work/repo",
          file: FILE,
          surfaceId: SURFACE_ID,
          isActive: true,
          interactionEnabled: true,
          currentDiff: CURRENT_DIFF,
          currentComparisonIdentity: "cmp-1",
          resumeDetachedDraft: false,
        }),
      { wrapper },
    );

    const lineElement = document.createElement("div");
    lineElement.append("const value = 1;");
    document.body.append(lineElement);
    onTestFinished(() => {
      lineElement.remove();
    });

    await act(async () => {
      result.current.editAdapter.diffOptions.onLineClick?.({
        type: "diff-line",
        annotationSide: "additions",
        lineType: "change-addition",
        lineNumber: 1,
        lineElement,
        numberElement: document.createElement("div"),
        numberColumn: false,
        event: new PointerEvent("click", { button: 0, clientX: 4 }),
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(result.current.editableFiles).not.toBeNull();
    });
    const initial = result.current.editableFiles as EditableDiffFiles;
    expect(initial.newFile.contents).toBe("const value = 1;\n");

    const draft = { name: "src/app.ts", contents: "const value = 12;\n" };
    await act(async () => {
      result.current.editAdapter.editorOptions.onChange?.(draft, undefined, {
        changes: [],
        file: draft,
      });
      await Promise.resolve();
    });

    // Strict Mode double-invokes the component body on every render, giving
    // the render-phase capture two chances per commit to read the store -
    // both must land on the same seed, not one from before and one from
    // after the keystroke.
    expect(result.current.editableFiles).toBe(initial);
    expect(result.current.editableFiles?.newFile.contents).toBe(
      "const value = 1;\n",
    );
  });
});
