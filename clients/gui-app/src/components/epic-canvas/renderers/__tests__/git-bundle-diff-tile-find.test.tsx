import type { ReactNode } from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  GitChangedFile,
  GitGetFileDiffResponse,
} from "@traycer/protocol/host";
import { TileFindScope } from "@/components/epic-canvas/tile-find/tile-find-scope";
import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";
import { makeGitBundleDiffTile } from "@/lib/git/git-diff-tile";
import { DEFAULT_DIFF_VIEWER_PREFERENCES } from "@/lib/diff/diff-viewer-preferences";
import { useSettingsStore } from "@/stores/settings/settings-store";
import {
  useTileFindStore,
  type TileFindStateSnapshot,
} from "@/stores/tile-find";
import { EpicSessionContext } from "@/lib/registries/epic-session-registry";
import {
  createOpenEpicStore,
  type EpicStreamClientFactory,
  type OpenEpicStoreHandle,
} from "@/stores/epics/open-epic/store";
import { GitDiffTile } from "../git-diff-tile";

interface VirtuosoMockProps {
  readonly data: ReadonlyArray<unknown>;
  readonly itemContent: (index: number, item: unknown) => ReactNode;
  readonly computeItemKey: (index: number, item: unknown) => string;
}

const state = vi.hoisted(() => ({
  renderRows: true,
  scrollIntoView: vi.fn(),
  files: [
    {
      path: "src/app.ts",
      previousPath: null,
      status: "modified",
      stage: "unstaged",
      insertions: 1,
      deletions: 1,
      isBinary: false,
      sizeBytes: 12,
      stagedOid: null,
      worktreeOid: "worktree-1",
    },
  ] satisfies ReadonlyArray<GitChangedFile>,
  diff: {
    filePath: "src/app.ts",
    headSha: "head-1",
    patch: [
      "diff --git a/src/app.ts b/src/app.ts",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1 +1 @@",
      "-const label = 'OldName';",
      "+const label = 'NewName';",
      "",
    ].join("\n"),
    isBinary: false,
    isTruncated: false,
    truncatedAfterBytes: null,
    stagedOid: null,
    worktreeOid: "worktree-1",
  } satisfies GitGetFileDiffResponse,
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

vi.mock("react-virtuoso", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    Virtuoso: React.forwardRef<unknown, VirtuosoMockProps>((props, ref) => {
      React.useImperativeHandle(ref, () => ({
        scrollIntoView: state.scrollIntoView,
        getState: (
          callback: (snapshot: { readonly scrollTop: number }) => void,
        ) => {
          callback({ scrollTop: 0 });
        },
      }));
      return (
        <div data-testid="virtuoso">
          {state.renderRows
            ? props.data.map((item, index) => (
                <div key={props.computeItemKey(index, item)}>
                  {props.itemContent(index, item)}
                </div>
              ))
            : null}
        </div>
      );
    }),
  };
});

vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => "host-1",
}));

vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => null,
}));

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostSupportsMethod: () => false,
}));

vi.mock("@/hooks/agent/use-host-reachability", () => ({
  useHostReachability: () => ({
    status: "reachable",
    hostLabel: "Host",
  }),
}));

vi.mock("@/hooks/git/use-git-list-changed-files-subscription", () => ({
  useGitListChangedFilesSubscription: () => ({
    data: {
      branch: "main",
      headSha: "head-1",
      files: state.files,
    },
    error: null,
    isPending: false,
    repoState: null,
    repoMode: "normal",
    pollStartedAtMs: 1,
    watcherStatus: null,
  }),
}));

vi.mock("@/hooks/git/use-git-get-file-diff-query", () => ({
  useGitGetFileDiffQuery: () => ({
    data: state.diff,
    error: null,
    isPending: false,
  }),
}));

vi.mock("@/hooks/git/use-git-refresh-worktree-status", () => ({
  useGitRefreshWorktreeStatus: () => ({
    mutateAsync: vi.fn(() => Promise.resolve()),
  }),
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

vi.mock("@/hooks/editor/use-editor-open-feedback", () => ({
  useEditorOpenFeedback: () => ({
    active: false,
    trigger: vi.fn(),
  }),
}));

vi.mock("@/components/epic-canvas/git-diff/file-diff-content", () => ({
  FileDiffContent: (props: { readonly diff: GitGetFileDiffResponse }) => (
    <div data-testid={`file-diff-${props.diff.filePath}`} />
  ),
}));

const NODE = makeGitBundleDiffTile({
  hostId: "host-1",
  runningDir: "/repo",
  bundleGroup: "changes",
  repositoryContext: null,
});

const EPIC_ID = "epic-1";

let epicSessionHandle: OpenEpicStoreHandle;

const fakeStreamClientFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});

describe("<GitDiffTile /> bundle find", () => {
  beforeEach(() => {
    state.renderRows = true;
    state.scrollIntoView.mockClear();
    useSettingsStore.setState({
      diffViewerPreferences: DEFAULT_DIFF_VIEWER_PREFERENCES,
    });
    epicSessionHandle = createOpenEpicStore({
      epicId: EPIC_ID,
      userId: null,
      streamClientFactory: fakeStreamClientFactory,
      onAuthError: null,
    });
  });

  afterEach(() => {
    cleanup();
    useTileFindStore.getState().resetForTests();
    epicSessionHandle.dispose();
    vi.restoreAllMocks();
  });

  it("keeps loaded inline patches searchable after the virtualized row unmounts", async () => {
    const rendered = renderGitBundleTile();

    await waitFor(() => {
      search("NewName");
      expect(tileSnapshot()).toMatchObject({
        status: "ready",
        total: 1,
      });
    });

    state.renderRows = false;
    rendered.rerender(tileElement());

    await waitFor(() => {
      search("NewName");
      expect(tileSnapshot()).toMatchObject({
        status: "ready",
        total: 1,
      });
    });
  });
});

function renderGitBundleTile() {
  return render(tileElement());
}

function tileElement(): ReactNode {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  return (
    <QueryClientProvider client={queryClient}>
      <EpicSessionContext.Provider value={epicSessionHandle}>
        <TabHostProvider hostId="host-1">
          <TileFindScope
            node={NODE}
            viewTabId="view-1"
            tileId="tile-1"
            epicId={EPIC_ID}
            isActive
          >
            <GitDiffTile
              node={NODE}
              viewTabId="view-1"
              tileId="tile-1"
              isActive
            />
          </TileFindScope>
        </TabHostProvider>
      </EpicSessionContext.Provider>
    </QueryClientProvider>
  );
}

function search(query: string): void {
  act(() => {
    const store = useTileFindStore.getState();
    store.openForTile(NODE.instanceId);
    store.setQuery(NODE.instanceId, query);
    store.search(NODE.instanceId);
  });
}

function tileSnapshot(): TileFindStateSnapshot {
  const snapshot =
    useTileFindStore.getState().uiByTileInstanceId[NODE.instanceId]
      ?.lastSnapshot;
  if (snapshot === undefined) {
    throw new Error("Missing git bundle find snapshot");
  }
  return snapshot;
}
