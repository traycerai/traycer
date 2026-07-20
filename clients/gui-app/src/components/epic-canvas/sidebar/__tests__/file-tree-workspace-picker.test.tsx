import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { WorktreeBindingSelectorRowV12 } from "@traycer/protocol/host";
import { FileTreeWorkspacePicker } from "../file-tree-workspace-picker";

const selectById = vi.fn();
const refreshDirectory = vi.fn(() => Promise.resolve([]));
const hostBinding = {
  directory: { refresh: refreshDirectory, selectById },
};

interface ListQueryStub {
  readonly data: { readonly rows: WorktreeBindingSelectorRowV12[] } | undefined;
  readonly isPending: boolean;
  readonly isError: boolean;
}

const listQuery = vi.hoisted(() => ({
  current: null as ListQueryStub | null,
}));

vi.mock("@/hooks/worktree/use-worktree-list-bindings-for-epic-query", () => ({
  useWorktreeListBindingsForEpic: () => listQuery.current,
}));

vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({
    data: [
      {
        hostId: "host-1",
        label: "MacBook",
        kind: "local",
        websocketUrl: null,
        version: null,
        status: "available",
      },
    ],
  }),
}));

vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => "host-1",
}));

vi.mock("@/lib/host", () => ({
  useHostBinding: () => hostBinding,
}));

function makeRows(): WorktreeBindingSelectorRowV12[] {
  return [
    {
      hostId: "host-1",
      runningDir: "/work/traycer",
      workspacePath: "/work/traycer",
      worktreePath: null,
      mode: "local",
      isGitRepo: true,
      repoIdentifier: { owner: "traycer", repo: "traycer" },
      branch: "redesign",
      isPrimary: true,
      isImported: false,
      setupState: "not_required",
      disabledReason: null,
      sources: [],
      isGitResolvePending: false,
    },
    {
      hostId: "host-1",
      runningDir: "/work/traycer-wt/feature-x",
      workspacePath: "/work/traycer",
      worktreePath: "/work/traycer-wt/feature-x",
      mode: "worktree",
      isGitRepo: true,
      repoIdentifier: { owner: "traycer", repo: "traycer" },
      branch: "feature-x",
      isPrimary: false,
      isImported: false,
      setupState: "not_required",
      disabledReason: null,
      sources: [],
      isGitResolvePending: false,
    },
  ];
}

function stubLoadedWorkspaces(): void {
  listQuery.current = {
    data: { rows: makeRows() },
    isPending: false,
    isError: false,
  };
}

function makeNonGitRow(): WorktreeBindingSelectorRowV12 {
  return {
    hostId: "host-1",
    runningDir: "/work/notes",
    workspacePath: "/work/notes",
    worktreePath: null,
    mode: "local",
    isGitRepo: false,
    repoIdentifier: null,
    branch: null,
    isPrimary: false,
    isImported: false,
    setupState: "not_required",
    disabledReason: null,
    sources: [],
    isGitResolvePending: false,
  };
}

function stubLoadedNonGitWorkspace(): void {
  listQuery.current = {
    data: { rows: [makeNonGitRow()] },
    isPending: false,
    isError: false,
  };
}

function openPicker(
  selectedPath: string | null,
  onSelectPath: (path: string) => void,
): void {
  render(
    <FileTreeWorkspacePicker
      epicId="epic-1"
      hostId="host-1"
      selectedPath={selectedPath}
      onSelectPath={onSelectPath}
    />,
  );
  fireEvent.click(screen.getByTestId("file-tree-workspace-picker-trigger"));
}

describe("<FileTreeWorkspacePicker />", () => {
  beforeEach(() => {
    cleanup();
    selectById.mockClear();
    refreshDirectory.mockClear();
    stubLoadedWorkspaces();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("opens a popover with the host section and flat workspace rows", () => {
    openPicker("/work/traycer", () => undefined);

    expect(refreshDirectory).toHaveBeenCalledTimes(1);
    expect(
      screen.getByTestId("file-tree-workspace-picker-popover"),
    ).toBeDefined();
    expect(
      screen.getByTestId("host-workspace-selector-host-section"),
    ).toBeDefined();
    const workspacesHeader = screen.getByText("Workspaces");
    const search = screen.getByRole("combobox");
    expect(screen.getAllByText("Workspaces")).toHaveLength(1);
    expect(
      workspacesHeader.compareDocumentPosition(search) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      screen.getByRole("option", { name: /traycer.*redesign/i }),
    ).toBeDefined();
    expect(screen.getByRole("option", { name: /feature-x/i })).toBeDefined();
  });

  it("refreshes the host directory once per picker open", () => {
    render(
      <FileTreeWorkspacePicker
        epicId="epic-1"
        hostId="host-1"
        selectedPath="/work/traycer"
        onSelectPath={() => undefined}
      />,
    );

    const trigger = screen.getByTestId("file-tree-workspace-picker-trigger");
    expect(refreshDirectory).toHaveBeenCalledTimes(0);

    fireEvent.click(trigger);
    expect(refreshDirectory).toHaveBeenCalledTimes(1);

    fireEvent.click(trigger);
    expect(refreshDirectory).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByTestId("file-tree-workspace-picker-popover"),
    ).toBeNull();

    fireEvent.click(trigger);
    expect(refreshDirectory).toHaveBeenCalledTimes(2);
  });

  it("uses the git-diff picker trigger style without a changes badge", () => {
    render(
      <FileTreeWorkspacePicker
        epicId="epic-1"
        hostId="host-1"
        selectedPath="/work/traycer"
        onSelectPath={() => undefined}
      />,
    );

    const trigger = screen.getByTestId("file-tree-workspace-picker-trigger");
    expect(trigger.textContent).toContain("traycer · redesign");
    expect(trigger.textContent).toContain("/work/traycer");
    expect(trigger.textContent).not.toContain("changed");
  });

  it("left-truncates the selected workspace path in the trigger", () => {
    render(
      <FileTreeWorkspacePicker
        epicId="epic-1"
        hostId="host-1"
        selectedPath="/work/traycer"
        onSelectPath={() => undefined}
      />,
    );

    const pathText = within(
      screen.getByTestId("file-tree-workspace-picker-trigger"),
    ).getByText("/work/traycer");
    expect(pathText.parentElement?.style.direction).toBe("rtl");
    expect(pathText.getAttribute("dir")).toBe("ltr");
  });

  it("marks the row matching selectedPath as checked", () => {
    const scrolledElements: Element[] = [];
    const scrollIntoView = vi
      .spyOn(Element.prototype, "scrollIntoView")
      .mockImplementation(function recordScrollIntoView(this: Element): void {
        scrolledElements.push(this);
      });

    openPicker("/work/traycer-wt/feature-x", () => undefined);

    const worktreeOption = screen.getByRole("option", { name: /feature-x/i });
    const localOption = screen.getByRole("option", {
      name: /traycer.*redesign/i,
    });
    expect(worktreeOption.dataset.checked).toBe("true");
    expect(localOption.dataset.checked).toBeUndefined();
    expect(
      scrolledElements.some((element) => worktreeOption.contains(element)),
    ).toBe(true);
    expect(scrollIntoView).toHaveBeenCalledWith({
      block: "nearest",
      inline: "nearest",
    });
  });

  it("selects a worktree path on a single click and closes the popover", () => {
    const onSelectPath = vi.fn();
    openPicker("/work/traycer", onSelectPath);

    fireEvent.click(screen.getByRole("option", { name: /feature-x/i }));

    expect(onSelectPath).toHaveBeenCalledTimes(1);
    expect(onSelectPath).toHaveBeenCalledWith("/work/traycer-wt/feature-x");
    expect(
      screen.queryByTestId("file-tree-workspace-picker-popover"),
    ).toBeNull();
  });

  it("keeps non-git binding rows selectable for file browsing", () => {
    const onSelectPath = vi.fn();
    stubLoadedNonGitWorkspace();
    openPicker(null, onSelectPath);

    fireEvent.click(screen.getByRole("option", { name: /notes.*detached/i }));

    expect(onSelectPath).toHaveBeenCalledWith("/work/notes");
  });

  // A cold worktree row the host marks `isGitResolvePending` (its
  // `missing_worktree_path` derives from an unverified `isGitRepo: false`, not
  // disk truth) must read as "checking", not "missing". A cold LOCAL row never
  // needed git facts to be browsable, so it stays selectable.
  it("renders an unverified worktree row as checking instead of missing, keeping cold local rows browsable", () => {
    const onSelectPath = vi.fn();
    const coldWorktree: WorktreeBindingSelectorRowV12 = {
      ...makeRows()[1],
      isGitRepo: false,
      disabledReason: "missing_worktree_path",
      isGitResolvePending: true,
    };
    const coldLocal: WorktreeBindingSelectorRowV12 = {
      ...makeNonGitRow(),
      isGitResolvePending: true,
    };
    listQuery.current = {
      data: { rows: [coldWorktree, coldLocal] },
      isPending: false,
      isError: false,
    };
    openPicker(null, onSelectPath);

    const worktreeOption = screen.getByRole("option", { name: /feature-x/i });
    expect(within(worktreeOption).getByText("checking")).toBeDefined();
    expect(within(worktreeOption).queryByText("missing")).toBeNull();
    fireEvent.click(worktreeOption);
    expect(onSelectPath).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("option", { name: /notes.*detached/i }));
    expect(onSelectPath).toHaveBeenCalledWith("/work/notes");
  });

  // Once the host RESOLVES the worktree as gone, "missing" is a fact again.
  it("keeps the destructive missing badge for a resolved missing worktree", () => {
    const missingWorktree: WorktreeBindingSelectorRowV12 = {
      ...makeRows()[1],
      isGitRepo: false,
      disabledReason: "missing_worktree_path",
      isGitResolvePending: false,
    };
    listQuery.current = {
      data: { rows: [missingWorktree] },
      isPending: false,
      isError: false,
    };
    openPicker(null, () => undefined);

    const worktreeOption = screen.getByRole("option", { name: /feature-x/i });
    expect(within(worktreeOption).getByText("missing")).toBeDefined();
    expect(within(worktreeOption).queryByText("checking")).toBeNull();
  });

  it("swaps the bound host without selecting a folder when a host row is clicked", () => {
    const onSelectPath = vi.fn();
    openPicker("/work/traycer", onSelectPath);

    fireEvent.click(
      screen.getByTestId("host-workspace-selector-host-row-host-1"),
    );

    expect(selectById).toHaveBeenCalledWith("host-1");
    expect(onSelectPath).not.toHaveBeenCalled();
  });

  it("shows the shared error state when workspaces fail to load", () => {
    listQuery.current = { data: undefined, isPending: false, isError: true };
    openPicker(null, () => undefined);

    expect(screen.getByText("Failed to load workspaces.")).toBeDefined();
  });
});
