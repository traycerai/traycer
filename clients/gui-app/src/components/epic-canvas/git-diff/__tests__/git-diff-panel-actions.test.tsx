import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { GitDiffPanelActions } from "../git-diff-panel-actions";
import { useGitPanelStore } from "@/stores/epics/git-panel-store";
import { DEFAULT_DIFF_VIEWER_PREFERENCES } from "@/lib/diff/diff-viewer-preferences";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { TooltipProvider } from "@/components/ui/tooltip";

interface RefreshHookArgs {
  readonly hostId: string | null;
  readonly rootRunningDir: string | null;
  readonly ignoreWhitespace: boolean;
}

const testState = vi.hoisted(() => ({
  refresh: vi.fn<() => Promise<void>>(),
  refreshArgs: [] as RefreshHookArgs[],
}));

vi.mock("@/hooks/git/use-git-submodule-snapshot-refresh", () => ({
  useGitSubmoduleSnapshotRefresh: (args: RefreshHookArgs) => {
    testState.refreshArgs.push(args);
    return { refresh: testState.refresh, isRefreshing: false };
  },
}));

function setup() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { readonly children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={0}>{children}</TooltipProvider>
    </QueryClientProvider>
  );
  return { wrapper };
}

function openMoreMenu(): void {
  fireEvent.pointerDown(
    screen.getByRole("button", { name: "More Git Diff actions" }),
    { button: 0 },
  );
}

describe("<GitDiffPanelActions />", () => {
  beforeEach(() => {
    cleanup();
    testState.refresh.mockReset();
    testState.refresh.mockResolvedValue(undefined);
    testState.refreshArgs = [];
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

  it("renders layout toggle and refresh in the stable overflow menu", () => {
    const { wrapper } = setup();
    render(
      <GitDiffPanelActions
        epicId="epic-1"
        tabId="tab-1"
        collapsed={false}
        mode="normal"
      />,
      { wrapper },
    );

    openMoreMenu();
    expect(screen.getByTestId("git-diff-panel-layout-toggle")).toBeDefined();
    expect(screen.getByTestId("git-diff-panel-refresh")).toBeDefined();
  });

  it("toggles list layout from the header action", () => {
    const { wrapper } = setup();
    render(
      <GitDiffPanelActions
        epicId="epic-1"
        tabId="tab-1"
        collapsed={false}
        mode="normal"
      />,
      { wrapper },
    );

    openMoreMenu();
    fireEvent.click(screen.getByTestId("git-diff-panel-layout-toggle"));

    expect(useGitPanelStore.getState().stateByEpicId["epic-1"].listLayout).toBe(
      "tree",
    );
  });

  it("explains the stable overflow trigger in a keyboard-accessible tooltip", async () => {
    const { wrapper } = setup();
    render(
      <GitDiffPanelActions
        epicId="epic-1"
        tabId="tab-1"
        collapsed={false}
        mode="normal"
      />,
      { wrapper },
    );

    const trigger = screen.getByRole("button", {
      name: "More Git Diff actions",
    });
    fireEvent.focus(trigger);

    expect((await screen.findByRole("tooltip")).textContent).toBe(
      "More Git Diff actions",
    );
  });

  it("refreshes the active root's nested snapshot slot", () => {
    const { wrapper } = setup();
    render(
      <GitDiffPanelActions
        epicId="epic-1"
        tabId="tab-1"
        collapsed={false}
        mode="normal"
      />,
      { wrapper },
    );

    openMoreMenu();
    fireEvent.click(screen.getByTestId("git-diff-panel-refresh"));

    expect(testState.refresh).toHaveBeenCalledTimes(1);
  });

  it("refresh honors the global whitespace preference in the slot key", () => {
    useSettingsStore.getState().setDiffViewerPreferences({
      ...DEFAULT_DIFF_VIEWER_PREFERENCES,
      ignoreWhitespace: true,
    });
    const { wrapper } = setup();
    render(
      <GitDiffPanelActions
        epicId="epic-1"
        tabId="tab-1"
        collapsed={false}
        mode="normal"
      />,
      { wrapper },
    );

    openMoreMenu();
    fireEvent.click(screen.getByTestId("git-diff-panel-refresh"));

    expect(testState.refresh).toHaveBeenCalledTimes(1);
    expect(testState.refreshArgs.at(-1)).toEqual({
      hostId: "host-1",
      rootRunningDir: "/repo",
      ignoreWhitespace: true,
    });
  });
});
