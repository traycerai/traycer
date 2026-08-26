import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import {
  GitDiffPanelActions,
  GitDiffPanelInlineActions,
} from "../git-diff-panel-actions";
import { useGitPanelStore } from "@/stores/epics/git-panel-store";
import { DEFAULT_DIFF_VIEWER_PREFERENCES } from "@/lib/diff/diff-viewer-preferences";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useEpicLeftPanelStore } from "@/stores/epics/left-panel-store";
import { usePanelHeaderMenuStore } from "@/stores/epics/panel-header-menu-store";

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
    usePanelHeaderMenuStore.setState({ openBySurfaceKey: {} });
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
    expect(
      screen.getByRole("menuitem", { name: "Switch to tree view" }),
    ).toBeDefined();
    const refresh = screen.getByRole("menuitem", { name: "Refresh" });
    expect(refresh.querySelector(".lucide-refresh-cw")).not.toBeNull();
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
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Switch to tree view" }),
    );

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
    fireEvent.click(screen.getByRole("menuitem", { name: "Refresh" }));

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
    fireEvent.click(screen.getByRole("menuitem", { name: "Refresh" }));

    expect(testState.refresh).toHaveBeenCalledTimes(1);
    expect(testState.refreshArgs.at(-1)).toEqual({
      hostId: "host-1",
      rootRunningDir: "/repo",
      ignoreWhitespace: true,
    });
  });

  it("expands a collapsed panel while preserving the open menu", () => {
    const { wrapper } = setup();
    useEpicLeftPanelStore.setState({
      panelSectionCollapsedByPanelId: { "git-diff": true },
    });
    render(
      <GitDiffPanelActions
        epicId="epic-1"
        tabId="tab-1"
        collapsed
        mode="normal"
      />,
      { wrapper },
    );

    openMoreMenu();

    expect(
      useEpicLeftPanelStore.getState().isPanelSectionCollapsed("git-diff"),
    ).toBe(false);
    expect(usePanelHeaderMenuStore.getState().openBySurfaceKey).toEqual(
      expect.objectContaining({ '["tab-1","git-diff","more"]': true }),
    );
  });
});

describe("<GitDiffPanelInlineActions />", () => {
  beforeEach(() => {
    cleanup();
    testState.refresh.mockReset();
    testState.refresh.mockResolvedValue(undefined);
    testState.refreshArgs = [];
    useGitPanelStore.setState({ stateByEpicId: {} });
    usePanelHeaderMenuStore.setState({ openBySurfaceKey: {} });
    useSettingsStore.setState({
      diffViewerPreferences: DEFAULT_DIFF_VIEWER_PREFERENCES,
    });
    useGitPanelStore.getState().setSelectedRepo("epic-1", {
      hostId: "host-1",
      rootRunningDir: "/repo",
      repoRoot: "/repo",
    });
  });

  it("offers the same menu the sidebar header does", () => {
    const { wrapper } = setup();
    render(<GitDiffPanelInlineActions epicId="epic-1" />, { wrapper });

    openMoreMenu();

    expect(
      screen.getByRole("menuitem", { name: "Switch to tree view" }),
    ).toBeDefined();
    expect(screen.getByRole("menuitem", { name: "Refresh" })).toBeDefined();
  });

  it("drives the same layout mutation as the sidebar header", () => {
    const { wrapper } = setup();
    render(<GitDiffPanelInlineActions epicId="epic-1" />, { wrapper });

    openMoreMenu();
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Switch to tree view" }),
    );

    expect(useGitPanelStore.getState().stateByEpicId["epic-1"].listLayout).toBe(
      "tree",
    );
  });

  it("refreshes the active root's nested snapshot slot", () => {
    const { wrapper } = setup();
    render(<GitDiffPanelInlineActions epicId="epic-1" />, { wrapper });

    openMoreMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Refresh" }));

    expect(testState.refresh).toHaveBeenCalledTimes(1);
  });

  it("keeps its open state local to the trigger", () => {
    const { wrapper } = setup();
    render(<GitDiffPanelInlineActions epicId="epic-1" />, { wrapper });

    openMoreMenu();

    // No sidebar section to reopen behind it, so the panel-header menu store
    // stays untouched - it is the sidebar's collapse-survival mechanism.
    expect(usePanelHeaderMenuStore.getState().openBySurfaceKey).toEqual({});
  });
});
