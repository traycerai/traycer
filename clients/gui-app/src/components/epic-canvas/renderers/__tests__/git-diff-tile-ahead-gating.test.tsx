import "../../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  GitListChangedFilesResponseV11,
  GitSubscribeStatusEvent,
} from "@traycer/protocol/host";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { makeGitAheadFileDiffTile } from "@/lib/git/git-diff-tile";
import type { CurrentAheadSnapshotResult } from "@/hooks/git/use-current-ahead-snapshot";
import { DEFAULT_DIFF_VIEWER_PREFERENCES } from "@/lib/diff/diff-viewer-preferences";
import { useSettingsStore } from "@/stores/settings/settings-store";

interface AheadGateTestState {
  snapshot: CurrentAheadSnapshotResult;
  subscriptionError: GitSubscribeStatusEvent | null;
}

const state = vi.hoisted((): AheadGateTestState => ({
  snapshot: { data: null, isPending: true, error: null },
  subscriptionError: null,
}));

// Spy on the guarded diff query: it lives inside the ready child, so it is
// invoked ONLY when the gate opens on confirmed-current metadata.
const diffQuerySpy = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => "host-A",
}));

vi.mock("@/hooks/agent/use-host-reachability", () => ({
  useHostReachability: () => ({ status: "reachable", hostLabel: "Host A" }),
}));

vi.mock("@/hooks/git/use-git-list-changed-files-subscription", () => ({
  useGitListChangedFilesSubscription: () => ({
    data: { branch: "main", headSha: "sub-head", files: [], fingerprint: "p" },
    error: state.subscriptionError,
    isPending: false,
    repoState: null,
    repoMode: null,
    pollStartedAtMs: null,
  }),
}));

vi.mock("@/hooks/git/use-current-ahead-snapshot", () => ({
  useCurrentAheadSnapshot: () => state.snapshot,
}));

vi.mock("@/hooks/git/use-git-get-file-diff-query", () => ({
  useGitGetFileDiffQuery: (args: unknown) => {
    diffQuerySpy(args);
    return { data: undefined, error: null, isPending: true, refetch: vi.fn() };
  },
}));

vi.mock("@/hooks/git/use-git-refresh-worktree-status", () => ({
  useGitRefreshWorktreeStatus: () => ({
    mutateAsync: vi.fn(() => Promise.resolve()),
  }),
}));

vi.mock("@/hooks/editor/use-editor-open-mutation", () => ({
  useEditorOpen: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { GitDiffTile } from "../git-diff-tile";
import { TabHostProvider } from "../../tab-host-provider";

const NODE = makeGitAheadFileDiffTile({
  hostId: "host-A",
  runningDir: "/repo/traycer",
  parentRunningDir: "/repo",
  filePath: "committed.ts",
});

function aheadSnapshot(
  overrides: Partial<GitListChangedFilesResponseV11>,
): GitListChangedFilesResponseV11 {
  return {
    runningDir: "/repo",
    headSha: "parent-head",
    branch: "development",
    files: [],
    fingerprint: "v11-fp",
    repoMode: "normal",
    repoState: { kind: "clean" },
    submodules: [
      {
        repoRoot: "/repo/traycer",
        parentPath: "traycer",
        branch: "main",
        repoState: { kind: "clean" },
        relation: {
          state: "ahead",
          recordedPinSha: "PIN-2",
          submoduleHeadSha: "HEAD-2",
          commitsAhead: {
            count: 1,
            files: [
              {
                path: "committed.ts",
                previousPath: null,
                status: "modified",
                isBinary: false,
                insertions: 3,
                deletions: 1,
              },
            ],
          },
        },
        files: [],
      },
    ],
    ...overrides,
  };
}

function renderAheadTile(): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <TabHostProvider hostId="host-A">
        <GitDiffTile node={NODE} viewTabId="view-1" tileId={NODE.id} isActive />
      </TabHostProvider>
    </QueryClientProvider>,
  );
}

describe("<GitDiffTile /> ahead-of-pin gating", () => {
  beforeEach(() => {
    diffQuerySpy.mockReset();
    state.subscriptionError = null;
    state.snapshot = { data: null, isPending: true, error: null };
    useSettingsStore.setState({
      diffViewerPreferences: DEFAULT_DIFF_VIEWER_PREFERENCES,
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("does NOT issue getFileDiff while the current-epoch snapshot is still pending", () => {
    // The current-epoch snapshot has not landed (a previous-epoch snapshot may be
    // cached under a prior key, but this hook keys by epoch so it reads null) -
    // the exact stale/moved-pin window. The guarded diff query must not be reached.
    state.snapshot = { data: null, isPending: true, error: null };

    renderAheadTile();

    expect(diffQuerySpy).not.toHaveBeenCalled();
  });

  it("issues getFileDiff with the fresh pin once current-epoch metadata lands", () => {
    state.snapshot = { data: aheadSnapshot({}), isPending: false, error: null };

    renderAheadTile();

    expect(diffQuerySpy).toHaveBeenCalledTimes(1);
    const args = diffQuerySpy.mock.calls[0][0] as {
      compareFromSha: string | null;
      runningDir: string;
      filePath: string;
    };
    expect(args.compareFromSha).toBe("PIN-2");
    expect(args.runningDir).toBe("/repo/traycer");
    expect(args.filePath).toBe("committed.ts");
  });

  it("shows the ahead-unavailable copy (no getFileDiff) when the current snapshot degraded to parent-only", () => {
    state.snapshot = {
      data: aheadSnapshot({ submodules: [] }),
      isPending: false,
      error: null,
    };

    renderAheadTile();

    expect(diffQuerySpy).not.toHaveBeenCalled();
    expect(
      screen.getByText(/no longer listed as a committed submodule change/i),
    ).toBeDefined();
  });

  it("surfaces a v1.1 metadata error instead of a permanent skeleton", () => {
    const error: HostRpcError = Object.assign(new Error("v11 boom"), {
      code: "INTERNAL",
    }) as HostRpcError;
    state.snapshot = { data: null, isPending: false, error };

    renderAheadTile();

    expect(screen.getByText("Diff Loading Error")).toBeDefined();
    expect(screen.getByText("v11 boom")).toBeDefined();
    expect(diffQuerySpy).not.toHaveBeenCalled();
  });

  it("surfaces a parent-subscription error instead of a permanent skeleton", () => {
    state.subscriptionError = {
      type: "error",
      message: "subscribe boom",
      isFatal: false,
    };
    state.snapshot = { data: null, isPending: false, error: null };

    renderAheadTile();

    expect(screen.getByText("subscribe boom")).toBeDefined();
    expect(diffQuerySpy).not.toHaveBeenCalled();
  });
});
