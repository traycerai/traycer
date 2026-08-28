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
  DRIFT_RETRY_BASE_DELAY_MS,
  useGitDiffEditing,
  type EditableDiffFiles,
  type GitDiffEditingModel,
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

const EDIT_IDENTITY = {
  userId: null,
  hostId: "host-A",
  workspacePath: "/work/repo",
  filePath: "src/app.ts",
};

interface GitContentsRefetchSuccess {
  readonly error: null;
  readonly data: {
    readonly runningDir: string;
    readonly filePath: string;
    readonly oldFile: { readonly name: string; readonly contents: string };
    readonly newFile: { readonly name: string; readonly contents: string };
    readonly worktreeFile: { readonly name: string; readonly contents: string };
    readonly error: null;
  };
}

function contentsSuccess(): GitContentsRefetchSuccess {
  return {
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
  };
}

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function createDeferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolvePromise = (value: T): void => {
    void value;
  };
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value) => {
      resolvePromise(value);
    },
  };
}

async function activateEditing(result: {
  readonly current: GitDiffEditingModel;
}): Promise<void> {
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
    expect(result.current.active).toBe(true);
    expect(result.current.hydrated).toBe(true);
    expect(result.current.editableFiles).not.toBeNull();
  });
}

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
      Promise.resolve(contentsSuccess()),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    state.worktreeContent = "const value = 1;\n";
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
    await activateEditing(result);

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

  it("keeps editableFiles identity stable when comparison identity is acknowledged after refetch", async () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    let comparisonIdentity = "cmp-1";
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
          currentComparisonIdentity: comparisonIdentity,
          resumeDetachedDraft: false,
        }),
      { wrapper },
    );

    await activateEditing(result);

    const initial = result.current.editableFiles as EditableDiffFiles;
    expect(state.refetchContents).toHaveBeenCalledTimes(1);

    comparisonIdentity = "cmp-2";
    act(() => {
      rerender();
    });

    await waitFor(() => {
      expect(state.refetchContents).toHaveBeenCalledTimes(2);
    });
    await flushMicrotasks();

    expect(result.current.editableFiles).toBe(initial);
    expect(result.current.editableFiles?.newFile).toBe(initial.newFile);
    expect(result.current.editableFiles?.oldFile).toBe(initial.oldFile);
  });

  it("refetches and marks stale when identity returns to activation after a later identity was acknowledged against a new baseline", async () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    let comparisonIdentity = "cmp-1";
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
          currentComparisonIdentity: comparisonIdentity,
          resumeDetachedDraft: false,
        }),
      { wrapper },
    );

    await activateEditing(result);
    expect(state.refetchContents).toHaveBeenCalledTimes(1);
    expect(result.current.stale).toBe(false);

    const runtime = fileEditRuntimeRegistry.get(EDIT_IDENTITY);
    expect(runtime).not.toBeNull();
    const savedB = "const value = saved-B;\n";
    act(() => {
      runtime?.store.setState({
        baselineContent: savedB,
        lastSavedAt: Date.now(),
      });
    });

    state.worktreeContent = savedB;
    comparisonIdentity = "cmp-2";
    act(() => {
      rerender();
    });
    await waitFor(() => {
      expect(state.refetchContents).toHaveBeenCalledTimes(2);
    });
    await flushMicrotasks();
    expect(result.current.stale).toBe(false);

    state.worktreeContent = "const value = 1;\n";
    comparisonIdentity = "cmp-1";
    act(() => {
      rerender();
    });
    await waitFor(() => {
      expect(state.refetchContents).toHaveBeenCalledTimes(3);
    });
    await flushMicrotasks();
    expect(result.current.stale).toBe(true);
  });

  it("refetches and marks stale when identity returns to A while a B check is still in flight", async () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    let comparisonIdentity = "cmp-1";
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
          currentComparisonIdentity: comparisonIdentity,
          resumeDetachedDraft: false,
        }),
      { wrapper },
    );

    await activateEditing(result);
    expect(state.refetchContents).toHaveBeenCalledTimes(1);
    expect(result.current.stale).toBe(false);

    const runtime = fileEditRuntimeRegistry.get(EDIT_IDENTITY);
    expect(runtime).not.toBeNull();
    const savedB = "const value = saved-B;\n";
    act(() => {
      runtime?.store.setState({
        baselineContent: savedB,
        lastSavedAt: Date.now(),
      });
    });

    const pendingB = createDeferred<GitContentsRefetchSuccess>();
    let serveDeferredB = false;
    state.refetchContents.mockImplementation(() => {
      if (serveDeferredB) {
        serveDeferredB = false;
        return pendingB.promise;
      }
      return Promise.resolve(contentsSuccess());
    });

    state.worktreeContent = savedB;
    serveDeferredB = true;
    comparisonIdentity = "cmp-2";
    act(() => {
      rerender();
    });
    await flushMicrotasks();
    expect(state.refetchContents).toHaveBeenCalledTimes(2);

    state.worktreeContent = "const value = 1;\n";
    comparisonIdentity = "cmp-1";
    act(() => {
      rerender();
    });
    await waitFor(() => {
      expect(state.refetchContents).toHaveBeenCalledTimes(3);
    });
    await flushMicrotasks();
    expect(result.current.stale).toBe(true);

    await act(async () => {
      pendingB.resolve({
        error: null,
        data: {
          runningDir: "/work/repo",
          filePath: "src/app.ts",
          oldFile: { name: "src/app.ts", contents: "const value = 0;\n" },
          newFile: { name: "src/app.ts", contents: savedB },
          worktreeFile: { name: "src/app.ts", contents: savedB },
          error: null,
        },
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.stale).toBe(true);
  });

  it("keeps a newer identity single-flight when an older retry timer fires", async () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    let comparisonIdentity = "cmp-1";
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
          currentComparisonIdentity: comparisonIdentity,
          resumeDetachedDraft: false,
        }),
      { wrapper },
    );

    await activateEditing(result);
    expect(state.refetchContents).toHaveBeenCalledTimes(1);

    let failNext = false;
    const pendingB = createDeferred<GitContentsRefetchSuccess>();
    let holdB = false;
    state.refetchContents.mockImplementation(() => {
      if (failNext) {
        return Promise.resolve({
          error: { message: "unreachable" },
          data: undefined,
        });
      }
      if (holdB) return pendingB.promise;
      return Promise.resolve(contentsSuccess());
    });

    vi.useFakeTimers();
    // Emulate a retry callback already queued while identity supersession
    // races its cleanup, so the callback's own identity guard is exercised.
    const clearTimeoutSpy = vi
      .spyOn(window, "clearTimeout")
      .mockImplementation(() => undefined);
    onTestFinished(() => {
      clearTimeoutSpy.mockRestore();
    });
    failNext = true;
    comparisonIdentity = "cmp-A";
    act(() => {
      rerender();
    });
    await flushMicrotasks();
    expect(state.refetchContents).toHaveBeenCalledTimes(2);

    failNext = false;
    holdB = true;
    comparisonIdentity = "cmp-B";
    act(() => {
      rerender();
    });
    await flushMicrotasks();
    expect(state.refetchContents).toHaveBeenCalledTimes(3);

    act(() => {
      vi.advanceTimersByTime(DRIFT_RETRY_BASE_DELAY_MS);
    });
    expect(state.refetchContents).toHaveBeenCalledTimes(3);

    const resolvedB = contentsSuccess();
    await act(async () => {
      pendingB.resolve(resolvedB);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.stale).toBe(false);
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

  it("keeps a conflicting retained draft out of the structural diff model, and restores it on keepMine", async () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    // Simulates reactivating a runtime that survived an external reset while
    // it held an unsaved draft - e.g. a recovered draft whose disk baseline
    // no longer matches (`FileEditRuntime.restore` sets `status: "conflict"`
    // in exactly this case). The draft has trailing lines the FRESH patch's
    // hunks know nothing about, matching the real "trailing context
    // mismatch" crash this seed-capture bug produced.
    const identity = {
      userId: null,
      hostId: "host-A",
      workspacePath: "/work/repo",
      filePath: "src/app.ts",
    };
    const runtime = fileEditRuntimeRegistry.getOrCreate(identity, {
      content: "const value = 1;\n",
      revision: "rev-clean",
    });
    await runtime.whenRecovered();
    const conflictingDraft =
      "const value = 1;\nextra line one\nextra line two\n";
    runtime.store.setState({
      baselineContent: "const value = 1;\n",
      baselineRevision: "rev-stale",
      draftContent: conflictingDraft,
      contentRevision: 3,
      status: "conflict",
      isDirty: true,
      conflict: {
        currentRevision: "rev-reset",
        diskContent: state.worktreeContent,
        error: "The file changed on disk while an unsaved draft was retained.",
      },
    });

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
      expect(result.current.active).toBe(true);
      expect(result.current.hydrated).toBe(true);
      expect(result.current.editableFiles).not.toBeNull();
    });

    // The structural diff model must use the FRESH content (matching
    // `hydration.pinnedDiff`'s hunks), never the conflicting retained draft -
    // pairing fresh hunks with the draft's extra trailing lines is exactly
    // what crashed the Diffs renderer.
    expect(result.current.editableFiles?.newFile.contents).toBe(
      state.worktreeContent,
    );
    // The draft itself must survive untouched in the runtime, not be
    // silently discarded.
    expect(result.current.state?.status).toBe("conflict");
    expect(result.current.state?.draftContent).toBe(conflictingDraft);

    // Resolving "keep mine" must restore the preserved draft into the
    // editable model, not leave it stuck on the fresh content.
    await act(async () => {
      result.current.keepMine();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(result.current.state?.status).not.toBe("conflict");
    });
    expect(result.current.editableFiles?.newFile.contents).toBe(
      conflictingDraft,
    );
  });
});
