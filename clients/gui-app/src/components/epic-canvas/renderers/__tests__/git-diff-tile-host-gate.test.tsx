import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { GitChangedFile } from "@traycer/protocol/host";
import { makeGitBundleDiffTile } from "@/lib/git/git-diff-tile";
import { DEFAULT_DIFF_VIEWER_PREFERENCES } from "@/lib/diff/diff-viewer-preferences";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";

interface GateTestState {
  activeHostId: string | null;
  reachability: {
    status: "checking" | "reachable" | "unreachable";
    hostLabel: string;
  };
  subscribe: Mock;
}

const state = vi.hoisted((): GateTestState => ({
  activeHostId: "host-A",
  reachability: {
    status: "reachable",
    hostLabel: "Host A",
  },
  subscribe: vi.fn(() => ({
    data: null,
    error: null,
    isPending: true,
    repoState: null,
    repoMode: null,
    pollStartedAtMs: null,
    watcherStatus: null,
  })),
}));

// The tile re-provides its own `StreamRuntimeContext` for the host it is BOUND
// to, so `git.subscribeStatus` cannot ride the window's effective host while
// carrying the tile's host id as a param. `null` is that hook's FOLLOWING
// answer, so the tile falls back to the ambient binding this suite supplies -
// which is what every assertion here is about. Which transport a host resolves
// to is a different question with its own suite:
// `use-surface-host-stream-binding.test.tsx`.
// The hook returns the value to PROVIDE: the ambient binding while following
// (this suite's), the pin's own once built, null while pending. Following here.
vi.mock("@/hooks/host/use-surface-host-stream-binding", async () => {
  const { use } = await import("react");
  const { StreamRuntimeContext } =
    await import("@/lib/host/stream-runtime-context");
  return { useSurfaceHostStreamBinding: () => use(StreamRuntimeContext) };
});

vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => state.activeHostId,
}));

vi.mock("@/hooks/agent/use-host-reachability", () => ({
  useHostReachability: () => state.reachability,
  resolvedHostLabel: (r: { status: string; hostLabel: string | null }) =>
    r.status === "checking" ? null : r.hostLabel,
}));

vi.mock("@/hooks/git/use-git-list-changed-files-subscription", () => ({
  useGitListChangedFilesSubscription: state.subscribe,
}));

vi.mock("@/hooks/git/use-git-get-file-diff-query", () => ({
  useGitGetFileDiffQuery: () => ({
    data: null,
    error: null,
    isPending: true,
    refetch: vi.fn(),
  }),
}));

vi.mock("@/hooks/git/use-git-refresh-worktree-status", () => ({
  useGitRefreshWorktreeStatus: () => ({
    mutateAsync: vi.fn(() => Promise.resolve()),
  }),
}));

vi.mock("react-virtuoso", () => ({
  Virtuoso: () => <div data-testid="virtuoso" />,
}));

// The toolbar's "open file" now dispatches on the TAB client (D15); these tests
// mount the tile without the whole host runtime, so the seam is stubbed the
// same way the sibling git-diff-tile suites already stub it.
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => null,
}));

// The tile dispatches `editor.openPaths` on its TAB client, not the app-wide
// one - `editor.openPaths` resolves paths on the host it is sent to (D15). The
// mocked hook ignores the client it is handed; what this repoint pins is that
// the tile no longer imports the app-wide `useEditorOpen` at all.
vi.mock("@/hooks/editor/use-editor-open-mutation", () => ({
  useEditorOpenForClient: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
}));

import { GitDiffTile } from "../git-diff-tile";
import { TabHostProvider } from "../../tab-host-provider";

const NODE = makeGitBundleDiffTile({
  hostId: "host-A",
  runningDir: "/work/repo",
  bundleGroup: "changes",
  repositoryContext: null,
});

function changedFile(path: string): GitChangedFile {
  return {
    path,
    previousPath: null,
    status: "modified",
    stage: "unstaged",
    insertions: 1,
    deletions: 0,
    isBinary: false,
    sizeBytes: 0,
    stagedOid: null,
    worktreeOid: null,
  };
}

function renderTile(boundHostId: string): void {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  render(
    <QueryClientProvider client={queryClient}>
      <TabHostProvider hostId={boundHostId}>
        <GitDiffTile node={NODE} viewTabId="view-1" tileId={NODE.id} isActive />
      </TabHostProvider>
    </QueryClientProvider>,
  );
}

describe("<GitDiffTile /> host-binding gate", () => {
  beforeEach(() => {
    state.activeHostId = "host-A";
    state.reachability = { status: "reachable", hostLabel: "Host A" };
    state.subscribe.mockClear();
    state.subscribe.mockReturnValue({
      data: null,
      error: null,
      isPending: true,
      repoState: null,
      repoMode: null,
      pollStartedAtMs: null,
      watcherStatus: null,
    });
    useSettingsStore.setState({
      diffViewerPreferences: DEFAULT_DIFF_VIEWER_PREFERENCES,
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows the offline banner without opening a git stream", () => {
    state.reachability = { status: "unreachable", hostLabel: "Host A" };
    renderTile("host-A");

    expect(screen.getByText(/currently unreachable/)).toBeTruthy();
    expect(state.subscribe).not.toHaveBeenCalled();
  });

  it("opens the git stream when the bound host is reachable but not the active host", () => {
    state.activeHostId = "host-B";
    renderTile("host-A");

    expect(screen.queryByText(/Switch your active host/)).toBeNull();
    expect(screen.queryByText(/currently unreachable/)).toBeNull();
    expect(state.subscribe).toHaveBeenCalledWith({
      hostId: "host-A",
      runningDir: "/work/repo",
      ignoreWhitespace: false,
      enabled: true,
    });
  });

  it("opens the git stream when the bound host is active and reachable", () => {
    renderTile("host-A");

    expect(screen.queryByText(/Switch your active host/)).toBeNull();
    expect(screen.queryByText(/currently unreachable/)).toBeNull();
    expect(state.subscribe).toHaveBeenCalledWith({
      hostId: "host-A",
      runningDir: "/work/repo",
      ignoreWhitespace: false,
      enabled: true,
    });
  });

  it("opens the git stream with the global whitespace preference", () => {
    useSettingsStore.getState().setDiffViewerPreferences({
      ...DEFAULT_DIFF_VIEWER_PREFERENCES,
      ignoreWhitespace: true,
    });

    renderTile("host-A");

    expect(state.subscribe).toHaveBeenCalledWith({
      hostId: "host-A",
      runningDir: "/work/repo",
      ignoreWhitespace: true,
      enabled: true,
    });
  });

  it("writes toolbar preference changes to global settings", () => {
    renderTile("host-A");

    fireEvent.click(screen.getByLabelText("Switch to unified view"));

    expect(useSettingsStore.getState().diffViewerPreferences.mode).toBe(
      "unified",
    );
  });

  it("keeps bundle collapse state on the tile", () => {
    state.subscribe.mockReturnValue({
      data: {
        branch: "main",
        headSha: "abc123",
        files: [changedFile("src/a.ts"), changedFile("src/b.ts")],
      },
      error: null,
      isPending: false,
      repoState: null,
      repoMode: "normal",
      pollStartedAtMs: 1,
      watcherStatus: null,
    });
    const updateView = vi.spyOn(
      useEpicCanvasStore.getState(),
      "updateGitDiffTileViewInTab",
    );

    renderTile("host-A");

    fireEvent.click(screen.getByLabelText("Collapse all"));

    expect(updateView).toHaveBeenCalledWith("view-1", NODE.id, {
      ...NODE.view,
      collapsedFilePaths: ["src/a.ts", "src/b.ts"],
    });
    expect(useSettingsStore.getState().diffViewerPreferences).toEqual(
      DEFAULT_DIFF_VIEWER_PREFERENCES,
    );
  });
});
