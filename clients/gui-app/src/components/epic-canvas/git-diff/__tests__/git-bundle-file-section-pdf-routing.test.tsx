/**
 * PDF routing in BUNDLE diff rows: the aggregated view composes the same
 * per-type views as the single-file tile (the image branch is the
 * precedent), so a .pdf row renders the compact summary block by extension
 * alone - there is no host-version gate on this routing decision.
 */
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
  FileAssetRequest,
  FileAssetState,
} from "@/hooks/assets/use-file-asset";
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

const state = vi.hoisted(
  (): {
    requests: Array<FileAssetRequest | null>;
    coverage: Mock;
    asset: FileAssetState | null;
  } => ({
    requests: [],
    coverage: vi.fn(),
    asset: null,
  }),
);

vi.mock("@/hooks/assets/use-file-asset", () => ({
  useFileAsset: (request: FileAssetRequest | null): FileAssetState => {
    state.requests.push(request);
    if (state.asset === null) throw new Error("missing asset state");
    return state.asset;
  },
}));

// `git-bundle-file-section.tsx` no longer imports `useHostMethodSchemaVersion`
// - `routeToPdfCards` is decided purely by `gitRoutesToPdfDiffCards(file)`.
// `useHostSupportsMethod` stays mocked defensively; nothing in this render
// tree currently calls it, but `PdfDiffView` shares the module with code
// paths that do.
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostSupportsMethod: () => false,
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
    notifySectionMounted: vi.fn(),
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
  readonly isBinary: boolean;
  readonly status?: GitChangedFile["status"];
  readonly stage?: GitChangedFile["stage"];
}): GitChangedFile {
  return {
    path: args.path,
    previousPath: null,
    status: args.status ?? "modified",
    stage: args.stage ?? "unstaged",
    insertions: 1,
    deletions: 1,
    isBinary: args.isBinary,
    sizeBytes: 2_048,
    stagedOid: null,
    worktreeOid: "worktree-1",
  };
}

function node(): GitBundleDiffTileRef {
  const bundle = makeGitBundleDiffTile({
    hostId: "host-A",
    runningDir: "/work/repo",
    bundleGroup: "changes",
    repositoryContext: null,
  });
  if (bundle.diff.kind !== "bundle") {
    throw new Error("expected bundle node");
  }
  return { ...bundle, diff: bundle.diff, view: bundle.view };
}

function renderSection(changedFile: GitChangedFile): RenderResult {
  return render(
    <BundleFileSection
      node={node()}
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
  state.asset = {
    status: "ready",
    url: "blob:pdf",
    meta: null,
    reason: null,
    totalBytes: 1,
    servedFromCache: false,
  };
});

afterEach(() => {
  cleanup();
});

describe("<BundleFileSection /> PDF routing", () => {
  // No host-version gate remains here: `routeToPdfCards` is decided purely
  // by `gitRoutesToPdfDiffCards(file)`, so this single test now covers what
  // used to be split across a known-1.1, an unknown-handshake, and a
  // known-1.0 case.
  it("routes a binary PDF row to the summary cards", () => {
    renderSection(file({ path: "docs/report.pdf", isBinary: true }));

    expect(screen.getByTestId("pdf-diff-block")).toBeTruthy();
    expect(screen.queryByText("Binary file")).toBeNull();
    expect(screen.queryByTestId("bundle-file-diff")).toBeNull();
    // Cards are metadata-only - the closed dialog must not fetch a side.
    expect(state.requests.every((request) => request === null)).toBe(true);
    expect(state.coverage).toHaveBeenCalledWith(
      expect.stringContaining("docs/report.pdf"),
      "binary",
    );
  });

  it("routes an ASCII-authored (non-binary) PDF row to the cards, not the text diff", () => {
    renderSection(file({ path: "docs/test-diff.pdf", isBinary: false }));

    expect(screen.getByTestId("pdf-diff-block")).toBeTruthy();
    expect(screen.queryByTestId("bundle-file-diff")).toBeNull();
  });

  it("keeps non-PDF binary rows on the bundle placeholder", () => {
    renderSection(file({ path: "assets/archive.zip", isBinary: true }));

    expect(screen.queryByTestId("pdf-diff-block")).toBeNull();
    expect(screen.getByText("Binary file")).toBeTruthy();
  });
});
