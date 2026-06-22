import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { WorktreeBindingSelectorRow } from "@traycer/protocol/host";
import { PanelToolbar } from "../panel-toolbar";
import { useGitPanelStore } from "@/stores/epics/git-panel-store";
import { useSettingsStore } from "@/stores/settings/settings-store";

vi.mock("@/hooks/git/use-git-prefetch-worktree-status", () => ({
  useGitPrefetchWorktreeStatus: () => vi.fn(),
}));

const editorState = vi.hoisted(() => ({
  mutate: vi.fn(),
  isPending: false,
  availability: [
    "vscode",
    "cursor",
    "windsurf",
    "zed",
  ] as ReadonlyArray<string>,
  hasLocalHost: true,
  activeHostId: "host-1",
}));

vi.mock("@/hooks/editor/use-editor-open-mutation", () => ({
  useEditorOpen: () => ({
    mutate: editorState.mutate,
    isPending: editorState.isPending,
  }),
}));

vi.mock("@/hooks/editor/use-editor-availability-query", () => ({
  useEditorAvailability: () => ({ data: editorState.availability }),
}));

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({ hasLocalHost: editorState.hasLocalHost }),
}));

vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => editorState.activeHostId,
}));

vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: (hostId: string) =>
    hostId.length > 0 ? { kind: "local" } : null,
}));

function makeQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function makeWrapper(queryClient: QueryClient) {
  return ({ children }: { readonly children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

function makeRow(runningDir: string): WorktreeBindingSelectorRow {
  return {
    hostId: "host-1",
    runningDir,
    workspacePath: "/Users/anurag/work/traycer",
    worktreePath: runningDir,
    mode: "worktree",
    isGitRepo: true,
    repoIdentifier: { owner: "traycer", repo: "traycer" },
    branch: "main",
    isPrimary: true,
    isImported: false,
    setupState: "not_required",
    disabledReason: null,
    sources: [],
  };
}

describe("<PanelToolbar />", () => {
  beforeEach(() => {
    cleanup();
    useGitPanelStore.setState({ stateByEpicId: {} });
    useSettingsStore.setState({ defaultEditor: null });
    editorState.mutate.mockClear();
    editorState.isPending = false;
    editorState.availability = ["vscode", "cursor", "windsurf", "zed"];
    editorState.hasLocalHost = true;
    editorState.activeHostId = "host-1";
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the opener beside the git-diff picker", () => {
    const row = makeRow("/Users/anurag/work/traycer");
    render(<PanelToolbar epicId="epic-1" rows={[row]} selectedRow={row} />, {
      wrapper: makeWrapper(makeQueryClient()),
    });

    expect(screen.getByTestId("git-worktree-picker-trigger")).toBeDefined();
    expect(screen.getByTestId("workspace-open-in-editor")).toBeDefined();
  });

  it("disables the opener when no worktree is selected", () => {
    const row = makeRow("/Users/anurag/work/traycer");
    render(<PanelToolbar epicId="epic-1" rows={[row]} selectedRow={null} />, {
      wrapper: makeWrapper(makeQueryClient()),
    });

    expect(screen.getByTestId("git-worktree-picker-trigger")).toBeDefined();
    expect(
      screen
        .getByTestId("workspace-open-in-editor-primary")
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen
        .getByTestId("workspace-open-in-editor-chevron")
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  it("opens the selected worktree's runningDir on the active host", () => {
    const row = makeRow("/Users/anurag/work/traycer");
    render(<PanelToolbar epicId="epic-1" rows={[row]} selectedRow={row} />, {
      wrapper: makeWrapper(makeQueryClient()),
    });

    fireEvent.click(screen.getByTestId("workspace-open-in-editor-primary"));

    expect(editorState.mutate).toHaveBeenCalledWith({
      editorId: "vscode",
      paths: ["/Users/anurag/work/traycer"],
    });
  });

  it("omits the opener without a local host", () => {
    editorState.hasLocalHost = false;
    const row = makeRow("/Users/anurag/work/traycer");
    render(<PanelToolbar epicId="epic-1" rows={[row]} selectedRow={row} />, {
      wrapper: makeWrapper(makeQueryClient()),
    });

    expect(screen.getByTestId("git-worktree-picker-trigger")).toBeDefined();
    expect(screen.queryByTestId("workspace-open-in-editor")).toBeNull();
  });
});
