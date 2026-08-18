import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  type RenderResult,
} from "@testing-library/react";
import type {
  GitChangedFile,
  GitGetFileDiffResponse,
} from "@traycer/protocol/host";
import type {
  ImageAssetRequest,
  ImageAssetState,
} from "@/hooks/assets/use-image-asset";
import type { DiffViewerPreferences } from "@/lib/diff/diff-viewer-preferences";
import { makeGitFileDiffTile } from "@/lib/git/git-diff-tile";

const PREFERENCES: DiffViewerPreferences = {
  mode: "split",
  wordWrap: false,
  ignoreWhitespace: false,
  backgrounds: true,
  lineNumbers: true,
  indicatorStyle: "bars",
};

const DIFF: GitGetFileDiffResponse = {
  filePath: "src/app.ts",
  headSha: "head-1",
  patch: "@@ -1 +1 @@",
  isTruncated: false,
  truncatedAfterBytes: null,
  isBinary: false,
  stagedOid: null,
  worktreeOid: "worktree-1",
};

const state = vi.hoisted(() => ({
  file: null as GitChangedFile | null,
  diff: null as GitGetFileDiffResponse | null,
  editableCalls: [] as Array<{
    readonly queryEnabled: boolean;
    readonly file: GitChangedFile;
  }>,
  subscribe: vi.fn(),
  open: vi.fn(),
  openFeedback: vi.fn(),
  refresh: vi.fn(),
  updateView: vi.fn(),
  assetRequests: [] as Array<ImageAssetRequest | null>,
  asset: null as ImageAssetState | null,
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

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock("@/components/epic-canvas/hooks/use-tab-host-id", () => ({
  useTabHostId: () => "host-A",
}));

vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => "host-A",
}));

vi.mock("@/hooks/agent/use-host-reachability", () => ({
  useHostReachability: () => ({ status: "reachable", hostLabel: "Host A" }),
}));

vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => null,
}));

vi.mock("@/hooks/assets/use-image-asset", () => ({
  useImageAsset: (request: ImageAssetRequest | null): ImageAssetState => {
    state.assetRequests.push(request);
    if (state.asset === null) throw new Error("missing image state");
    return state.asset;
  },
}));

vi.mock("@/hooks/git/use-git-list-changed-files-subscription", () => ({
  useGitListChangedFilesSubscription: state.subscribe,
}));

vi.mock("@/hooks/git/use-git-refresh-worktree-status", () => ({
  useGitRefreshWorktreeStatus: () => ({ mutateAsync: state.refresh }),
}));

vi.mock("@/hooks/use-refresh-spinner", () => ({
  useRefreshSpinner: () => ({ refreshing: false, trigger: vi.fn() }),
}));

// The tile dispatches `editor.openPaths` on its TAB client, not the app-wide
// one - `editor.openPaths` resolves paths on the host it is sent to (D15). The
// mocked hook ignores the client it is handed; what this repoint pins is that
// the tile no longer imports the app-wide `useEditorOpen` at all.
vi.mock("@/hooks/editor/use-editor-open-mutation", () => ({
  useEditorOpenForClient: () => ({ mutate: state.open, isPending: false }),
}));

vi.mock("@/hooks/editor/use-editor-open-feedback", () => ({
  useEditorOpenFeedback: () => ({
    active: false,
    trigger: state.openFeedback,
  }),
}));

vi.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: <T,>(
    selector: (settings: {
      readonly defaultEditor: string;
      readonly diffViewerPreferences: DiffViewerPreferences;
      readonly patchDiffViewerPreferences: (patch: unknown) => void;
    }) => T,
  ): T =>
    selector({
      defaultEditor: "vscode",
      diffViewerPreferences: PREFERENCES,
      patchDiffViewerPreferences: vi.fn(),
    }),
}));

vi.mock("@/stores/epics/canvas/store", () => ({
  useEpicCanvasStore: <T,>(
    selector: (store: {
      readonly updateGitDiffTileViewInTab: typeof state.updateView;
    }) => T,
  ): T => selector({ updateGitDiffTileViewInTab: state.updateView }),
}));

vi.mock("@/components/epic-canvas/git-diff/diff-tab-shell", () => ({
  DiffTabShell: (props: {
    readonly toolbar: ReactNode;
    readonly children: ReactNode;
  }) => (
    <div data-testid="diff-tab-shell">
      {props.toolbar}
      {props.children}
    </div>
  ),
  DiffTabHeaderPortal: (props: { readonly children: ReactNode }) =>
    props.children,
}));

vi.mock("@/components/epic-canvas/git-diff/diff-tab-toolbar", () => ({
  DiffTabToolbar: () => null,
}));

vi.mock("@/components/epic-canvas/git-diff/file-diff-content", () => ({
  FileDiffContent: () => <div data-testid="file-diff-content" />,
}));

vi.mock("@/components/epic-canvas/image-preview/image-preview", () => ({
  ImagePreview: (props: {
    readonly fileName: string;
    readonly status: string;
    readonly compact: boolean;
    readonly fitOverride: string | null;
  }) => (
    <div
      data-testid="image-preview-side"
      data-file-name={props.fileName}
      data-status={props.status}
      data-compact={String(props.compact)}
      data-fit={props.fitOverride ?? "null"}
    />
  ),
}));

vi.mock("@/components/epic-canvas/binary-placeholder", () => ({
  BinaryPlaceholder: (props: {
    readonly fileName: string;
    readonly reason: string | null;
  }) => (
    <div data-testid="binary-placeholder" data-file-name={props.fileName}>
      {props.reason}
    </div>
  ),
}));

vi.mock(
  "@/components/epic-canvas/git-diff/diff-content-loading-skeleton",
  () => ({
    DiffContentLoadingSkeleton: () => <div data-testid="diff-loading" />,
  }),
);

vi.mock("@/components/epic-canvas/git-diff/git-error-block", () => ({
  GitErrorBlock: () => <div data-testid="git-error" />,
}));

vi.mock("@/components/epic-canvas/git-diff/git-watcher-status-notice", () => ({
  GitWatcherStatusNotice: () => null,
}));

vi.mock(
  "@/components/epic-canvas/git-diff/placeholders/no-longer-changed",
  () => ({
    NoLongerChanged: () => <div data-testid="no-longer-changed" />,
  }),
);

vi.mock(
  "@/components/epic-canvas/git-diff/empty-states/subscription-error-state",
  () => ({
    SubscriptionErrorState: () => <div data-testid="subscription-error" />,
  }),
);

vi.mock(
  "@/components/epic-canvas/git-diff/empty-states/no-changes-in-worktree",
  () => ({
    NoChangesInWorktree: () => <div data-testid="no-changes" />,
  }),
);

vi.mock("@/components/epic-canvas/renderers/dead-tile-banner", () => ({
  GitDiffDeadTileBanner: () => <div data-testid="dead-tile" />,
}));

vi.mock("@/components/epic-canvas/git-diff/git-bundle-file-section", () => ({
  BundleFileSection: () => null,
}));

vi.mock("@/components/epic-canvas/git-diff/git-diff-edit-status", () => ({
  GitDiffEditStatusContent: () => null,
}));

vi.mock("@/components/epic-canvas/git-diff/git-diff-editing", () => ({
  useEditableGitDiffSurface: (args: {
    readonly queryEnabled: boolean;
    readonly file: GitChangedFile;
  }) => {
    state.editableCalls.push({
      queryEnabled: args.queryEnabled,
      file: args.file,
    });
    return {
      displayedDiff: state.diff ?? undefined,
      displayedDiffError: null,
      displayedDiffPending: false,
      editing: {
        canOfferEdit: false,
        editAdapter: undefined,
        editSession: undefined,
      },
      loadFull: vi.fn(),
    };
  },
}));

vi.mock("@/hooks/scroll/use-native-div-scroll-restoration", () => ({
  useNativeDivScrollRestoration: () => ({
    scrollContainerRef: vi.fn(),
    onScroll: vi.fn(),
  }),
}));

vi.mock("@/components/diff/diff-find-navigation", () => ({
  useDiffFindNavigation: () => ({ setScrollContainer: vi.fn() }),
}));

vi.mock("@/components/diff/use-register-diff-tile-find-adapter", () => ({
  useRegisterDiffTileFindAdapter: () => undefined,
}));

vi.mock("@/components/diff/bundle-diff-find-registration", () => ({
  BundleDiffFindRegistrationProvider: (props: {
    readonly children: ReactNode;
  }) => props.children,
}));

vi.mock("@/components/epic-canvas/git-diff/git-bundle-diff-find", () => ({
  gitBundleDiffFindFileId: (file: GitChangedFile) => `bundle:${file.path}`,
  useGitBundleDiffFind: () => null,
}));

vi.mock("@/stores/tile-find", () => ({
  createLoadedDiffTileFindSource: vi.fn(),
  createLoadingDiffTileFindSource: vi.fn(),
  createMetadataOnlyDiffTileFindSource: vi.fn(),
  createMissingDiffTileFindSource: vi.fn(),
}));

vi.mock("@/components/ui/tooltip-wrapper", () => ({
  TooltipWrapper: (props: { readonly children: ReactNode }) => props.children,
}));

import { GitDiffTile } from "../git-diff-tile";

function changedFile(args: {
  readonly path: string;
  readonly status?: GitChangedFile["status"];
  readonly stage?: GitChangedFile["stage"];
  readonly isBinary?: boolean;
  readonly previousPath?: string | null;
  readonly insertions?: number;
  readonly deletions?: number;
  readonly sizeBytes?: number;
  readonly stagedOid?: string | null;
  readonly worktreeOid?: string | null;
}): GitChangedFile {
  return {
    path: args.path,
    previousPath: args.previousPath ?? null,
    status: args.status ?? "modified",
    stage: args.stage ?? "unstaged",
    insertions: args.insertions ?? 1,
    deletions: args.deletions ?? 1,
    isBinary: args.isBinary ?? false,
    sizeBytes: args.sizeBytes ?? 12,
    stagedOid: args.stagedOid ?? null,
    worktreeOid: args.worktreeOid ?? "worktree-1",
  };
}

function tileFor(filePath: string, stage: GitChangedFile["stage"]) {
  return makeGitFileDiffTile({
    hostId: "host-A",
    runningDir: "/work/repo",
    filePath,
    stage,
    repositoryContext: null,
  });
}

function renderTile(file: GitChangedFile): RenderResult {
  state.file = file;
  state.subscribe.mockReturnValue({
    data: {
      branch: "main",
      headSha: "head-1",
      files: [file],
    },
    error: null,
    isPending: false,
    repoState: null,
    repoMode: "normal",
    pollStartedAtMs: 1,
    watcherStatus: null,
  });

  const node = tileFor(file.path, file.stage);
  return render(
    <GitDiffTile node={node} viewTabId="view-1" tileId={node.id} isActive />,
  );
}

function rerenderTile(
  rendered: RenderResult,
  file: GitChangedFile,
  headSha: string,
): void {
  state.file = file;
  state.subscribe.mockReturnValue({
    data: {
      branch: "main",
      headSha,
      files: [file],
    },
    error: null,
    isPending: false,
    repoState: null,
    repoMode: "normal",
    pollStartedAtMs: 1,
    watcherStatus: null,
  });

  const node = tileFor(file.path, file.stage);
  rendered.rerender(
    <GitDiffTile node={node} viewTabId="view-1" tileId={node.id} isActive />,
  );
}

beforeEach(() => {
  state.file = null;
  state.diff = DIFF;
  state.editableCalls.length = 0;
  state.assetRequests.length = 0;
  state.asset = {
    status: "ready",
    url: "blob:image",
    meta: null,
    reason: null,
    totalBytes: 1,
    servedFromCache: false,
  };
  state.subscribe.mockReset();
  state.open.mockReset();
  state.openFeedback.mockReset();
  state.refresh.mockReset();
  state.refresh.mockResolvedValue(undefined);
  state.updateView.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("<GitDiffTile /> image routing", () => {
  it("routes binary image extensions to ImageDiffView and skips the text query", () => {
    renderTile(changedFile({ path: "assets/photo.png", isBinary: true }));

    expect(screen.getAllByTestId("image-preview-side")).toHaveLength(2);
    expect(screen.queryByTestId("binary-placeholder")).toBeNull();
    expect(state.editableCalls.at(-1)?.queryEnabled).toBe(false);
  });

  it("remounts image subscriptions only when the git revision changes", () => {
    const initial = changedFile({
      path: "assets/photo.png",
      isBinary: true,
      stage: "staged",
      stagedOid: "staged-1",
    });
    const rendered = renderTile(initial);
    const initialSides = screen.getAllByTestId("image-preview-side");
    expect(initialSides).toHaveLength(2);

    rerenderTile(
      rendered,
      changedFile({
        path: "assets/photo.png",
        isBinary: true,
        stage: "staged",
        stagedOid: "staged-1",
      }),
      "head-1",
    );
    const unchangedRevisionSides = screen.getAllByTestId("image-preview-side");
    // The mocked preview DOM nodes stand in for the mounted asset subscriptions.
    expect(unchangedRevisionSides[0]).toBe(initialSides[0]);
    expect(unchangedRevisionSides[1]).toBe(initialSides[1]);

    rerenderTile(
      rendered,
      changedFile({
        path: "assets/photo.png",
        isBinary: true,
        stage: "staged",
        stagedOid: "staged-2",
      }),
      "head-1",
    );
    const changedRevisionSides = screen.getAllByTestId("image-preview-side");
    expect(changedRevisionSides).toHaveLength(initialSides.length);
    expect(changedRevisionSides[0]).not.toBe(initialSides[0]);
    expect(changedRevisionSides[1]).not.toBe(initialSides[1]);
  });

  it("remounts an in-flight image subscription for a changed git revision", () => {
    state.asset = {
      status: "header",
      url: null,
      meta: {
        mediaType: "image/png",
        sizeBytes: 12,
        width: 120,
        height: 80,
      },
      reason: null,
      totalBytes: 12,
      servedFromCache: false,
    };
    const rendered = renderTile(
      changedFile({
        path: "assets/slow.png",
        isBinary: true,
        stage: "staged",
        stagedOid: "staged-1",
      }),
    );
    const initialSides = screen.getAllByTestId("image-preview-side");
    expect(initialSides).toHaveLength(2);

    rerenderTile(
      rendered,
      changedFile({
        path: "assets/slow.png",
        isBinary: true,
        stage: "staged",
        stagedOid: "staged-2",
      }),
      "head-1",
    );

    const changedRevisionSides = screen.getAllByTestId("image-preview-side");
    expect(changedRevisionSides).toHaveLength(2);
    expect(changedRevisionSides[0]).not.toBe(initialSides[0]);
    expect(changedRevisionSides[1]).not.toBe(initialSides[1]);
    expect(changedRevisionSides[0]?.getAttribute("data-status")).toBe("header");
    expect(changedRevisionSides[1]?.getAttribute("data-status")).toBe("header");
  });

  // Deliberate residual: when degraded mode leaves both OIDs null, a content
  // swap that preserves insertions, deletions, and sizeBytes at the same
  // headSha remains unobservable and is intentionally not asserted here.
  it("remounts a degraded git image when fallback stats change", () => {
    const initial = changedFile({
      path: "assets/degraded.png",
      isBinary: true,
      stage: "staged",
      stagedOid: null,
      worktreeOid: null,
      insertions: 1,
      deletions: 1,
      sizeBytes: 12,
    });
    const rendered = renderTile(initial);
    const initialSides = screen.getAllByTestId("image-preview-side");
    expect(initialSides).toHaveLength(2);

    rerenderTile(
      rendered,
      changedFile({
        path: "assets/degraded.png",
        isBinary: true,
        stage: "staged",
        stagedOid: null,
        worktreeOid: null,
        insertions: 2,
        deletions: 1,
        sizeBytes: 13,
      }),
      "head-1",
    );

    const changedRevisionSides = screen.getAllByTestId("image-preview-side");
    expect(changedRevisionSides).toHaveLength(2);
    expect(changedRevisionSides[0]).not.toBe(initialSides[0]);
    expect(changedRevisionSides[1]).not.toBe(initialSides[1]);
  });

  it("keeps non-image binary files on BinaryPlaceholder", () => {
    renderTile(changedFile({ path: "assets/archive.zip", isBinary: true }));

    expect(screen.getByTestId("binary-placeholder")).toBeTruthy();
    expect(screen.queryByTestId("image-diff-view")).toBeNull();
    expect(state.editableCalls.at(-1)?.queryEnabled).toBe(false);
  });

  it("defaults SVG to image mode and toggles to the existing source diff", () => {
    renderTile(changedFile({ path: "assets/icon.svg" }));

    expect(screen.getAllByTestId("image-preview-side")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "View source" })).toBeTruthy();
    expect(state.editableCalls.at(-1)?.queryEnabled).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "View source" }));

    expect(screen.getByTestId("file-diff-content")).toBeTruthy();
    expect(screen.queryByTestId("image-preview-side")).toBeNull();
    expect(state.editableCalls.at(-1)?.queryEnabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "View image" }));

    expect(screen.getAllByTestId("image-preview-side")).toHaveLength(2);
    expect(screen.queryByTestId("file-diff-content")).toBeNull();
  });

  it("keeps ordinary text files on the existing diff path", () => {
    renderTile(changedFile({ path: "src/app.ts" }));

    expect(screen.getByTestId("file-diff-content")).toBeTruthy();
    expect(screen.queryByTestId("image-diff-view")).toBeNull();
    expect(screen.queryByRole("button", { name: "View source" })).toBeNull();
    expect(state.editableCalls.at(-1)?.queryEnabled).toBe(true);
  });

  it("passes renamed previousPath through the image diff surface", () => {
    renderTile(
      changedFile({
        path: "assets/new-name.png",
        previousPath: "assets/old-name.png",
        status: "renamed",
        isBinary: true,
      }),
    );

    expect(screen.getAllByTestId("image-preview-side")).toHaveLength(2);
    expect(
      state.assetRequests.filter((request) => request?.method === "git"),
    ).toEqual([
      expect.objectContaining({
        side: "old",
        previousPath: "assets/old-name.png",
      }),
      expect.objectContaining({
        side: "new",
        previousPath: "assets/old-name.png",
      }),
    ]);
  });

  it("routes a binary rename from old.png to new.jpg through both image sides", () => {
    const changed = changedFile({
      path: "assets/new.jpg",
      previousPath: "assets/old.png",
      status: "renamed",
      isBinary: true,
    });

    renderTile(changed);

    expect(screen.getAllByTestId("image-preview-side")).toHaveLength(2);
    expect(
      screen.queryByText(
        "This file is not one of the supported image formats.",
      ),
    ).toBeNull();
    expect(
      state.assetRequests.filter((request) => request?.method === "git"),
    ).toHaveLength(2);
  });

  it("keeps the old image side for a binary rename from old.png to new.txt without fetching the new side", () => {
    const changed = changedFile({
      path: "assets/new.txt",
      previousPath: "assets/old.png",
      status: "renamed",
      isBinary: true,
    });

    renderTile(changed);

    expect(screen.getAllByTestId("image-preview-side")).toHaveLength(1);
    expect(
      screen.getByText("This file is not one of the supported image formats."),
    ).toBeTruthy();
    expect(
      state.assetRequests.filter((request) => request?.method === "git"),
    ).toEqual([expect.objectContaining({ side: "old" })]);
  });

  it("routes a text SVG rename from old.svg to new.txt with the source toggle", () => {
    const changed = changedFile({
      path: "assets/new.txt",
      previousPath: "assets/old.svg",
      status: "renamed",
      isBinary: false,
    });

    renderTile(changed);

    expect(screen.getAllByTestId("image-preview-side")).toHaveLength(1);
    expect(
      screen.getByText("This file is not one of the supported image formats."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "View source" })).toBeTruthy();
    expect(
      state.assetRequests.filter((request) => request?.method === "git"),
    ).toEqual([expect.objectContaining({ side: "old" })]);
    expect(state.editableCalls.at(-1)?.queryEnabled).toBe(false);
  });

  it("keeps the new image side for a binary rename from old.txt to new.png without fetching the old side", () => {
    const changed = changedFile({
      path: "assets/new.png",
      previousPath: "assets/old.txt",
      status: "renamed",
      isBinary: true,
    });

    renderTile(changed);

    expect(screen.getAllByTestId("image-preview-side")).toHaveLength(1);
    expect(
      screen.getByText("This file is not one of the supported image formats."),
    ).toBeTruthy();
    expect(
      state.assetRequests.filter((request) => request?.method === "git"),
    ).toEqual([expect.objectContaining({ side: "new" })]);
  });

  // Live E2E (ticket 06) found a real conflicted binary image falling
  // through to the old generic BinaryPlaceholder instead of ImageDiffView.
  // The host's bulk listChangedFiles numstat path has no MERGE_HEAD-aware
  // fallback for unmerged paths (unlike its single-file getFileDiff path),
  // so `isBinary: false` is the REAL shape a two-sided binary UU conflict
  // can carry here - this pins the dispatch against that exact shape, not
  // an idealized isBinary: true. The existing ImageDiffView-level Conflicted
  // badge test doesn't cover this: it never exercises the GitChangedFile ->
  // routing dispatch this test targets.
  it("routes a conflicted image to ImageDiffView with the Conflicted badge even when isBinary is false", () => {
    const changed = changedFile({
      path: "assets/conflict.png",
      status: "conflicted",
      stage: "conflicted",
      isBinary: false,
    });

    renderTile(changed);

    expect(screen.getAllByTestId("image-preview-side")).toHaveLength(2);
    expect(screen.getByText("Conflicted")).toBeTruthy();
    expect(screen.queryByTestId("binary-placeholder")).toBeNull();
    expect(
      state.assetRequests.filter((request) => request?.method === "git"),
    ).toEqual([
      expect.objectContaining({ side: "old", stage: "staged" }),
      expect.objectContaining({ side: "new", stage: "unstaged" }),
    ]);
  });
});
