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

vi.mock("../file-list", () => ({
  FileList: (props: {
    readonly runningDir: string;
    readonly files: ReadonlyArray<GitChangedFileV11>;
    readonly hideEmptySections: boolean;
  }) => (
    <div
      data-testid={`file-list-${props.runningDir}`}
      data-hide-empty-sections={props.hideEmptySections ? "true" : "false"}
    >
      {props.files.map((changedFile) => (
        <span
          key={changedFile.path}
          data-testid={`file-row-${props.runningDir}-${changedFile.path}`}
        >
          {changedFile.path}
        </span>
      ))}
    </div>
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

const cleanPointer: SubmodulePointer = {
  ...normalPointer,
  recordedPinSha: "2222222222",
  diverged: false,
  commitChanged: false,
  modifiedContent: false,
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

function renderChanges(props: {
  readonly subscription?: GitListChangedFilesSubscriptionResult;
  readonly snapshot: GitListChangedFilesWithSubmodulesResult;
  readonly onRefresh?: () => void;
}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <SelectedRepoChanges
        epicId="epic-1"
        viewTabId="tab-1"
        selected={rootSelected}
        rootLabel="traycer-internal"
        subscription={props.subscription ?? EMPTY_SUBSCRIPTION}
        snapshot={props.snapshot}
        onRefresh={props.onRefresh ?? vi.fn()}
        isRefreshing={false}
      />
    </QueryClientProvider>,
  );
}

describe("<SelectedRepoChanges /> module groups", () => {
  beforeEach(() => cleanup());

  it("renders root-only changes in the root module", () => {
    renderChanges({
      snapshot: snapshotResult(response({ files: [file("src/app.ts", null)] })),
    });

    expect(screen.getByTestId("git-module-group-root")).toBeDefined();
    expect(screen.getByTestId("git-module-count-root").textContent).toBe(
      "1 file",
    );
    expect(screen.getByTestId("file-list-/repo")).toBeDefined();
    expect(screen.getByText("src/app.ts")).toBeDefined();
    expect(screen.queryByText("Submodule reference:")).toBeNull();
  });

  it("renders dirty submodule-only changes below a clean root module", () => {
    renderChanges({
      snapshot: snapshotResult(
        response({
          files: [file("traycer", normalPointer)],
          submodules: [changeset({ files: [file("src/submodule.ts", null)] })],
        }),
      ),
    });

    expect(screen.getByTestId("git-module-no-changes-root")).toBeDefined();
    expect(
      screen.getByTestId("git-module-group-submodule-traycer"),
    ).toBeDefined();
    expect(
      screen.getByTestId("git-module-parent-reference-traycer").textContent,
    ).toBe("parent ref differs");
    expect(screen.getByTestId("file-list-/repo/traycer")).toBeDefined();
    expect(screen.getByText("src/submodule.ts")).toBeDefined();
    expect(screen.queryByText("Submodule reference:")).toBeNull();
    expect(screen.queryByTestId("file-row-/repo-traycer")).toBeNull();
  });

  it("gives non-empty module lists a flex-height body for virtualized rows", () => {
    renderChanges({
      snapshot: snapshotResult(
        response({
          files: [file("traycer", normalPointer)],
          submodules: [changeset({ files: [file("src/submodule.ts", null)] })],
        }),
      ),
    });

    const fileList = screen.getByTestId("file-list-/repo/traycer");
    const body = fileList.parentElement;
    if (body === null) {
      throw new Error("Expected module file list to have a body wrapper");
    }

    expect(body.className).toContain("flex");
    expect(body.className).toContain("min-h-[32dvh]");
    expect(body.className).toContain("max-h-[58dvh]");
    expect(body.className).toContain("flex-col");
    expect(body.className).toContain("overflow-hidden");
  });

  it("renders root and dirty submodule changes as separate module-owned lists", () => {
    renderChanges({
      snapshot: snapshotResult(
        response({
          files: [file("src/app.ts", null), file("traycer", normalPointer)],
          submodules: [
            changeset({ files: [file("clients/gui-app/src/view.tsx", null)] }),
          ],
        }),
      ),
    });

    expect(screen.getByTestId("file-list-/repo")).toBeDefined();
    expect(screen.getByTestId("file-list-/repo/traycer")).toBeDefined();
    expect(screen.getByText("src/app.ts")).toBeDefined();
    expect(screen.getByText("clients/gui-app/src/view.tsx")).toBeDefined();
    expect(screen.queryByTestId("file-row-/repo-traycer")).toBeNull();
  });

  it("shows a parent-reference mismatch on a clean submodule working tree", () => {
    renderChanges({
      snapshot: snapshotResult(
        response({
          files: [file("traycer", normalPointer)],
          submodules: [changeset({ files: [] })],
        }),
      ),
    });

    expect(
      screen.getByTestId("git-module-parent-reference-traycer").textContent,
    ).toBe("parent ref differs");
    expect(screen.getByTestId("git-module-count-traycer").textContent).toBe(
      "0 files",
    );
    expect(screen.getByTestId("git-module-no-changes-traycer")).toBeDefined();
    expect(screen.queryByTestId("git-clean-modules-affordance")).toBeNull();
  });

  it("renders an unavailable submodule module group with refresh", () => {
    renderChanges({
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
    });

    expect(
      screen.getByTestId("git-module-group-submodule-traycer"),
    ).toBeDefined();
    expect(
      screen.getByTestId("git-module-parent-reference-traycer").textContent,
    ).toBe("details unavailable");
    expect(screen.getByTestId("git-submodule-unavailable")).toBeDefined();
  });

  it("keeps clean modules collapsed behind the clean-modules affordance", () => {
    renderChanges({
      snapshot: snapshotResult(
        response({
          submodules: [
            changeset({
              pointer: cleanPointer,
            }),
          ],
        }),
      ),
    });

    expect(
      screen.queryByTestId("git-module-group-submodule-traycer"),
    ).toBeNull();
    const affordance = screen.getByTestId("git-clean-modules-affordance");
    expect(affordance.textContent).toContain("Show 1 clean Git module");

    fireEvent.click(affordance);

    const cleanModule = screen.getByTestId(
      "git-module-group-submodule-traycer",
    );
    expect(cleanModule.getAttribute("data-clean")).toBe("true");
    expect(
      screen
        .getByTestId("git-module-header-traycer")
        .getAttribute("aria-expanded"),
    ).toBe("false");
  });

  it("turns an unmatched dirty gitlink into an unavailable module group", () => {
    renderChanges({
      snapshot: snapshotResult(
        response({ files: [file("traycer", normalPointer)], submodules: [] }),
      ),
    });

    expect(
      screen.getByTestId("git-module-group-submodule-traycer"),
    ).toBeDefined();
    expect(screen.getByTestId("git-submodule-unavailable")).toBeDefined();
    expect(screen.queryByText("Submodule reference:")).toBeNull();
    expect(screen.queryByTestId("file-row-/repo-traycer")).toBeNull();
  });

  it("renders old-host parent-only snapshots without submodule metadata as root file rows", () => {
    renderChanges({
      snapshot: snapshotResult(
        response({ files: [file("traycer", null)], submodules: [] }),
      ),
    });

    expect(screen.getByTestId("git-module-group-root")).toBeDefined();
    expect(screen.getByTestId("file-row-/repo-traycer")).toBeDefined();
    expect(
      screen.queryByTestId("git-module-group-submodule-traycer"),
    ).toBeNull();
    expect(screen.queryByText("Submodule reference:")).toBeNull();
  });
});
