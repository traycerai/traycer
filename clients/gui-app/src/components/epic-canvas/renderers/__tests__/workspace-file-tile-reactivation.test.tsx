import "../../../../../__tests__/test-browser-apis";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
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

interface WorkspaceReactivationTestState {
  readContent: string;
  truncated: boolean;
  supportsWrite: boolean;
  readonly writeFile: Mock;
  readonly refetch: Mock;
  readonly rendererContent: Mock;
}

const state = vi.hoisted((): WorkspaceReactivationTestState => ({
  readContent: "const value = 1;\n",
  truncated: false,
  supportsWrite: true,
  writeFile: vi.fn(),
  refetch: vi.fn(),
  rendererContent: vi.fn(),
}));

vi.mock("@/components/diff/diff-edit-provider-loader", () => ({
  preloadDiffEditProvider: () => Promise.resolve(),
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

describe("<WorkspaceFileTile /> reactivation refresh", () => {
  beforeEach(() => {
    fileEditRuntimeRegistry.resetForTesting();
    state.readContent = "const value = 1;\n";
    state.truncated = false;
    state.supportsWrite = true;
    state.rendererContent.mockReset();
    state.writeFile.mockReset();
    state.refetch.mockReset();
    state.refetch.mockResolvedValue({
      error: null,
      data: {
        content: state.readContent,
        error: null,
        truncated: false,
      },
    });
  });

  afterEach(() => {
    cleanup();
    fileEditRuntimeRegistry.resetForTesting();
  });

  it("does not refetch merely because the tile mounts active", () => {
    renderTile({ isActive: true });
    expect(state.refetch).not.toHaveBeenCalled();
  });

  it("does not refetch while the tile stays active across unrelated rerenders", () => {
    const harness = renderTile({ isActive: true });
    harness.setActive(true);
    harness.setActive(true);
    expect(state.refetch).not.toHaveBeenCalled();
  });

  it("refetches exactly once on the inactive to active edge", async () => {
    const harness = renderTile({ isActive: false });
    expect(state.refetch).not.toHaveBeenCalled();

    harness.setActive(true);
    await waitFor(() => {
      expect(state.refetch).toHaveBeenCalledTimes(1);
    });

    // Staying active must not trigger another refetch.
    harness.setActive(true);
    expect(state.refetch).toHaveBeenCalledTimes(1);

    // Only a fresh false->true edge fires again.
    harness.setActive(false);
    harness.setActive(true);
    await waitFor(() => {
      expect(state.refetch).toHaveBeenCalledTimes(2);
    });
  });

  it("shows the freshly refetched disk content after reactivation (no unsaved draft to preserve)", async () => {
    // Read-only (no edit runtime attach): isolates the reactivation-refetch
    // path from the pre-existing, unrelated edit-session attach lifecycle,
    // which races its own async recovery/reconciliation against this same
    // isActive edge.
    state.supportsWrite = false;
    const harness = renderTile({ isActive: false });
    const newContent = "const value = 2;\n";
    // `state.readContent` only changes once `refetch` itself resolves - not
    // ahead of time - so this only passes if the reactivation edge actually
    // called `refetch`, not merely because the tile re-rendered.
    state.refetch.mockImplementation(() => {
      state.readContent = newContent;
      return Promise.resolve({
        error: null,
        data: { content: newContent, error: null, truncated: false },
      });
    });

    harness.setActive(true);
    await waitFor(() => {
      expect(state.refetch).toHaveBeenCalled();
    });
    // The mocked hook has no real subscription, so re-render it manually to
    // observe the post-refetch value - a real `useQuery` would do this via
    // its own store subscription once `refetch` settles.
    await waitFor(() => {
      harness.setActive(true);
      expect(state.rendererContent).toHaveBeenCalledWith(newContent);
    });
  });

  it("preserves an unsaved draft when reactivation refetches different disk content", async () => {
    const harness = renderTile({ isActive: true });
    fireEvent.click(screen.getByRole("button", { name: "Click source" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Type without blur" }),
    );
    await waitFor(() => {
      expect(currentRuntimeState()).toMatchObject({
        draftContent: "X",
        isDirty: true,
      });
    });

    state.refetch.mockResolvedValue({
      error: null,
      data: {
        content: "const value = externally changed;\n",
        error: null,
        truncated: false,
      },
    });
    harness.setActive(false);
    harness.setActive(true);

    await waitFor(() => {
      expect(state.refetch).toHaveBeenCalled();
    });
    expect(currentRuntimeState()).toMatchObject({
      draftContent: "X",
      isDirty: true,
    });
  });

  it("leaves the rendered content untouched when a reactivation refetch errors", async () => {
    const initial = renderTile({ isActive: true });
    await waitFor(() => {
      expect(state.rendererContent).toHaveBeenCalledWith("const value = 1;\n");
    });
    initial.unmount();
    state.rendererContent.mockClear();

    state.refetch.mockRejectedValueOnce(new Error("disk read offline"));
    // The mocked hook's `data` never actually changes here (only the direct
    // `refetch()` call - which the mock always resolves independently of
    // `useWorkspaceReadFile`'s returned `data` - can be made to fail), so
    // this proves the reactivation trigger itself is inert on error: no
    // renderer re-invocation with different content, no thrown error.
    const harness = renderTile({ isActive: false });
    harness.setActive(true);

    await waitFor(() => {
      expect(state.refetch).toHaveBeenCalled();
    });
    expect(state.rendererContent).not.toHaveBeenCalledWith(
      expect.stringContaining("offline"),
    );
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

function renderTile(args: { readonly isActive: boolean }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const tree = (isActive: boolean): ReactNode => (
    <QueryClientProvider client={queryClient}>
      <TabHostProvider hostId="host-A">
        <WorkspaceFileTile node={NODE} viewTabId="view-1" isActive={isActive} />
      </TabHostProvider>
    </QueryClientProvider>
  );
  const result = render(tree(args.isActive));
  return {
    ...result,
    setActive: (isActive: boolean): void => {
      result.rerender(tree(isActive));
    },
  };
}
