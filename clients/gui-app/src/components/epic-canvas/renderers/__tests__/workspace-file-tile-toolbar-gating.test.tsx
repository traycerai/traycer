import "../../../../../__tests__/test-browser-apis";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceFileRef } from "@/stores/epics/canvas/types";
import { fileEditRuntimeRegistry } from "@/lib/workspace/file-edit-runtime-registry";

interface ToolbarGatingTestState {
  data:
    | { content: string | null; error: string | null; truncated: boolean }
    | undefined;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
}

const state = vi.hoisted((): ToolbarGatingTestState => ({
  data: undefined,
  isLoading: false,
  isError: false,
  error: null,
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

// Write support stays off throughout this suite - it keeps `editing` false
// unconditionally, so every case below isolates the read-state gate
// (`!query.isLoading && renderedContent !== null`) from the edit-session gate.
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSchemaVersion: () => null,
  useHostSupportsMethod: () => false,
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
    WorkspaceFileRenderer: (): ReactNode => (
      <div data-testid="workspace-file-source" />
    ),
  }),
);

import { WorkspaceFileTile } from "../workspace-file-tile";
import { TabHostProvider } from "../../tab-host-provider";

// Markdown file: the toolbar only renders the view-mode toggle for a
// markdown file, so this fixture is needed to exercise that gate alongside
// the truncated notice and the word-wrap settings gate.
const NODE: WorkspaceFileRef = {
  id: "workspace-file:host-A:/work/repo:docs/notes.md",
  instanceId: "workspace-file-instance",
  type: "workspace-file",
  name: "notes.md",
  hostId: "host-A",
  workspacePath: "/work/repo",
  filePath: "docs/notes.md",
};

describe("<WorkspaceFileTile /> toolbar controls gating", () => {
  beforeEach(() => {
    fileEditRuntimeRegistry.resetForTesting();
    state.data = undefined;
    state.isLoading = false;
    state.isError = false;
    state.error = null;
  });

  afterEach(() => {
    cleanup();
    fileEditRuntimeRegistry.resetForTesting();
  });

  it("hides the truncated notice and the markdown/settings controls for a binary read with null content, even when truncated is true", () => {
    state.data = {
      content: null,
      error: "Binary files cannot be previewed.",
      truncated: true,
    };
    renderTile();

    expectControlsHidden();
  });

  it("hides every control while the read is loading", () => {
    state.isLoading = true;
    state.data = undefined;
    renderTile();

    expectControlsHidden();
  });

  it("hides every control on a settled transport error with no retained content", () => {
    state.isLoading = false;
    state.isError = true;
    state.error = new Error("host unreachable");
    state.data = undefined;
    renderTile();

    expectControlsHidden();
  });

  it("keeps the markdown/settings controls for a valid empty-string read", () => {
    state.data = { content: "", error: null, truncated: false };
    renderTile();

    expect(screen.queryByText("Preview truncated")).toBeNull();
    expectControlsVisible();
  });

  it("keeps the truncated notice alongside the markdown/settings controls for a valid truncated read", () => {
    state.data = {
      content: "# Notes\n\nsome text",
      error: null,
      truncated: true,
    };
    renderTile();

    expect(screen.getByText("Preview truncated")).toBeTruthy();
    expectControlsVisible();
  });

  it("retains the controls when a background refetch fails at the transport level but the last good content is kept", () => {
    state.data = {
      content: "# Notes\n\nsome text",
      error: null,
      truncated: false,
    };
    const harness = renderTile();
    expectControlsVisible();

    // TanStack retains the last successful payload on a failed background
    // refetch - only `isError`/`error` flip, `data` stays the same.
    state.isError = true;
    state.error = new Error("network unreachable");
    harness.rerender();

    expect(screen.queryByText("Preview truncated")).toBeNull();
    expectControlsVisible();
  });
});

function expectControlsHidden(): void {
  expect(screen.queryByText("Preview truncated")).toBeNull();
  expect(
    screen.queryByRole("toolbar", { name: "Markdown view mode" }),
  ).toBeNull();
  expect(screen.queryByTestId("workspace-file-settings")).toBeNull();
}

function expectControlsVisible(): void {
  expect(
    screen.getByRole("toolbar", { name: "Markdown view mode" }),
  ).toBeTruthy();
  expect(screen.getByTestId("workspace-file-settings")).toBeTruthy();
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
