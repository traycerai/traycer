import { act } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  GitChangedFileV11,
  GitListChangedFilesResponseV11,
  SubmoduleChangeset,
  SubmodulePointer,
} from "@traycer/protocol/host";
import type { GitListChangedFilesSubscriptionResult } from "@/hooks/git/use-git-list-changed-files-subscription";
import type { GitListChangedFilesWithSubmodulesResult } from "@/hooks/git/use-git-list-changed-files-with-submodules";
import type { GitPanelSelectedRepo } from "@/stores/epics/git-panel-store";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SelectedRepoChanges } from "../selected-repo-changes";
import { expectModuleHeaderTooltip } from "./git-module-header-test-utils";

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

function snapshotResultWithError(
  data: GitListChangedFilesResponseV11 | null,
  error: HostRpcError,
): GitListChangedFilesWithSubmodulesResult {
  return { data, isPending: false, error };
}

function hostRpcError(message: string): HostRpcError {
  return new HostRpcError({
    code: "RPC_ERROR",
    requestId: "request-1",
    method: "git.listChangedFiles",
    message,
    fatalDetails: null,
  });
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
  const renderUi = (nextProps: {
    readonly subscription?: GitListChangedFilesSubscriptionResult;
    readonly snapshot: GitListChangedFilesWithSubmodulesResult;
    readonly onRefresh?: () => void;
  }) => (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={0}>
        <SelectedRepoChanges
          epicId="epic-1"
          viewTabId="tab-1"
          selected={rootSelected}
          rootLabel="traycer-internal"
          subscription={nextProps.subscription ?? EMPTY_SUBSCRIPTION}
          snapshot={nextProps.snapshot}
          onRefresh={nextProps.onRefresh ?? vi.fn()}
          isRefreshing={false}
        />
      </TooltipProvider>
    </QueryClientProvider>
  );
  const result = render(renderUi(props));
  return {
    ...result,
    rerenderChanges: (nextProps: {
      readonly subscription?: GitListChangedFilesSubscriptionResult;
      readonly snapshot: GitListChangedFilesWithSubmodulesResult;
      readonly onRefresh?: () => void;
    }) => result.rerender(renderUi(nextProps)),
  };
}

describe("<SelectedRepoChanges /> module groups", () => {
  beforeEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("renders single-repo changes without a duplicate module header", () => {
    renderChanges({
      snapshot: snapshotResult(response({ files: [file("src/app.ts", null)] })),
    });

    expect(screen.getByTestId("git-single-repo-changes")).toBeDefined();
    expect(screen.queryByTestId("git-module-group-root")).toBeNull();
    expect(screen.queryByTestId("git-module-header-root")).toBeNull();
    expect(screen.getByRole("textbox", { name: "Filter files" })).toBeDefined();
    expect(
      screen.queryByRole("textbox", { name: "Filter submodules and files" }),
    ).toBeNull();
    expect(
      screen
        .getByRole("textbox", { name: "Filter files" })
        .getAttribute("placeholder"),
    ).toBe("Filter files...");
    expect(screen.queryByTestId("git-module-count-root")).toBeNull();
    expect(screen.getByTestId("file-list-/repo")).toBeDefined();
    expect(screen.getByText("src/app.ts")).toBeDefined();
    expect(screen.queryByText("Submodule reference:")).toBeNull();
  });

  it("surfaces initial nested snapshot errors through the git error state", () => {
    renderChanges({
      snapshot: snapshotResultWithError(
        null,
        hostRpcError("initial load failed"),
      ),
    });

    expect(screen.getByText("Diff Loading Error")).toBeDefined();
    expect(screen.getByText("initial load failed")).toBeDefined();
  });

  it("keeps stale changes visible when a nested snapshot refresh fails", () => {
    renderChanges({
      snapshot: snapshotResultWithError(
        response({ files: [file("src/app.ts", null)] }),
        hostRpcError("manual refresh failed"),
      ),
    });

    expect(screen.queryByText("Diff Loading Error")).toBeNull();
    expect(screen.getByTestId("git-snapshot-error-banner")).toBeDefined();
    expect(screen.getByText("manual refresh failed")).toBeDefined();
    expect(screen.getByText("src/app.ts")).toBeDefined();
  });

  it("keeps repository operation banners in single-repo mode", () => {
    renderChanges({
      snapshot: snapshotResult(
        response({
          files: [file("src/app.ts", null)],
          repoState: {
            kind: "merge",
            headRef: "refs/heads/development",
            mergeHeads: ["refs/heads/feature"],
          },
        }),
      ),
    });

    expect(screen.getByTestId("git-single-repo-changes")).toBeDefined();
    expect(screen.queryByTestId("git-module-header-root")).toBeNull();
    expect(screen.getByText("Merge in progress - 0 conflicts")).toBeDefined();
  });

  it("renders the panel empty state for a clean single-repo workspace", () => {
    renderChanges({
      snapshot: snapshotResult(response({ files: [] })),
    });

    expect(screen.getByTestId("git-diff-empty-refresh")).toBeDefined();
    expect(screen.getByText(/^Last updated/)).toBeDefined();
    expect(screen.queryByTestId("git-single-repo-changes")).toBeNull();
    expect(screen.queryByTestId("git-module-group-root")).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Filter files" })).toBeNull();
    expect(screen.queryByTestId("git-module-no-changes-root")).toBeNull();
  });

  it("renders dirty submodule-only changes below a clean root module", async () => {
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
    await expectModuleHeaderTooltip(
      screen.getByTestId("git-module-header-traycer"),
      "pinned commit out of date",
    );
    expect(screen.queryByText("pinned commit out of date")).toBeNull();
    expect(screen.getByTestId("file-list-/repo/traycer")).toBeDefined();
    expect(screen.getByText("src/submodule.ts")).toBeDefined();
    expect(screen.queryByText("Submodule reference:")).toBeNull();
    expect(screen.queryByTestId("file-row-/repo-traycer")).toBeNull();
  });

  it("renders empty modules intrinsically and file modules in compact flow", () => {
    renderChanges({
      snapshot: snapshotResult(
        response({
          files: [file("traycer", normalPointer)],
          submodules: [changeset({ files: [file("src/submodule.ts", null)] })],
        }),
      ),
    });

    const rootGroup = screen.getByTestId("git-module-group-root");
    const submoduleGroup = screen.getByTestId(
      "git-module-group-submodule-traycer",
    );
    const fileList = screen.getByTestId("file-list-/repo/traycer");
    const body = fileList.parentElement;
    if (body === null) {
      throw new Error("Expected module file list to have a body wrapper");
    }

    expect(rootGroup.getAttribute("data-file-body-expanded")).toBe("false");
    expect(submoduleGroup.getAttribute("data-file-body-expanded")).toBe("true");
    expect(submoduleGroup.className).toContain("flex-none");
    expect(submoduleGroup.className).not.toContain("ml-5");
    expect(submoduleGroup.className).not.toContain("border-l");
    expect(within(submoduleGroup).getByText("submodule")).toBeDefined();
    expect(submoduleGroup.className).not.toContain("flex-1");
    expect(submoduleGroup.className).not.toContain("basis-0");
    expect(body.className).toContain("overflow-visible");
    expect(body.className).not.toContain("flex-1");
    expect(body.className).not.toContain("dvh");
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
    expect(
      screen
        .getByTestId("git-module-group-root")
        .getAttribute("data-file-body-expanded"),
    ).toBe("true");
    expect(
      screen
        .getByTestId("git-module-group-submodule-traycer")
        .getAttribute("data-file-body-expanded"),
    ).toBe("true");
    expect(screen.getByText("src/app.ts")).toBeDefined();
    expect(screen.getByText("clients/gui-app/src/view.tsx")).toBeDefined();
    expect(screen.queryByTestId("file-row-/repo-traycer")).toBeNull();
  });

  it("shows a parent-reference mismatch on a clean submodule working tree", async () => {
    renderChanges({
      snapshot: snapshotResult(
        response({
          files: [file("traycer", normalPointer)],
          submodules: [changeset({ files: [] })],
        }),
      ),
    });

    await expectModuleHeaderTooltip(
      screen.getByTestId("git-module-header-traycer"),
      "pinned commit out of date",
    );
    expect(screen.queryByText("pinned commit out of date")).toBeNull();
    expect(screen.getByTestId("git-module-count-traycer").textContent).toBe(
      "0 files",
    );
    expect(screen.getByTestId("git-module-no-changes-traycer")).toBeDefined();
    expect(screen.queryByTestId("git-clean-modules-affordance")).toBeNull();
  });

  it("renders an unavailable submodule module group with refresh", async () => {
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
    const header = screen.getByTestId("git-module-header-traycer");
    expect(header.getAttribute("aria-label")).toContain("details unavailable");
    const tooltipText = await expectModuleHeaderTooltip(
      header,
      "details unavailable",
    );
    expect(tooltipText.match(/Status:/g)).toHaveLength(1);
    expect(screen.queryByText("details unavailable")).toBeNull();
    expect(header.querySelectorAll(".lucide-triangle-alert")).toHaveLength(1);
    expect(
      screen.getByTestId("git-module-parent-reference-traycer").className,
    ).toContain("text-warning");
    expect(screen.getByTestId("git-submodule-unavailable")).toBeDefined();
  });

  it("renders the panel empty state when every discovered module is clean", () => {
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
    expect(screen.queryByTestId("git-clean-modules-affordance")).toBeNull();
    expect(screen.queryByTestId("git-module-no-changes-root")).toBeNull();
    expect(screen.getByTestId("git-diff-empty-refresh")).toBeDefined();
  });

  it("keeps active submodule search visible when every module becomes clean", () => {
    vi.useFakeTimers();
    const view = renderChanges({
      snapshot: snapshotResult(
        response({
          files: [file("traycer", normalPointer)],
          submodules: [changeset({ files: [] })],
        }),
      ),
    });

    fireEvent.change(
      screen.getByRole("textbox", { name: "Filter submodules and files" }),
      { target: { value: "traycer" } },
    );
    act(() => {
      vi.advanceTimersByTime(150);
    });

    view.rerenderChanges({
      snapshot: snapshotResult(
        response({
          submodules: [changeset({ pointer: cleanPointer })],
        }),
      ),
    });

    expect(
      screen.getByRole("textbox", { name: "Filter submodules and files" }),
    ).toBeDefined();
    expect(
      screen.getByTestId("git-module-group-submodule-traycer"),
    ).toBeDefined();
    expect(screen.queryByTestId("git-diff-empty-refresh")).toBeNull();
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

    expect(screen.getByTestId("git-single-repo-changes")).toBeDefined();
    expect(screen.queryByTestId("git-module-group-root")).toBeNull();
    expect(screen.getByTestId("file-row-/repo-traycer")).toBeDefined();
    expect(
      screen.queryByTestId("git-module-group-submodule-traycer"),
    ).toBeNull();
    expect(screen.queryByText("Submodule reference:")).toBeNull();
  });
});
