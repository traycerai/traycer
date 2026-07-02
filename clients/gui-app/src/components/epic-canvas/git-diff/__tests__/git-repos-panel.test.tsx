import { describe, it, expect, vi, beforeEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type {
  GitChangedFileV11,
  SubmoduleChangeset,
} from "@traycer/protocol/host";
import {
  composeGitRepos,
  type GitReposComposition,
} from "@/lib/git/git-repo-composition";
import { GitReposPanel } from "../git-repos-panel";

// Stub the parent file body: it pulls the virtualized FileList (Virtuoso + dnd),
// which is out of scope here - this suite exercises the panel's own layout.
vi.mock("../git-changed-files-view", () => ({
  GitChangedFilesView: () => <div data-testid="parent-file-list" />,
}));

function file(
  path: string,
  gitlink: GitChangedFileV11["gitlink"],
): GitChangedFileV11 {
  return {
    path,
    previousPath: null,
    status: "modified",
    stage: "unstaged",
    isBinary: false,
    insertions: 1,
    deletions: 0,
    sizeBytes: 10,
    stagedOid: null,
    worktreeOid: null,
    gitlink,
  };
}

const aheadChangeset: SubmoduleChangeset = {
  repoRoot: "/repo/traycer",
  parentPath: "traycer",
  branch: null,
  repoState: { kind: "clean" },
  relation: {
    state: "ahead",
    recordedPinSha: "1111111111",
    submoduleHeadSha: "2222222222",
    commitsAhead: { count: 1, files: [] },
  },
  files: [],
};

function composition(overrides: {
  files: ReadonlyArray<GitChangedFileV11>;
  submodules: ReadonlyArray<SubmoduleChangeset>;
}) {
  return composeGitRepos({
    runningDir: "/repo/traycer-internal",
    label: "traycer-internal",
    branch: "development",
    headSha: "deadbeefcafe",
    repoState: { kind: "clean" },
    files: overrides.files,
    submodules: overrides.submodules,
  });
}

function renderPanel(comp: GitReposComposition) {
  return render(
    <GitReposPanel
      epicId="epic-1"
      viewTabId="tab-1"
      hostId="host-1"
      runningDir="/repo/traycer-internal"
      composition={comp}
      repoMode="normal"
      onRefresh={vi.fn()}
      isRefreshing={false}
    />,
  );
}

describe("<GitReposPanel />", () => {
  beforeEach(() => cleanup());

  it("renders the parent header, separated counts, the parent file body, and a submodule section", () => {
    renderPanel(
      composition({
        files: [
          file("src/app.ts", null),
          file("traycer", {
            kind: "normal",
            recordedPinSha: "1111111111",
            stagedPinSha: null,
            commitChanged: true,
            modifiedContent: false,
            untrackedContent: false,
          }),
        ],
        submodules: [aheadChangeset],
      }),
    );

    expect(screen.getByText("traycer-internal")).toBeDefined();
    expect(screen.getByTestId("git-parent-counts").textContent).toBe(
      "1 file · 1 submodule reference",
    );
    expect(screen.getByTestId("parent-file-list")).toBeDefined();
    expect(screen.getByTestId("submodule-reference-row-traycer")).toBeDefined();
    expect(screen.getByTestId("submodule-repo-section-traycer")).toBeDefined();
  });

  it("omits the parent file body when the parent has no ordinary files", () => {
    renderPanel(
      composition({
        files: [
          file("traycer", {
            kind: "normal",
            recordedPinSha: "1111111111",
            stagedPinSha: null,
            commitChanged: true,
            modifiedContent: false,
            untrackedContent: false,
          }),
        ],
        submodules: [aheadChangeset],
      }),
    );

    expect(screen.queryByTestId("parent-file-list")).toBeNull();
    expect(screen.getByTestId("git-parent-counts").textContent).toBe(
      "0 files · 1 submodule reference",
    );
    expect(screen.getByTestId("submodule-repo-section-traycer")).toBeDefined();
  });
});
