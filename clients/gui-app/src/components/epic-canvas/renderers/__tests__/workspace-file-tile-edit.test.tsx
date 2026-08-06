import "../../../../../__tests__/test-browser-apis";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  type RenderResult,
} from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import type { DiffClickToEditAdapter } from "@/components/diff/use-diff-click-to-edit";
import type { WorkspaceFileRef } from "@/stores/epics/canvas/types";
import { fileEditRuntimeRegistry } from "@/lib/workspace/file-edit-runtime-registry";

interface WorkspaceEditTestState {
  supportsWrite: boolean;
  truncated: boolean;
  readContent: string;
  readonly writeFile: Mock;
  readonly refetch: Mock;
  readonly rendererContent: Mock;
}

const state = vi.hoisted((): WorkspaceEditTestState => ({
  supportsWrite: true,
  truncated: false,
  readContent: "const value = 1;\n",
  writeFile: vi.fn(),
  refetch: vi.fn(),
  rendererContent: vi.fn(),
}));

const preloadState = vi.hoisted(() => ({
  preload: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/components/diff/diff-edit-provider-loader", () => ({
  preloadDiffEditProvider: () => preloadState.preload(),
}));

vi.mock("@/hooks/agent/use-host-reachability", () => ({
  useHostReachability: () => ({ status: "reachable", hostLabel: "Host A" }),
}));

vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => null,
}));

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostSupportsMethod: () => state.supportsWrite,
}));

vi.mock("@/hooks/workspace/use-read-file-query", () => ({
  useWorkspaceReadFile: () => ({
    data: {
      content: state.readContent,
      error: null,
      truncated: state.truncated,
    },
    isLoading: false,
    isError: false,
    error: null,
    refetch: state.refetch,
  }),
}));

vi.mock("@/hooks/workspace/use-workspace-write-file-mutation", () => ({
  useWorkspaceWriteFile: () => ({ mutateAsync: state.writeFile }),
}));

vi.mock(
  "@/components/epic-canvas/workspace-file/workspace-file-renderer",
  () => ({
    WorkspaceFileRenderer: (props: {
      readonly content: string;
      readonly editing: boolean;
      readonly editAdapter: DiffClickToEditAdapter;
    }): ReactNode => {
      state.rendererContent(props.content);
      return (
        <div>
          <button
            type="button"
            onClick={() => {
              props.editAdapter.fileOptions.onLineClick?.({
                type: "line",
                lineNumber: 1,
                lineElement: document.createElement("div"),
                numberElement: document.createElement("div"),
                numberColumn: false,
                event: new PointerEvent("click", { button: 0 }),
              });
            }}
          >
            Click source
          </button>
          <button
            type="button"
            onClick={() => {
              props.editAdapter.activateEmptyOrigin();
            }}
          >
            Activate empty
          </button>
          {props.editing ? (
            <button
              type="button"
              onClick={() => {
                const file = {
                  name: "src/index.ts",
                  contents: "const value = 2;\n",
                };
                props.editAdapter.editorOptions.onChange?.(file, undefined, {
                  changes: [],
                  file,
                });
                props.editAdapter.editorOptions.onBlur?.();
              }}
            >
              Change source
            </button>
          ) : null}
          {props.editing ? (
            <button
              type="button"
              onClick={() => {
                const file = { name: "src/index.ts", contents: "X" };
                props.editAdapter.editorOptions.onChange?.(file, undefined, {
                  changes: [],
                  file,
                });
              }}
            >
              Type without blur
            </button>
          ) : null}
        </div>
      );
    },
  }),
);

import { WorkspaceFileTile } from "../workspace-file-tile";
import { TabHostProvider } from "../../tab-host-provider";

const NODE: WorkspaceFileRef = {
  id: "workspace-file:host-A:/work/repo:src/index.ts",
  instanceId: "workspace-file-instance",
  type: "workspace-file",
  name: "index.ts",
  hostId: "host-A",
  workspacePath: "/work/repo",
  filePath: "src/index.ts",
};

describe("<WorkspaceFileTile /> editing", () => {
  beforeEach(() => {
    fileEditRuntimeRegistry.resetForTesting();
    state.supportsWrite = true;
    state.truncated = false;
    state.readContent = "const value = 1;\n";
    state.rendererContent.mockReset();
    state.writeFile.mockReset();
    state.writeFile.mockResolvedValue({
      workspacePath: "/work/repo",
      filePath: "src/index.ts",
      status: "saved",
      revision:
        "bf9b806c23729c31c50fef0960d803b70877711ddc1f0cc57181d02c9fcc5542",
    });
    state.refetch.mockReset();
    state.refetch.mockResolvedValue({
      error: null,
      data: {
        content: "const value = 1;\n",
        error: null,
        truncated: false,
      },
    });
    preloadState.preload.mockReset();
    preloadState.preload.mockImplementation(() => Promise.resolve());
  });

  afterEach(() => {
    cleanup();
    fileEditRuntimeRegistry.resetForTesting();
  });

  it("starts from the source click, writes nothing on activation, and flushes the changed draft on blur", async () => {
    renderTile();

    expect(screen.queryByRole("button", { name: "Edit file" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Click source" }));

    expect(state.writeFile).not.toHaveBeenCalled();
    fireEvent.click(
      await screen.findByRole("button", { name: "Change source" }),
    );

    await waitFor(() => {
      expect(state.writeFile).toHaveBeenCalledWith({
        workspacePath: "/work/repo",
        filePath: "src/index.ts",
        expectedRevision:
          "8de5c07db8deb3b75dedd9b5bc999669936cea181ae0033c27c4e2071a6e434d",
        content: "const value = 2;\n",
      });
    });
  });

  it("animates saving in the file header with the Agent Spinner, then settles", async () => {
    let resolveWrite!: (value: {
      readonly workspacePath: string;
      readonly filePath: string;
      readonly status: "saved";
      readonly revision: string;
    }) => void;
    state.writeFile.mockReturnValue(
      new Promise((resolve) => {
        resolveWrite = resolve;
      }),
    );
    renderTile();
    fireEvent.click(screen.getByRole("button", { name: "Click source" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Change source" }),
    );

    const savingStatus = await screen.findByRole("status");
    expect(savingStatus.getAttribute("data-status")).toBe("saving");
    expect(screen.getByTestId("file-autosave-spinner")).toBeTruthy();
    expect(
      screen.getByTestId("workspace-file-toolbar").contains(savingStatus),
    ).toBe(true);

    await act(async () => {
      resolveWrite({
        workspacePath: "/work/repo",
        filePath: "src/index.ts",
        status: "saved",
        revision: "saved-revision",
      });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByRole("status").getAttribute("data-status")).not.toBe(
        "saving",
      );
    });
    await waitFor(() => {
      expect(screen.queryByTestId("file-autosave-spinner")).toBeNull();
    });
  });

  it("does not claim ownership until the editor preload promise settles", async () => {
    let resolvePreload!: () => void;
    const preloadPromise = new Promise<void>((resolve) => {
      resolvePreload = resolve;
    });
    preloadState.preload.mockReturnValue(preloadPromise);

    renderTile();
    fireEvent.click(screen.getByRole("button", { name: "Click source" }));

    await waitFor(() => {
      expect(preloadState.preload).toHaveBeenCalled();
    });
    expect(screen.queryByRole("button", { name: "Change source" })).toBeNull();
    expect(
      fileEditRuntimeRegistry
        .get({
          userId: null,
          hostId: "host-A",
          workspacePath: "/work/repo",
          filePath: "src/index.ts",
        })
        ?.store.getState().ownerSurfaceId ?? null,
    ).not.toBe(`view-1:workspace-file:${NODE.instanceId}`);

    resolvePreload();
    await preloadPromise;

    expect(
      await screen.findByRole("button", { name: "Change source" }),
    ).toBeTruthy();
  });

  it("keeps the same source surface read-only for an older host", async () => {
    state.supportsWrite = false;
    renderTile();

    fireEvent.click(screen.getByRole("button", { name: "Click source" }));
    await Promise.resolve();

    expect(screen.queryByRole("button", { name: "Change source" })).toBeNull();
    expect(state.writeFile).not.toHaveBeenCalled();
  });

  it("does not attach a recovery runtime to a truncated preview", async () => {
    state.truncated = true;
    renderTile();

    fireEvent.click(screen.getByRole("button", { name: "Click source" }));
    await Promise.resolve();

    expect(screen.queryByRole("button", { name: "Change source" })).toBeNull();
    expect(currentRuntimeState()).toBeUndefined();
  });

  it("retains a conflicting draft and offers disk, mine, and copy recovery actions", async () => {
    state.writeFile.mockResolvedValue({
      workspacePath: "/work/repo",
      filePath: "src/index.ts",
      status: "conflict",
      currentRevision: "external-revision",
      error: "The file changed on disk.",
    });
    renderTile();
    fireEvent.click(screen.getByRole("button", { name: "Click source" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Change source" }),
    );

    const conflictStatus = await screen.findByRole("button", {
      name: "Conflict",
    });
    expect(
      screen.getByTestId("workspace-file-toolbar").contains(conflictStatus),
    ).toBe(true);
    fireEvent.click(conflictStatus);
    expect(await screen.findByText("The file changed on disk.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Keep mine" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy my draft" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Use disk" }));

    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: "Change source" }),
      ).toBeNull();
    });
  });

  it("keeps the conflict draft when the destructive disk refresh fails or is truncated", async () => {
    state.writeFile.mockResolvedValue({
      workspacePath: "/work/repo",
      filePath: "src/index.ts",
      status: "conflict",
      currentRevision: "external-revision",
      error: "The file changed on disk.",
    });
    state.refetch
      .mockResolvedValueOnce({
        data: undefined,
        error: new Error("disk read offline"),
      })
      .mockResolvedValueOnce({
        data: { content: "partial", error: null, truncated: true },
        error: null,
      });
    renderTile();
    fireEvent.click(screen.getByRole("button", { name: "Click source" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Change source" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Conflict" }));

    fireEvent.click(screen.getByRole("button", { name: "Use disk" }));
    expect(await screen.findByText("disk read offline")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Change source" })).toBeTruthy();
    expect(currentRuntimeState()).toMatchObject({
      draftContent: "const value = 2;\n",
      status: "conflict",
      isDirty: true,
    });

    fireEvent.click(screen.getByRole("button", { name: "Use disk" }));
    expect(
      await screen.findByText(/too large to load completely/),
    ).toBeTruthy();
    expect(currentRuntimeState()).toMatchObject({
      draftContent: "const value = 2;\n",
      status: "conflict",
      isDirty: true,
    });
  });

  it("seeds the editor with raw CRLF content instead of a normalized copy", async () => {
    state.readContent = "const value = 1;\r\nconst other = 2;\r\n";
    renderTile();

    await waitFor(() => {
      expect(state.rendererContent).toHaveBeenCalledWith(state.readContent);
    });
  });

  describe("activating from an empty file", () => {
    beforeEach(() => {
      state.readContent = "";
    });

    it("activates via activateEmptyOrigin, types the first character, and autosaves it - same session/write path as a line-click activation", async () => {
      renderTile();

      expect(
        screen.queryByRole("button", { name: "Change source" }),
      ).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Activate empty" }));

      expect(state.writeFile).not.toHaveBeenCalled();
      fireEvent.click(
        await screen.findByRole("button", { name: "Change source" }),
      );

      await waitFor(() => {
        expect(state.writeFile).toHaveBeenCalledWith({
          workspacePath: "/work/repo",
          filePath: "src/index.ts",
          expectedRevision:
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
          content: "const value = 2;\n",
        });
      });
    });

    it("retains an unsaved draft typed from empty across an unmount/remount of the tile", async () => {
      // The runtime's autosave debounce (FILE_EDIT_AUTOSAVE_DELAY_MS, real
      // timers - this file doesn't fake them) would otherwise race this
      // test's own real-clock `waitFor`/unmount/remount sequence: a write
      // that completes mid-test would clear `isDirty` out from under the
      // very assertions proving the draft survives untouched.
      state.writeFile.mockReturnValue(new Promise(() => undefined));
      const { unmount } = renderTile();
      fireEvent.click(screen.getByRole("button", { name: "Activate empty" }));
      fireEvent.click(
        await screen.findByRole("button", { name: "Type without blur" }),
      );

      await waitFor(() => {
        expect(currentRuntimeState()).toMatchObject({
          draftContent: "X",
          isDirty: true,
        });
      });
      expect(state.writeFile).not.toHaveBeenCalled();

      unmount();
      // The runtime is keyed by file identity, not by tile lifetime - a
      // dirty draft is never disposed just because its surface unmounted
      // (`FileEditRuntime.canDispose` refuses while `isDirty`).
      expect(currentRuntimeState()).toMatchObject({
        draftContent: "X",
        isDirty: true,
      });

      renderTile();
      await waitFor(() => {
        expect(state.rendererContent).toHaveBeenCalledWith("");
      });
      expect(currentRuntimeState()).toMatchObject({
        draftContent: "X",
        isDirty: true,
      });
    });
  });
});

function currentRuntimeState() {
  return fileEditRuntimeRegistry
    .get({
      userId: null,
      hostId: "host-A",
      workspacePath: "/work/repo",
      filePath: "src/index.ts",
    })
    ?.store.getState();
}

function renderTile(): RenderResult {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <TabHostProvider hostId="host-A">
        <WorkspaceFileTile node={NODE} viewTabId="view-1" isActive />
      </TabHostProvider>
    </QueryClientProvider>,
  );
}
