import type { ReactNode } from "react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import {
  cleanup,
  render,
  screen,
  type RenderResult,
} from "@testing-library/react";
import type { GitChangedFile } from "@traycer/protocol/host";
import type {
  ImageAssetRequest,
  ImageAssetState,
} from "@/hooks/assets/use-image-asset";
import type { DiffViewerPreferences } from "@/lib/diff/diff-viewer-preferences";
import { makeGitBundleDiffTile } from "@/lib/git/git-diff-tile";
import type { GitBundleDiffTileRef } from "../git-diff-tile-shared";

const PREFERENCES: DiffViewerPreferences = {
  mode: "split",
  wordWrap: false,
  ignoreWhitespace: false,
  backgrounds: true,
  lineNumbers: true,
  indicatorStyle: "bars",
};

const state = vi.hoisted(() => ({
  requests: [] as Array<ImageAssetRequest | null>,
  coverage: vi.fn(),
  mounted: vi.fn(),
  asset: null as ImageAssetState | null,
}));

vi.mock("@/hooks/assets/use-image-asset", () => ({
  useImageAsset: (request: ImageAssetRequest | null): ImageAssetState => {
    state.requests.push(request);
    if (state.asset === null) throw new Error("missing image state");
    return state.asset;
  },
}));

vi.mock("@/components/epic-canvas/image-preview/image-preview", () => ({
  ImagePreview: (props: {
    readonly compact: boolean;
    readonly fitOverride: string | null;
  }) => (
    <div
      data-testid="bundle-image-preview"
      data-compact={String(props.compact)}
      data-fit={props.fitOverride ?? "null"}
    />
  ),
}));

vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => null,
}));

vi.mock("@/lib/epic-selectors", () => ({
  useOpenEpicId: () => "epic-1",
}));

vi.mock("@/hooks/epic/use-epic-nested-focus-navigation", () => ({
  useEpicNestedFocusNavigation: () => vi.fn(),
}));

vi.mock("@/stores/epics/canvas/store", () => ({
  useEpicCanvasStore: <T,>(
    selector: (store: {
      readonly prepareOpenFileTileInTabFocusTarget: Mock;
      readonly prepareOpenTabFocusTarget: Mock;
      readonly toggleGitDiffBundleFileCollapsedInTab: Mock;
    }) => T,
  ): T =>
    selector({
      prepareOpenFileTileInTabFocusTarget: vi.fn(),
      prepareOpenTabFocusTarget: vi.fn(),
      toggleGitDiffBundleFileCollapsedInTab: vi.fn(),
    }),
}));

vi.mock("@/components/diff/bundle-diff-find-registration-hooks", () => ({
  useBundleDiffFindRegistrationContext: () => ({
    registerCoverageState: state.coverage,
    notifySectionMounted: state.mounted,
    registerLoadedPatch: vi.fn(),
    unregisterLoadedPatch: vi.fn(),
  }),
}));

vi.mock("@/components/epic-canvas/git-diff/diff-bundle-file-section", () => ({
  DiffBundleFileSectionFrame: (props: {
    readonly collapsed: boolean;
    readonly headerRow: ReactNode;
    readonly headerStats: ReactNode;
    readonly onOpenFileTile: () => void;
    readonly children: ReactNode;
  }) => (
    <div data-testid="bundle-file-section">
      {props.headerRow}
      {props.headerStats}
      {props.collapsed ? null : props.children}
    </div>
  ),
  DiffBundleFileHeaderPortal: (props: { readonly children: ReactNode }) =>
    props.children,
  DiffBundleCollapseChevron: () => null,
}));

vi.mock("@/components/epic-canvas/git-diff/git-changed-file-row", () => ({
  GitChangedFileRow: (props: {
    readonly file: GitChangedFile;
    readonly onClick: () => void;
    readonly ariaExpanded: boolean;
  }) => (
    <button
      type="button"
      aria-expanded={props.ariaExpanded}
      onClick={props.onClick}
    >
      {props.file.path}
    </button>
  ),
  GitChangedFileStats: () => null,
}));

vi.mock("@/components/epic-canvas/git-diff/file-diff-content", () => ({
  FileDiffContent: () => <div data-testid="bundle-file-diff" />,
}));

vi.mock(
  "@/components/epic-canvas/git-diff/diff-content-loading-skeleton",
  () => ({
    DiffContentLoadingSkeleton: () => <div data-testid="bundle-loading" />,
  }),
);

vi.mock("@/components/epic-canvas/git-diff/git-error-block", () => ({
  GitErrorBlock: () => <div data-testid="bundle-error" />,
}));

vi.mock("@/components/epic-canvas/git-diff/git-diff-edit-status", () => ({
  GitDiffEditStatusContent: () => null,
}));

vi.mock("@/components/epic-canvas/git-diff/git-diff-editing", () => ({
  useEditableGitDiffSurface: () => ({
    displayedDiff: undefined,
    displayedDiffError: null,
    displayedDiffPending: false,
    editing: {
      canOfferEdit: false,
      editAdapter: undefined,
      editSession: undefined,
    },
    loadFull: vi.fn(),
  }),
}));

vi.mock("@/hooks/git/use-git-get-file-diff-query", () => ({
  useGitGetFileDiffQuery: () => ({
    data: undefined,
    error: null,
    isPending: false,
  }),
}));

vi.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: <T,>(
    selector: (settings: {
      readonly diffViewerPreferences: DiffViewerPreferences;
    }) => T,
  ): T => selector({ diffViewerPreferences: PREFERENCES }),
}));

vi.mock("@/components/epic-canvas/workspace-file/workspace-file-ref", () => ({
  workspaceFileRefFromTreePath: () => null,
}));

import { BundleFileSection } from "../git-bundle-file-section";

function file(args: {
  readonly path: string;
  readonly previousPath?: string | null;
  readonly isBinary: boolean;
  readonly status?: GitChangedFile["status"];
  readonly stage?: GitChangedFile["stage"];
}): GitChangedFile {
  return {
    path: args.path,
    previousPath: args.previousPath ?? null,
    status: args.status ?? "modified",
    stage: args.stage ?? "unstaged",
    insertions: 1,
    deletions: 1,
    isBinary: args.isBinary,
    sizeBytes: 1_024,
    stagedOid: null,
    worktreeOid: "worktree-1",
  };
}

function node(collapsedFilePaths: ReadonlyArray<string>): GitBundleDiffTileRef {
  const bundle = makeGitBundleDiffTile({
    hostId: "host-A",
    runningDir: "/work/repo",
    bundleGroup: "changes",
    repositoryContext: null,
  });
  if (bundle.diff.kind !== "bundle") {
    throw new Error("expected bundle node");
  }
  return {
    ...bundle,
    diff: bundle.diff,
    view: { ...bundle.view, collapsedFilePaths },
  };
}

function renderSection(
  changedFile: GitChangedFile,
  bundleNode: GitBundleDiffTileRef,
): RenderResult {
  return render(
    <BundleFileSection
      node={bundleNode}
      viewTabId="view-1"
      file={changedFile}
      headSha="head-1"
      diffViewerPreferences={PREFERENCES}
      isActive
    />,
  );
}

beforeEach(() => {
  state.requests.length = 0;
  state.coverage.mockReset();
  state.mounted.mockReset();
  state.asset = {
    status: "ready",
    url: "blob:image",
    meta: null,
    reason: null,
    totalBytes: 1,
    servedFromCache: false,
  };
});

afterEach(() => {
  cleanup();
});

describe("<BundleFileSection /> image routing", () => {
  it("routes binary image files to compact ImageDiffView", () => {
    const changedFile = file({ path: "assets/photo.png", isBinary: true });
    renderSection(changedFile, node([]));

    expect(screen.getAllByTestId("bundle-image-preview")).toHaveLength(2);
    expect(
      screen
        .getAllByTestId("bundle-image-preview")
        .every((preview) => preview.getAttribute("data-compact") === "true"),
    ).toBe(true);
    expect(screen.queryByText("Binary file")).toBeNull();
    expect(state.coverage).toHaveBeenCalledWith(
      expect.stringContaining("assets/photo.png"),
      "binary",
    );
  });

  // The compact height bound now lives INSIDE `ImageDiffView` itself (it
  // needs both sides' decoded dimensions, which only it has - see
  // `image-diff-view.test.tsx` for the sizing contract); `ImageDiffView` is
  // mocked at this routing level, so there is no wrapper class to pin here
  // anymore.

  it("routes SVG files to compact ImageDiffView even though git marks them as text", () => {
    const changedFile = file({ path: "assets/icon.svg", isBinary: false });
    renderSection(changedFile, node([]));

    expect(screen.getAllByTestId("bundle-image-preview")).toHaveLength(2);
    expect(screen.queryByTestId("bundle-file-diff")).toBeNull();
    expect(state.coverage).toHaveBeenCalledWith(
      expect.stringContaining("assets/icon.svg"),
      "binary",
    );
  });

  it("routes a binary rename from old.png to new.jpg through both image sides", () => {
    const changedFile = file({
      path: "assets/new.jpg",
      previousPath: "assets/old.png",
      status: "renamed",
      isBinary: true,
    });

    renderSection(changedFile, node([]));

    expect(screen.getAllByTestId("bundle-image-preview")).toHaveLength(2);
    expect(
      state.requests.filter((request) => request?.method === "git"),
    ).toHaveLength(2);
  });

  it("keeps the old image side for old.png to new.txt without fetching the new side", () => {
    const changedFile = file({
      path: "assets/new.txt",
      previousPath: "assets/old.png",
      status: "renamed",
      isBinary: true,
    });

    renderSection(changedFile, node([]));

    expect(screen.getAllByTestId("bundle-image-preview")).toHaveLength(1);
    expect(
      screen.getByText("This file is not one of the supported image formats."),
    ).toBeTruthy();
    expect(
      state.requests.filter((request) => request?.method === "git"),
    ).toEqual([expect.objectContaining({ side: "old" })]);
  });

  it("routes a text SVG rename from old.svg to new.txt without fetching the new side", () => {
    const changedFile = file({
      path: "assets/new.txt",
      previousPath: "assets/old.svg",
      status: "renamed",
      isBinary: false,
    });

    renderSection(changedFile, node([]));

    expect(screen.getAllByTestId("bundle-image-preview")).toHaveLength(1);
    expect(
      screen.getByText("This file is not one of the supported image formats."),
    ).toBeTruthy();
    expect(
      state.requests.filter((request) => request?.method === "git"),
    ).toEqual([expect.objectContaining({ side: "old" })]);
  });

  it("keeps the new image side for old.txt to new.png without fetching the old side", () => {
    const changedFile = file({
      path: "assets/new.png",
      previousPath: "assets/old.txt",
      status: "renamed",
      isBinary: true,
    });

    renderSection(changedFile, node([]));

    expect(screen.getAllByTestId("bundle-image-preview")).toHaveLength(1);
    expect(
      screen.getByText("This file is not one of the supported image formats."),
    ).toBeTruthy();
    expect(
      state.requests.filter((request) => request?.method === "git"),
    ).toEqual([expect.objectContaining({ side: "new" })]);
  });

  it("keeps non-image binary files on the bundle placeholder", () => {
    const changedFile = file({ path: "assets/archive.zip", isBinary: true });
    renderSection(changedFile, node([]));

    expect(screen.getByText("Binary file")).toBeTruthy();
    expect(screen.queryByTestId("bundle-image-preview")).toBeNull();
  });

  it("does not mount image assets while collapsed, then fetches after expansion", () => {
    const changedFile = file({ path: "assets/photo.png", isBinary: true });
    const collapsed = node([changedFile.path]);
    const expanded = node([]);
    const rendered = renderSection(changedFile, collapsed);

    expect(
      state.requests.filter((request) => request?.method === "git"),
    ).toHaveLength(0);

    rendered.rerender(
      <BundleFileSection
        node={expanded}
        viewTabId="view-1"
        file={changedFile}
        headSha="head-1"
        diffViewerPreferences={PREFERENCES}
        isActive
      />,
    );

    expect(
      state.requests.filter((request) => request?.method === "git"),
    ).toHaveLength(2);
    expect(screen.getAllByTestId("bundle-image-preview")).toHaveLength(2);
  });

  // Live E2E (ticket 06) found a real conflicted binary image falling
  // through to the old generic bundle placeholder instead of ImageDiffView.
  // The host's bulk listChangedFiles numstat path has no MERGE_HEAD-aware
  // fallback for unmerged paths, so `isBinary: false` is the REAL shape a
  // two-sided binary UU conflict can carry here - this pins the dispatch
  // against that exact shape, not an idealized isBinary: true.
  it("routes a conflicted image to compact ImageDiffView even when isBinary is false", () => {
    const changedFile = file({
      path: "assets/conflict.png",
      status: "conflicted",
      stage: "conflicted",
      isBinary: false,
    });

    renderSection(changedFile, node([]));

    expect(screen.getAllByTestId("bundle-image-preview")).toHaveLength(2);
    expect(screen.queryByText("Binary file")).toBeNull();
    expect(
      state.requests.filter((request) => request?.method === "git"),
    ).toEqual([
      expect.objectContaining({ side: "old", stage: "staged" }),
      expect.objectContaining({ side: "new", stage: "unstaged" }),
    ]);
  });
});
