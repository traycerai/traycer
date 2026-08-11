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

interface ReadValidityTestState {
  data:
    { content: string; error: string | null; truncated: boolean } | undefined;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  readonly rendererContent: Mock;
}

const state = vi.hoisted((): ReadValidityTestState => ({
  data: undefined,
  isLoading: false,
  isError: false,
  error: null,
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
  useHostSupportsMethod: () => true,
}));

vi.mock("@/hooks/workspace/use-read-file-query", () => ({
  useWorkspaceReadFile: () => ({
    data: state.data,
    isLoading: state.isLoading,
    isError: state.isError,
    error: state.error,
    refetch: vi.fn(),
  }),
}));

vi.mock("@/hooks/workspace/use-workspace-write-file-mutation", () => ({
  useWorkspaceWriteFile: () => ({ mutateAsync: vi.fn() }),
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

describe("<WorkspaceFileTile /> read validity", () => {
  beforeEach(() => {
    fileEditRuntimeRegistry.resetForTesting();
    state.data = undefined;
    state.isLoading = false;
    state.isError = false;
    state.error = null;
    state.rendererContent.mockReset();
  });

  afterEach(() => {
    cleanup();
    fileEditRuntimeRegistry.resetForTesting();
  });

  it("shows the error surface, no affordance, and never attaches editing for an initial payload error with an empty body", () => {
    state.data = {
      content: "",
      error: "Could not read /Users/me/private/api-key.txt",
      truncated: false,
    };
    renderTile();

    expect(
      screen.getByText("Could not read /Users/me/private/api-key.txt"),
    ).toBeTruthy();
    // The empty-file affordance/editable session is the real
    // `WorkspaceFileRenderer` - it never mounts (this mock is never called)
    // when the current payload is an error, regardless of its empty body.
    expect(state.rendererContent).not.toHaveBeenCalled();
    expect(currentRuntimeState()).toBeUndefined();
  });

  it("keeps an already-active editor visible when a background refetch fails at the transport level", async () => {
    state.data = {
      content: "const value = 1;\n",
      error: null,
      truncated: false,
    };
    const harness = renderTile();
    fireEvent.click(screen.getByRole("button", { name: "Click source" }));
    await waitFor(() => {
      expect(currentRuntimeState()?.ownerSurfaceId).not.toBeNull();
    });
    state.rendererContent.mockClear();

    // TanStack retains the last successful payload on a failed background
    // refetch - `data` stays the same good response, only `isError`/`error`
    // flip. This must not be conflated with a payload error.
    state.isError = true;
    state.error = new Error("network unreachable");
    harness.rerender();

    expect(
      screen.getByRole("button", { name: "Type without blur" }),
    ).toBeTruthy();
    expect(state.rendererContent).toHaveBeenCalledWith("const value = 1;\n");
    expect(screen.queryByText("network unreachable")).toBeNull();
  });

  it("preserves a dirty draft and its actionable status when a background refetch returns a payload error", async () => {
    state.data = {
      content: "const value = 1;\n",
      error: null,
      truncated: false,
    };
    const harness = renderTile();
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
    state.rendererContent.mockClear();

    // A refetch that succeeds at the transport level but reports a payload
    // error (e.g. the file became unreadable mid-edit).
    state.data = {
      content: "",
      error: "Could not read /work/repo/src/index.ts",
      truncated: false,
    };
    harness.rerender();

    // Draft is untouched - never replaced by the error screen.
    expect(state.rendererContent).toHaveBeenCalledWith("X");
    expect(currentRuntimeState()).toMatchObject({
      draftContent: "X",
      isDirty: true,
    });
    expect(
      screen.queryByText("Could not read /work/repo/src/index.ts"),
    ).toBeNull();
    // The status pill stays visible (actionable - still reflects the
    // unsaved draft the user can act on) instead of being torn down.
    expect(screen.getByTestId("file-autosave-status")).toBeTruthy();
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

function renderTile() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <TabHostProvider hostId="host-A">
        <WorkspaceFileTile node={NODE} viewTabId="view-1" isActive />
      </TabHostProvider>
    </QueryClientProvider>,
  );
  return {
    ...result,
    rerender: (): void => {
      result.rerender(
        <QueryClientProvider client={queryClient}>
          <TabHostProvider hostId="host-A">
            <WorkspaceFileTile node={NODE} viewTabId="view-1" isActive />
          </TabHostProvider>
        </QueryClientProvider>,
      );
    },
  };
}
