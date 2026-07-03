import { describe, it, expect, vi, beforeEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  GitChangedFileV11,
  GitListChangedFilesResponseV11,
  SubmoduleChangeset,
  SubmodulePointer,
} from "@traycer/protocol/host";
import type { GitListChangedFilesSubscriptionResult } from "@/hooks/git/use-git-list-changed-files-subscription";
import type { GitListChangedFilesWithSubmodulesResult } from "@/hooks/git/use-git-list-changed-files-with-submodules";
import type { GitPanelSelectedRepo } from "@/stores/epics/git-panel-store";
import { SelectedRepoChanges } from "../selected-repo-changes";

// Stub the parent file body (Virtuoso + dnd is out of scope); expose the
// `runningDir` it is scoped to so we can assert the SAME parent component renders
// for both the root and a submodule (the parity fix).
vi.mock("../git-changed-files-view", () => ({
  GitChangedFilesView: (props: { runningDir: string }) => (
    <div data-testid="changes-view" data-running-dir={props.runningDir} />
  ),
}));

const normalPointer: SubmodulePointer = {
  kind: "normal",
  recordedPinSha: "1111111111",
  submoduleHeadSha: "2222222222",
  diverged: true,
  commitChanged: true,
  modifiedContent: true,
  untrackedContent: false,
};

function file(
  path: string,
  gitlink: SubmodulePointer | null,
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

function changeset(overrides: Partial<SubmoduleChangeset>): SubmoduleChangeset {
  return {
    repoRoot: "/repo/traycer",
    parentPath: "traycer",
    branch: "main",
    repoState: { kind: "clean" },
    files: [],
    pointer: normalPointer,
    availability: { state: "ok" },
    ...overrides,
  };
}

function response(
  overrides: Partial<GitListChangedFilesResponseV11>,
): GitListChangedFilesResponseV11 {
  return {
    runningDir: "/repo",
    headSha: "deadbeefcafe",
    branch: "development",
    files: [],
    fingerprint: "fp",
    repoMode: "normal",
    repoState: { kind: "clean" },
    submodules: [],
    ...overrides,
  };
}

const EMPTY_SUBSCRIPTION: GitListChangedFilesSubscriptionResult = {
  data: null,
  error: null,
  isPending: false,
  repoState: null,
  repoMode: null,
  pollStartedAtMs: null,
};

function snapshotResult(
  data: GitListChangedFilesResponseV11 | null,
): GitListChangedFilesWithSubmodulesResult {
  return { data, isPending: false, error: null };
}

const rootSelected: GitPanelSelectedRepo = {
  hostId: "host-1",
  rootRunningDir: "/repo",
  repoRoot: "/repo",
};
const submoduleSelected: GitPanelSelectedRepo = {
  hostId: "host-1",
  rootRunningDir: "/repo",
  repoRoot: "/repo/traycer",
};

function renderChanges(props: {
  selected: GitPanelSelectedRepo;
  subscription?: GitListChangedFilesSubscriptionResult;
  snapshot: GitListChangedFilesWithSubmodulesResult;
  onSelectSubmoduleRepoRoot?: (repoRoot: string) => void;
  onRefresh?: () => void;
}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <SelectedRepoChanges
        epicId="epic-1"
        viewTabId="tab-1"
        selected={props.selected}
        subscription={props.subscription ?? EMPTY_SUBSCRIPTION}
        snapshot={props.snapshot}
        onSelectSubmoduleRepoRoot={props.onSelectSubmoduleRepoRoot ?? vi.fn()}
        onRefresh={props.onRefresh ?? vi.fn()}
        isRefreshing={false}
      />
    </QueryClientProvider>,
  );
}

describe("<SelectedRepoChanges />", () => {
  beforeEach(() => cleanup());

  it("root view renders the parent changes-view (ordinary files) and a demoted reference row", () => {
    const onSelectSubmoduleRepoRoot = vi.fn();
    renderChanges({
      selected: rootSelected,
      snapshot: snapshotResult(
        response({
          files: [file("src/app.ts", null), file("traycer", normalPointer)],
          submodules: [changeset({})],
        }),
      ),
      onSelectSubmoduleRepoRoot,
    });
    const view = screen.getByTestId("changes-view");
    expect(view.getAttribute("data-running-dir")).toBe("/repo");
    // The gitlink row is demoted to a reference row, never a file row.
    const ref = screen.getByTestId("submodule-reference-row-traycer");
    expect(ref).toBeDefined();
    fireEvent.click(
      screen.getByRole("button", {
        name: /Submodule reference:\s*traycer\s*parent references 1111111/,
      }),
    );
    expect(onSelectSubmoduleRepoRoot).toHaveBeenCalledWith("/repo/traycer");
  });

  it("old-host degrade: dirty gitlink with submodules:[] surfaces a details-unavailable reference row", () => {
    renderChanges({
      selected: rootSelected,
      snapshot: snapshotResult(
        response({ files: [file("traycer", normalPointer)], submodules: [] }),
      ),
    });
    expect(screen.getByTestId("submodule-reference-row-traycer")).toBeDefined();
    expect(
      screen.getByTestId("submodule-reference-refresh-traycer"),
    ).toBeDefined();
  });

  it("root view: an unavailable matching section degrades the reference row (still navigable)", () => {
    const onSelectSubmoduleRepoRoot = vi.fn();
    renderChanges({
      selected: rootSelected,
      snapshot: snapshotResult(
        response({
          files: [file("traycer", normalPointer)],
          submodules: [
            changeset({
              availability: { state: "unavailable", reason: "git-error" },
            }),
          ],
        }),
      ),
      onSelectSubmoduleRepoRoot,
    });
    expect(
      screen.getByTestId("submodule-reference-refresh-traycer"),
    ).toBeDefined();
    // Still navigable to the (unavailable) submodule node.
    fireEvent.click(
      screen.getByRole("button", {
        name: /Submodule reference:\s*traycer\s*parent references 1111111/,
      }),
    );
    expect(onSelectSubmoduleRepoRoot).toHaveBeenCalledWith("/repo/traycer");
  });

  it("submodule view renders the SAME parent changes-view scoped to the submodule repoRoot (parity)", () => {
    renderChanges({
      selected: submoduleSelected,
      snapshot: snapshotResult(
        response({
          submodules: [changeset({ files: [file("src/foo.ts", null)] })],
        }),
      ),
    });
    const view = screen.getByTestId("changes-view");
    expect(view.getAttribute("data-running-dir")).toBe("/repo/traycer");
  });

  it("submodule view with availability:unavailable renders the details-unavailable degrade", () => {
    renderChanges({
      selected: submoduleSelected,
      snapshot: snapshotResult(
        response({
          submodules: [
            changeset({
              availability: { state: "unavailable", reason: "git-error" },
            }),
          ],
        }),
      ),
    });
    expect(screen.getByTestId("git-submodule-unavailable")).toBeDefined();
    expect(screen.queryByTestId("changes-view")).toBeNull();
  });
});
