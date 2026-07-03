import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { GitDiffPanelActions } from "../git-diff-panel-actions";
import { useGitPanelStore } from "@/stores/epics/git-panel-store";
import { DEFAULT_DIFF_VIEWER_PREFERENCES } from "@/lib/diff/diff-viewer-preferences";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { gitQueryKeys } from "@/lib/query-keys/git-query-keys";

function setup() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
  const wrapper = ({ children }: { readonly children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { invalidateSpy, wrapper };
}

describe("<GitDiffPanelActions />", () => {
  beforeEach(() => {
    cleanup();
    useGitPanelStore.setState({ stateByEpicId: {} });
    useSettingsStore.setState({
      diffViewerPreferences: DEFAULT_DIFF_VIEWER_PREFERENCES,
    });
    useGitPanelStore.getState().setSelectedRepo("epic-1", {
      hostId: "host-1",
      rootRunningDir: "/repo",
      repoRoot: "/repo",
    });
  });

  it("renders layout toggle and refresh in the panel header", () => {
    const { wrapper } = setup();
    render(<GitDiffPanelActions epicId="epic-1" tabId="tab-1" />, { wrapper });

    expect(screen.getByTestId("git-diff-panel-layout-toggle")).toBeDefined();
    expect(screen.getByTestId("git-diff-panel-refresh")).toBeDefined();
  });

  it("toggles list layout from the header action", () => {
    const { wrapper } = setup();
    render(<GitDiffPanelActions epicId="epic-1" tabId="tab-1" />, { wrapper });

    fireEvent.click(screen.getByTestId("git-diff-panel-layout-toggle"));

    expect(useGitPanelStore.getState().stateByEpicId["epic-1"].listLayout).toBe(
      "tree",
    );
  });

  it("invalidates the active root's nested snapshot on refresh", () => {
    const { invalidateSpy, wrapper } = setup();
    render(<GitDiffPanelActions epicId="epic-1" tabId="tab-1" />, { wrapper });

    fireEvent.click(screen.getByTestId("git-diff-panel-refresh"));

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: gitQueryKeys.listChangedFilesWithSubmodules(
        "host-1",
        "/repo",
        false,
      ),
    });
  });

  it("refresh honors the global whitespace preference in the slot key", () => {
    useSettingsStore.getState().setDiffViewerPreferences({
      ...DEFAULT_DIFF_VIEWER_PREFERENCES,
      ignoreWhitespace: true,
    });
    const { invalidateSpy, wrapper } = setup();
    render(<GitDiffPanelActions epicId="epic-1" tabId="tab-1" />, { wrapper });

    fireEvent.click(screen.getByTestId("git-diff-panel-refresh"));

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: gitQueryKeys.listChangedFilesWithSubmodules(
        "host-1",
        "/repo",
        true,
      ),
    });
  });
});
