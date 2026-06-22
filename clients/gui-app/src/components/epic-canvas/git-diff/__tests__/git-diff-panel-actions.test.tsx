import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { GitDiffPanelActions } from "../git-diff-panel-actions";
import { useGitPanelStore } from "@/stores/epics/git-panel-store";
import { DEFAULT_DIFF_VIEWER_PREFERENCES } from "@/lib/diff/diff-viewer-preferences";
import { useSettingsStore } from "@/stores/settings/settings-store";

vi.mock("@/hooks/worktree/use-worktree-list-bindings-for-epic-query", () => ({
  useWorktreeListBindingsForEpic: () => ({
    data: {
      rows: [
        {
          hostId: "host-1",
          runningDir: "/repo",
          isGitRepo: true,
          disabledReason: null,
        },
      ],
    },
  }),
}));

const refreshStatus = vi.fn(() => Promise.resolve());
vi.mock("@/hooks/git/use-git-refresh-worktree-status", () => ({
  useGitRefreshWorktreeStatus: () => ({
    mutateAsync: refreshStatus,
  }),
}));

function makeWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { readonly children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe("<GitDiffPanelActions />", () => {
  beforeEach(() => {
    cleanup();
    refreshStatus.mockClear();
    useGitPanelStore.setState({ stateByEpicId: {} });
    useSettingsStore.setState({
      diffViewerPreferences: DEFAULT_DIFF_VIEWER_PREFERENCES,
    });
    useGitPanelStore.getState().setSelectedWorktree("epic-1", {
      hostId: "host-1",
      runningDir: "/repo",
    });
  });

  it("renders layout toggle and refresh in the panel header", () => {
    render(<GitDiffPanelActions epicId="epic-1" tabId="tab-1" />, {
      wrapper: makeWrapper(),
    });

    expect(screen.getByTestId("git-diff-panel-layout-toggle")).toBeDefined();
    expect(screen.getByTestId("git-diff-panel-refresh")).toBeDefined();
  });

  it("toggles list layout from the header action", () => {
    render(<GitDiffPanelActions epicId="epic-1" tabId="tab-1" />, {
      wrapper: makeWrapper(),
    });

    fireEvent.click(screen.getByTestId("git-diff-panel-layout-toggle"));

    expect(useGitPanelStore.getState().stateByEpicId["epic-1"].listLayout).toBe(
      "tree",
    );
  });

  it("force-fetches the selected worktree status on refresh", () => {
    render(<GitDiffPanelActions epicId="epic-1" tabId="tab-1" />, {
      wrapper: makeWrapper(),
    });

    fireEvent.click(screen.getByTestId("git-diff-panel-refresh"));

    expect(refreshStatus).toHaveBeenCalledWith({
      hostId: "host-1",
      runningDir: "/repo",
      ignoreWhitespace: false,
    });
  });

  it("force-fetches with the global whitespace preference", () => {
    useSettingsStore.getState().setDiffViewerPreferences({
      ...DEFAULT_DIFF_VIEWER_PREFERENCES,
      ignoreWhitespace: true,
    });
    render(<GitDiffPanelActions epicId="epic-1" tabId="tab-1" />, {
      wrapper: makeWrapper(),
    });

    fireEvent.click(screen.getByTestId("git-diff-panel-refresh"));

    expect(refreshStatus).toHaveBeenCalledWith({
      hostId: "host-1",
      runningDir: "/repo",
      ignoreWhitespace: true,
    });
  });
});
