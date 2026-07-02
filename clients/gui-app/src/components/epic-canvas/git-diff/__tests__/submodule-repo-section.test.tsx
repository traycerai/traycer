import { describe, it, expect, beforeEach, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type {
  GitChangedFileV11,
  SubmoduleRelation,
} from "@traycer/protocol/host";
import {
  composeGitRepos,
  type SubmoduleRepoView,
} from "@/lib/git/git-repo-composition";
import {
  isGitDiffTileRef,
  type EpicCanvasTileRef,
  type GitDiffTilePayload,
} from "@/stores/epics/canvas/types";
import { SubmoduleRepoSection } from "../submodule-repo-section";

type OpenTile = (tabId: string, node: EpicCanvasTileRef) => void;
const openPreview = vi.hoisted(() => vi.fn<OpenTile>());
const openPinned = vi.hoisted(() => vi.fn<OpenTile>());

// The row wrappers read two open actions off the canvas store; capture them so we
// can assert the exact tile payload each row routes to.
vi.mock("@/stores/epics/canvas/store", () => ({
  useEpicCanvasStore: (selector: (state: unknown) => unknown) =>
    selector({
      openTilePreviewInTab: openPreview,
      openTileInTab: openPinned,
    }),
}));

function wtFile(
  path: string,
  stage: GitChangedFileV11["stage"],
): GitChangedFileV11 {
  return {
    path,
    previousPath: null,
    status: "modified",
    stage,
    isBinary: false,
    insertions: 4,
    deletions: 1,
    sizeBytes: 20,
    stagedOid: null,
    worktreeOid: null,
    gitlink: null,
  };
}

function buildView(
  relation: SubmoduleRelation,
  files: GitChangedFileV11[],
): SubmoduleRepoView {
  const result = composeGitRepos({
    runningDir: "/repo",
    label: "repo",
    branch: "development",
    headSha: "deadbeef",
    repoState: { kind: "clean" },
    files: [],
    submodules: [
      {
        repoRoot: "/repo/traycer",
        parentPath: "nested/traycer",
        branch: relation.state === "unknown" ? null : "main",
        repoState: { kind: "clean" },
        relation,
        files,
      },
    ],
  });
  return result.submodules[0];
}

function renderSection(view: SubmoduleRepoView) {
  return render(
    <SubmoduleRepoSection
      view={view}
      hostId="host-1"
      viewTabId="tab-1"
      parentRunningDir="/repo"
    />,
  );
}

function openedDiff(mock: typeof openPreview): GitDiffTilePayload {
  expect(mock).toHaveBeenCalledTimes(1);
  const tile = mock.mock.calls[0][1];
  if (!isGitDiffTileRef(tile)) {
    throw new Error("expected a git diff tile ref");
  }
  return tile.diff;
}

describe("<SubmoduleRepoSection />", () => {
  beforeEach(() => {
    cleanup();
    openPreview.mockReset();
    openPinned.mockReset();
  });

  it("renders the ahead group with commit files plus the worktree files", () => {
    const view = buildView(
      {
        state: "ahead",
        recordedPinSha: "1111111111",
        submoduleHeadSha: "2222222222",
        commitsAhead: {
          count: 2,
          files: [
            {
              path: "committed.ts",
              previousPath: null,
              status: "added",
              isBinary: false,
              insertions: 10,
              deletions: 0,
            },
          ],
        },
      },
      [wtFile("worktree.ts", "unstaged")],
    );
    renderSection(view);

    // Label is the full submodule path, not the basename (disambiguates nested).
    expect(screen.getByText("nested/traycer")).toBeDefined();
    expect(screen.getByText("main")).toBeDefined();
    expect(
      screen.getByText("Committed changes not recorded by parent (2 commits)"),
    ).toBeDefined();
    expect(screen.getByTestId("submodule-file-row-committed.ts")).toBeDefined();
    expect(screen.getByTestId("submodule-file-row-worktree.ts")).toBeDefined();
  });

  it("routes a worktree file to a `file` tile under the submodule repoRoot (compareFromSha null)", () => {
    const view = buildView(
      {
        state: "equal",
        recordedPinSha: "1111111111",
        submoduleHeadSha: "1111111111",
      },
      [wtFile("worktree.ts", "unstaged")],
    );
    renderSection(view);

    fireEvent.click(screen.getByTestId("submodule-file-row-worktree.ts"));
    const diff = openedDiff(openPreview);
    // Runs the diff inside the submodule, never the parent - and a plain (non
    // ahead-of-pin) working-tree diff.
    expect(diff).toEqual({
      kind: "file",
      runningDir: "/repo/traycer",
      filePath: "worktree.ts",
      stage: "unstaged",
    });
  });

  it("routes an ahead file to an `ahead-file` tile carrying the parent worktree, not a pin", () => {
    const view = buildView(
      {
        state: "ahead",
        recordedPinSha: "1111111111",
        submoduleHeadSha: "2222222222",
        commitsAhead: {
          count: 1,
          files: [
            {
              path: "committed.ts",
              previousPath: null,
              status: "added",
              isBinary: false,
              insertions: 10,
              deletions: 0,
            },
          ],
        },
      },
      [],
    );
    renderSection(view);

    // Double-click opens a pinned tile.
    fireEvent.doubleClick(screen.getByTestId("submodule-file-row-committed.ts"));
    const diff = openedDiff(openPinned);
    // The pin is deliberately absent - it is re-derived from fresh v1.1 metadata
    // fetched against `parentRunningDir` at diff time (the gate).
    expect(diff).toEqual({
      kind: "ahead-file",
      runningDir: "/repo/traycer",
      parentRunningDir: "/repo",
      filePath: "committed.ts",
    });
    expect(JSON.stringify(diff)).not.toContain("1111111111");
  });

  it("renders the checkout-differs bucket banner for a behind relation (no relation file group)", () => {
    const view = buildView(
      {
        state: "behind",
        recordedPinSha: "1111111111",
        submoduleHeadSha: "2222222222",
      },
      [wtFile("worktree.ts", "unstaged")],
    );
    renderSection(view);

    expect(
      screen.getByText("Checkout differs from parent reference"),
    ).toBeDefined();
    expect(
      screen.queryByText(/Committed changes not recorded by parent/),
    ).toBeNull();
    // The submodule's own worktree files still render regardless of relation.
    expect(screen.getByTestId("submodule-file-row-worktree.ts")).toBeDefined();
  });

  it("renders the needs-attention bucket for an unknown relation as a local limit", () => {
    const view = buildView(
      {
        state: "unknown",
        reason: "missing-pin-object",
        recordedPinSha: "1111111111",
        submoduleHeadSha: null,
      },
      [],
    );
    renderSection(view);

    expect(screen.getByText("Reference needs attention")).toBeDefined();
    expect(screen.getByText(/Not comparable locally/)).toBeDefined();
    expect(screen.queryByText(/host/i)).toBeNull();
  });
});
