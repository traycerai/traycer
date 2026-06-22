import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type {
  GitChangedFile,
  GitListChangedFilesResponse,
  RepoMode,
  WorktreeBindingSelectorRow,
} from "@traycer/protocol/host";
import { WorktreePicker } from "../worktree-picker";
import { useGitPanelStore } from "@/stores/epics/git-panel-store";
import { gitQueryKeys } from "@/lib/query-keys/git-query-keys";

vi.mock("@/hooks/git/use-git-prefetch-worktree-status", () => ({
  useGitPrefetchWorktreeStatus: () => vi.fn(),
}));

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

function makeWrapper(queryClient: QueryClient) {
  return ({ children }: { readonly children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

function makeRow(
  runningDir: string,
  branch: string | null,
  disabledReason: WorktreeBindingSelectorRow["disabledReason"],
): WorktreeBindingSelectorRow {
  return {
    hostId: "host-1",
    runningDir,
    workspacePath: "/Users/anurag/work/traycer",
    worktreePath: runningDir,
    mode: "worktree",
    isGitRepo: true,
    repoIdentifier: { owner: "traycer", repo: "traycer" },
    branch,
    isPrimary: runningDir.endsWith("traycer"),
    isImported: runningDir.includes("imported"),
    setupState: "not_required",
    disabledReason,
    sources: [],
  };
}

function makeChangedFile(path: string): GitChangedFile {
  return {
    path,
    previousPath: null,
    status: "modified",
    stage: "unstaged",
    insertions: 1,
    deletions: 0,
    isBinary: false,
    sizeBytes: 0,
    stagedOid: null,
    worktreeOid: null,
  };
}

function makeListChangedFilesResponse(
  runningDir: string,
  fileCount: number,
  repoMode: RepoMode,
): GitListChangedFilesResponse {
  return {
    runningDir,
    headSha: "abc123",
    branch: "main",
    files: Array.from({ length: fileCount }, (_value, index) =>
      makeChangedFile(`file-${index}.ts`),
    ),
    fingerprint: "fingerprint",
    repoMode,
    repoState: { kind: "clean" },
  };
}

describe("<WorktreePicker />", () => {
  beforeEach(() => {
    cleanup();
    useGitPanelStore.setState({ stateByEpicId: {} });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses the git-native trigger with repo and branch labels", () => {
    render(
      <WorktreePicker
        epicId="epic-1"
        rows={[makeRow("/Users/anurag/work/traycer", "feature/git-ui", null)]}
        selectedRow={makeRow(
          "/Users/anurag/work/traycer",
          "feature/git-ui",
          null,
        )}
      />,
      { wrapper: makeWrapper(makeQueryClient()) },
    );

    expect(
      screen.getByRole("button", { name: /traycer.*feature\/git-ui/i }),
    ).toBeDefined();
  });

  it("left-truncates the selected worktree path in the trigger", () => {
    render(
      <WorktreePicker
        epicId="epic-1"
        rows={[makeRow("/Users/anurag/work/traycer", "feature/git-ui", null)]}
        selectedRow={makeRow(
          "/Users/anurag/work/traycer",
          "feature/git-ui",
          null,
        )}
      />,
      { wrapper: makeWrapper(makeQueryClient()) },
    );

    const pathText = within(
      screen.getByTestId("git-worktree-picker-trigger"),
    ).getByText("/Users/anurag/work/traycer");
    expect(pathText.parentElement?.style.direction).toBe("rtl");
    expect(pathText.getAttribute("dir")).toBe("ltr");
  });

  it("keeps searchable worktree rows inside the popover", () => {
    const selected = makeRow("/Users/anurag/work/traycer", "main", null);
    const imported = makeRow(
      "/Users/anurag/work/imported",
      "branch-a",
      "setup_failed",
    );
    const queryClient = makeQueryClient();
    queryClient.setQueryData(
      gitQueryKeys.listChangedFiles(
        imported.hostId,
        imported.runningDir,
        false,
      ),
      makeListChangedFilesResponse(imported.runningDir, 3, "degraded"),
    );

    render(
      <WorktreePicker
        epicId="epic-1"
        rows={[selected, imported]}
        selectedRow={selected}
      />,
      { wrapper: makeWrapper(queryClient) },
    );

    fireEvent.click(screen.getByRole("button", { name: /traycer.*main/i }));

    expect(screen.getByTestId("git-worktree-picker-popover")).toBeDefined();
    expect(
      screen.getByTestId("host-workspace-selector-host-section"),
    ).toBeDefined();
    expect(screen.getByRole("combobox")).toBeDefined();

    const importedOption = screen.getByRole("option", {
      name: /\/Users\/anurag\/work\/imported.*failed/i,
    });
    expect(
      within(importedOption).getByText("/Users/anurag/work/imported"),
    ).toBeDefined();
    expect(within(importedOption).getByText("failed")).toBeDefined();
    expect(within(importedOption).queryByText("3")).toBeNull();
    expect(within(importedOption).queryByText("imported")).toBeNull();
    expect(within(importedOption).queryByText("large")).toBeNull();
  });

  it("preserves row order and scrolls the selected row into view", () => {
    const first = makeRow("/Users/anurag/work/first", "alpha", null);
    const selected = makeRow("/Users/anurag/work/selected", "beta", null);
    const scrolledElements: Element[] = [];
    const scrollIntoView = vi
      .spyOn(Element.prototype, "scrollIntoView")
      .mockImplementation(function recordScrollIntoView(this: Element): void {
        scrolledElements.push(this);
      });

    render(
      <WorktreePicker
        epicId="epic-1"
        rows={[first, selected]}
        selectedRow={selected}
      />,
      { wrapper: makeWrapper(makeQueryClient()) },
    );

    fireEvent.click(screen.getByRole("button", { name: /traycer.*beta/i }));

    const options = screen.getAllByRole("option");
    expect(within(options[0]).getByText(/alpha/i)).toBeDefined();
    expect(within(options[1]).getByText(/beta/i)).toBeDefined();
    expect(
      scrolledElements.some((element) => options[1].contains(element)),
    ).toBe(true);
    expect(scrollIntoView).toHaveBeenCalledWith({
      block: "nearest",
      inline: "nearest",
    });
  });

  it("selects enabled rows through the Git panel store", () => {
    const selected = makeRow("/Users/anurag/work/traycer", "main", null);
    const next = makeRow("/Users/anurag/work/next", "branch-b", null);

    render(
      <WorktreePicker
        epicId="epic-1"
        rows={[selected, next]}
        selectedRow={selected}
      />,
      { wrapper: makeWrapper(makeQueryClient()) },
    );

    fireEvent.click(screen.getByRole("button", { name: /traycer.*main/i }));
    fireEvent.click(screen.getByRole("option", { name: /traycer.*branch-b/i }));

    expect(
      useGitPanelStore.getState().stateByEpicId["epic-1"].selectedWorktree,
    ).toEqual({
      hostId: next.hostId,
      runningDir: next.runningDir,
    });
  });
});
