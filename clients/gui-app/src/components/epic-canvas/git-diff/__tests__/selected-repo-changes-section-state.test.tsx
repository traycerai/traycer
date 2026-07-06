import { act, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type {
  GitChangedFileV11,
  GitListChangedFilesResponseV11,
  SubmoduleChangeset,
  SubmodulePointer,
} from "@traycer/protocol/host";
import type { GitListChangedFilesSubscriptionResult } from "@/hooks/git/use-git-list-changed-files-subscription";
import type { GitListChangedFilesWithSubmodulesResult } from "@/hooks/git/use-git-list-changed-files-with-submodules";
import type { GitPanelSelectedRepo } from "@/stores/epics/git-panel-store";
import { useGitPanelStore } from "@/stores/epics/git-panel-store";
import { TooltipProvider } from "@/components/ui/tooltip";
import { GitChangedFilesView } from "../git-changed-files-view";
import { SelectedRepoChanges } from "../selected-repo-changes";
import { expectModuleHeaderTooltip } from "./git-module-header-test-utils";

vi.mock("../bundle-open-button", () => ({
  BundleOpenButton: (props: { readonly group: string }) => (
    <button type="button" aria-label={`Open ${props.group}`} />
  ),
}));

vi.mock("../git-flat-file-list", () => ({
  GitFlatFileList: (props: {
    readonly runningDir: string;
    readonly files: ReadonlyArray<GitChangedFileV11>;
  }) => (
    <div data-testid={`flat-list-${props.runningDir}`}>
      {props.files.map((changedFile) => (
        <span key={changedFile.path}>{changedFile.path}</span>
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

const rootSelected: GitPanelSelectedRepo = {
  hostId: "host-1",
  rootRunningDir: "/repo",
  repoRoot: "/repo",
};

const EMPTY_SUBSCRIPTION: GitListChangedFilesSubscriptionResult = {
  data: null,
  error: null,
  isPending: false,
  repoState: null,
  repoMode: null,
  pollStartedAtMs: null,
};

function file(path: string): GitChangedFileV11 {
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
    gitlink: null,
  };
}

function stagedFile(path: string): GitChangedFileV11 {
  return {
    ...file(path),
    stage: "staged",
  };
}

function gitlink(path: string): GitChangedFileV11 {
  return {
    ...file(path),
    gitlink: normalPointer,
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

function snapshotResult(
  data: GitListChangedFilesResponseV11,
): GitListChangedFilesWithSubmodulesResult {
  return { data, isPending: false, error: null };
}

function renderWithClient(children: ReactNode): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={0}>{children}</TooltipProvider>
    </QueryClientProvider>,
  );
}

function renderSelectedChanges(snapshot: GitListChangedFilesResponseV11): void {
  renderWithClient(
    <SelectedRepoChanges
      epicId="epic-1"
      viewTabId="tab-1"
      selected={rootSelected}
      rootLabel="traycer-internal"
      subscription={EMPTY_SUBSCRIPTION}
      snapshot={snapshotResult(snapshot)}
      onRefresh={vi.fn()}
      isRefreshing={false}
    />,
  );
}

function expectInputValue(element: HTMLElement, value: string): void {
  if (!(element instanceof HTMLInputElement)) {
    throw new Error("Expected an input element");
  }
  expect(element.value).toBe(value);
}

describe("<SelectedRepoChanges /> module section state", () => {
  beforeEach(() => {
    cleanup();
    vi.useRealTimers();
    window.localStorage.clear();
    useGitPanelStore.setState({ stateByEpicId: {} });
  });

  it("keeps root and submodule section collapse state independent", () => {
    renderSelectedChanges(
      response({
        files: [file("src/root-working.ts"), gitlink("traycer")],
        submodules: [changeset({ files: [file("src/submodule-working.ts")] })],
      }),
    );

    expect(screen.getByText("src/root-working.ts")).toBeDefined();
    expect(screen.getByText("src/submodule-working.ts")).toBeDefined();

    fireEvent.click(
      screen.getAllByRole("button", {
        name: "Changes section, 1 file",
      })[0],
    );

    expect(screen.queryByText("src/root-working.ts")).toBeNull();
    expect(screen.getByText("src/submodule-working.ts")).toBeDefined();
  });

  it("exposes module headers and module-owned sections as expanded buttons", async () => {
    renderSelectedChanges(
      response({
        files: [
          stagedFile("src/root-staged.ts"),
          file("src/root-working.ts"),
          gitlink("traycer"),
        ],
        submodules: [
          changeset({
            files: [
              stagedFile("src/submodule-staged.ts"),
              file("src/submodule-working.ts"),
            ],
          }),
        ],
      }),
    );

    const rootHeader = screen.getByRole("button", {
      name: /traycer-internal\s*2 files\s*development/,
    });
    const submoduleHeader = screen.getByRole("button", {
      name: /traycer\s*submodule\s*2 files\s*main\s*pinned commit out of date/,
    });
    expect(rootHeader.getAttribute("aria-expanded")).toBe("true");
    expect(submoduleHeader.getAttribute("aria-expanded")).toBe("true");
    const tooltipText = await expectModuleHeaderTooltip(
      submoduleHeader,
      "Path: /repo/traycer",
    );
    expect(tooltipText).toContain("Status: pinned commit out of date");
    expect(rootHeader.className).toContain("bg-background");
    expect(rootHeader.className).toContain("hover:bg-muted");
    expect(rootHeader.className).toContain("z-40");
    expect(rootHeader.className).not.toContain("hover:bg-muted/25");
    expect(rootHeader.querySelector(".lucide-git-branch")).toBeNull();
    expect(submoduleHeader.querySelector(".lucide-git-branch")).toBeNull();

    const stagedSections = screen.getAllByRole("button", {
      name: "Staged section, 1 file",
    });
    const workingSections = screen.getAllByRole("button", {
      name: "Changes section, 1 file",
    });
    expect(stagedSections).toHaveLength(2);
    expect(workingSections).toHaveLength(2);
    expect(stagedSections[0]?.getAttribute("aria-expanded")).toBe("true");
    expect(workingSections[0]?.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(stagedSections[0]);

    expect(stagedSections[0]?.getAttribute("aria-expanded")).toBe("false");
    expect(workingSections[0]?.getAttribute("aria-expanded")).toBe("true");
    expect(screen.queryByText("src/root-staged.ts")).toBeNull();
    expect(screen.getByText("src/root-working.ts")).toBeDefined();
    expect(screen.getByText("src/submodule-staged.ts")).toBeDefined();

    fireEvent.click(submoduleHeader);

    expect(submoduleHeader.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("src/submodule-working.ts")).toBeNull();
    expect(screen.getByText("src/root-working.ts")).toBeDefined();
  });

  it("renders a single repo as direct file sections and filters files only", () => {
    vi.useFakeTimers();
    renderSelectedChanges(
      response({
        branch: "development",
        files: [file("src/root-working.ts")],
      }),
    );

    expect(screen.getByTestId("git-single-repo-changes")).toBeDefined();
    expect(screen.queryByTestId("git-module-header-root")).toBeNull();
    expect(screen.getByRole("textbox", { name: "Filter files" })).toBeDefined();
    expect(screen.getByText("src/root-working.ts")).toBeDefined();

    fireEvent.change(screen.getByRole("textbox", { name: "Filter files" }), {
      target: { value: "development" },
    });
    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(screen.queryByText("src/root-working.ts")).toBeNull();
    expect(screen.getByTestId("git-no-matching-files")).toBeDefined();
  });

  it("expands a collapsed module while search reveals a matching file", () => {
    vi.useFakeTimers();
    renderSelectedChanges(
      response({
        files: [gitlink("traycer")],
        submodules: [changeset({ files: [file("src/needle.ts")] })],
      }),
    );

    fireEvent.click(screen.getByTestId("git-module-header-traycer"));
    expect(
      screen
        .getByTestId("git-module-header-traycer")
        .getAttribute("aria-expanded"),
    ).toBe("false");
    expect(screen.queryByText("src/needle.ts")).toBeNull();

    fireEvent.change(
      screen.getByRole("textbox", {
        name: "Filter submodules and files",
      }),
      { target: { value: "needle" } },
    );
    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(
      screen
        .getByTestId("git-module-header-traycer")
        .getAttribute("aria-expanded"),
    ).toBe("true");
    expect(screen.getByText("src/needle.ts")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Clear filter" }));

    expect(
      screen
        .getByTestId("git-module-header-traycer")
        .getAttribute("aria-expanded"),
    ).toBe("false");
    expect(screen.queryByText("src/needle.ts")).toBeNull();
  });

  it("preserves the toggled module header position when a tall module collapses", () => {
    renderSelectedChanges(
      response({
        files: [file("src/root-working.ts"), gitlink("traycer")],
        submodules: [changeset({ files: [file("src/submodule-working.ts")] })],
      }),
    );

    const container = screen.getByTestId("git-module-groups");
    const header = screen.getByTestId("git-module-header-traycer");
    container.scrollTop = 160;
    vi.spyOn(container, "getBoundingClientRect").mockReturnValue(
      DOMRect.fromRect({ x: 0, y: 20, width: 320, height: 480 }),
    );
    vi.spyOn(header, "getBoundingClientRect")
      .mockReturnValueOnce(
        DOMRect.fromRect({ x: 0, y: 260, width: 320, height: 42 }),
      )
      .mockReturnValueOnce(
        DOMRect.fromRect({ x: 0, y: 120, width: 320, height: 42 }),
      );

    fireEvent.click(header);

    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(container.scrollTop).toBe(20);
  });

  it("debounces changed-file filtering while keeping input updates immediate", () => {
    vi.useFakeTimers();
    renderWithClient(
      <GitChangedFilesView
        epicId="epic-search"
        viewTabId="tab-1"
        hostId="host-1"
        runningDir="/repo"
        files={[file("src/apple.ts"), file("src/banana.ts")]}
      />,
    );

    const input = screen.getByRole("textbox", {
      name: "Filter changed files",
    });
    fireEvent.change(input, { target: { value: "banana" } });

    expectInputValue(input, "banana");
    expect(screen.getByText("src/apple.ts")).toBeDefined();
    expect(screen.getByText("src/banana.ts")).toBeDefined();

    act(() => {
      vi.advanceTimersByTime(149);
    });

    expect(screen.getByText("src/apple.ts")).toBeDefined();
    expect(screen.getByText("src/banana.ts")).toBeDefined();

    act(() => {
      vi.advanceTimersByTime(1);
    });

    expect(screen.queryByText("src/apple.ts")).toBeNull();
    expect(screen.getByText("src/banana.ts")).toBeDefined();
  });

  it("clears the changed-file filter immediately from the clear button", () => {
    vi.useFakeTimers();
    renderWithClient(
      <GitChangedFilesView
        epicId="epic-clear"
        viewTabId="tab-1"
        hostId="host-1"
        runningDir="/repo"
        files={[file("src/apple.ts"), file("src/banana.ts")]}
      />,
    );

    fireEvent.change(
      screen.getByRole("textbox", { name: "Filter changed files" }),
      { target: { value: "banana" } },
    );
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(screen.queryByText("src/apple.ts")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Clear filter" }));

    expectInputValue(
      screen.getByRole("textbox", { name: "Filter changed files" }),
      "",
    );
    expect(screen.getByText("src/apple.ts")).toBeDefined();
    expect(screen.getByText("src/banana.ts")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Clear filter" })).toBeNull();
  });

  it("clears and blurs the changed-file filter on Escape", () => {
    vi.useFakeTimers();
    renderWithClient(
      <GitChangedFilesView
        epicId="epic-escape"
        viewTabId="tab-1"
        hostId="host-1"
        runningDir="/repo"
        files={[file("src/apple.ts"), file("src/banana.ts")]}
      />,
    );

    const input = screen.getByRole("textbox", {
      name: "Filter changed files",
    });
    input.focus();
    fireEvent.change(input, { target: { value: "banana" } });
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(screen.queryByText("src/apple.ts")).toBeNull();

    fireEvent.keyDown(input, { key: "Escape" });

    expectInputValue(input, "");
    expect(document.activeElement).not.toBe(input);
    expect(screen.getByText("src/apple.ts")).toBeDefined();
    expect(screen.getByText("src/banana.ts")).toBeDefined();
  });

  it("preserves global section collapse for normal changed-file views", () => {
    renderWithClient(
      <>
        <GitChangedFilesView
          epicId="epic-global"
          viewTabId="tab-1"
          hostId="host-1"
          runningDir="/repo"
          files={[file("src/normal-root.ts")]}
        />
        <GitChangedFilesView
          epicId="epic-global"
          viewTabId="tab-1"
          hostId="host-1"
          runningDir="/repo/traycer"
          files={[file("src/normal-submodule.ts")]}
        />
      </>,
    );

    expect(screen.getByText("src/normal-root.ts")).toBeDefined();
    expect(screen.getByText("src/normal-submodule.ts")).toBeDefined();

    fireEvent.click(
      screen.getAllByRole("button", {
        name: "Changes section, 1 file",
      })[0],
    );

    expect(screen.queryByText("src/normal-root.ts")).toBeNull();
    expect(screen.queryByText("src/normal-submodule.ts")).toBeNull();
  });
});
