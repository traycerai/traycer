import "../../../../../__tests__/test-browser-apis";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import type { WorktreeWorkspaceSummary } from "@traycer/protocol/host/worktree-schemas";
import { TooltipProvider } from "@/components/ui/tooltip";

// The host-wide uncommitted query (used only for the import-row annotation).
vi.mock("@/hooks/host/use-host-query", () => ({
  useHostQuery: () => ({ data: undefined, isLoading: false }),
}));

// Render the Radix dropdown menu (and its submenu) inline + always-open so the
// test can assert the menu items without fighting pointer-open semantics in
// jsdom. This mirrors the established mock in epic-sidebar-selection-mode.test.
vi.mock("@/components/ui/dropdown-menu", () => {
  const passthrough = (props: { readonly children: ReactNode }): ReactNode =>
    props.children;
  const item = (props: {
    readonly children: ReactNode;
    readonly onSelect?: () => void;
    readonly disabled?: boolean;
    readonly "data-testid"?: string;
  }): ReactNode => (
    <button
      type="button"
      data-testid={props["data-testid"]}
      disabled={props.disabled ?? false}
      onClick={props.onSelect}
    >
      {props.children}
    </button>
  );
  return {
    DropdownMenu: passthrough,
    DropdownMenuTrigger: passthrough,
    DropdownMenuContent: (props: {
      readonly children: ReactNode;
      readonly "data-testid"?: string;
    }) => <div data-testid={props["data-testid"]}>{props.children}</div>,
    DropdownMenuItem: item,
    DropdownMenuLabel: (props: { readonly children: ReactNode }) => (
      <div>{props.children}</div>
    ),
    DropdownMenuSub: passthrough,
    DropdownMenuSubTrigger: item,
    DropdownMenuSubContent: (props: { readonly children: ReactNode }) => (
      <div>{props.children}</div>
    ),
    DropdownMenuPortal: passthrough,
  };
});

import { FolderLocationControl } from "../folder-location-control";
import { FolderRow } from "../folder-row";
import { WorkspaceFolderRows } from "../workspace-folder-rows";
import { WorkspaceFolderSummaryControl } from "../workspace-folder-summary-control";
import { WorkspaceSummaryTrigger } from "../workspace-summary-trigger";
import type { WorkspaceRunItem } from "../workspace-run-item";

const NOOP = (): void => undefined;
const NOOP_ADD = (): Promise<boolean> => Promise.resolve(false);
const EMPTY_COUNTS: ReadonlyMap<string, number> = new Map();

const GIT_SUMMARY: WorktreeWorkspaceSummary = {
  workspacePath: "/repo",
  isGitRepo: true,
  repoIdentifier: { owner: "acme", repo: "app" },
  mainBranch: "development",
  worktrees: [
    {
      worktreePath: "/repo",
      branch: "development",
      head: null,
      isMain: true,
      isLocked: false,
    },
    {
      worktreePath: "/wt/feat-login",
      branch: "feat/login",
      sourceBranch: "development",
      head: null,
      isMain: false,
      isLocked: false,
    },
  ],
  scripts: null,
};

function item(over: Partial<WorkspaceRunItem>): WorkspaceRunItem {
  return {
    key: "/repo",
    displayName: "repo",
    displayPath: "/repo",
    unresolved: false,
    metadataPending: false,
    missing: false,
    isGitRepo: true,
    mode: "worktree",
    branchLabel: "feat/x",
    hoverLabel: "repo · worktree · feat/x",
    summary: GIT_SUMMARY,
    currentIntent: null,
    defaultNewBranchName: "traycer/swift-otter",
    repoIdentifier: { owner: "acme", repo: "app" },
    isPrimary: true,
    hostClient: null,
    modeDisabled: false,
    modeDisabledReason: null,
    removeDisabled: false,
    removeDisabledReason: null,
    removePending: false,
    onSelectMode: NOOP,
    onEmit: NOOP,
    onLocate: null,
    onRemove: null,
    ...over,
  };
}

afterEach(cleanup);

describe("FolderLocationControl", () => {
  function renderControl(over: Partial<WorkspaceRunItem>): void {
    render(
      <TooltipProvider>
        <FolderLocationControl
          item={item(over)}
          uncommittedByPath={EMPTY_COUNTS}
          boundaryEl={null}
          readOnly={false}
        />
      </TooltipProvider>,
    );
  }

  it("switches to Local via onSelectMode", () => {
    const onSelectMode = vi.fn();
    renderControl({ onSelectMode });
    fireEvent.click(screen.getByTestId("folder-location-local"));
    expect(onSelectMode).toHaveBeenCalledWith("local");
  });

  it("switches to New worktree via onSelectMode", () => {
    const onSelectMode = vi.fn();
    renderControl({ mode: "local", currentIntent: null, onSelectMode });
    fireEvent.click(screen.getByTestId("folder-location-worktree"));
    expect(onSelectMode).toHaveBeenCalledWith("worktree");
  });

  it("adopts an existing worktree from the submenu via onEmit(import)", () => {
    const onEmit = vi.fn();
    renderControl({ onEmit });
    fireEvent.click(
      screen.getByTestId("folder-location-import-/wt/feat-login"),
    );
    expect(onEmit).toHaveBeenCalledWith({
      kind: "import",
      workspacePath: "/repo",
      repoIdentifier: { owner: "acme", repo: "app" },
      isPrimary: true,
      worktreePath: "/wt/feat-login",
    });
  });

  it("moves the selected existing worktree to the top on open", () => {
    const summary: WorktreeWorkspaceSummary = {
      ...GIT_SUMMARY,
      worktrees: [
        GIT_SUMMARY.worktrees[0],
        {
          worktreePath: "/wt/feat-login",
          branch: "feat/login",
          sourceBranch: "development",
          head: null,
          isMain: false,
          isLocked: false,
        },
        {
          worktreePath: "/wt/feat-billing",
          branch: "feat/billing",
          sourceBranch: "development",
          head: null,
          isMain: false,
          isLocked: false,
        },
      ],
    };
    renderControl({
      summary,
      currentIntent: {
        kind: "import",
        workspacePath: "/repo",
        repoIdentifier: { owner: "acme", repo: "app" },
        isPrimary: true,
        worktreePath: "/wt/feat-billing",
      },
    });
    const list = screen.getByTestId("folder-location-existing-list");
    const rows = within(list).getAllByRole("button");
    expect(rows[0].textContent).toContain("feat/billing");
  });

  it("non-git folder offers Local only with an explanation (no menu)", async () => {
    renderControl({ isGitRepo: false, mode: "local", summary: null });
    const trigger = screen.getByTestId("folder-location-trigger");
    expect(trigger.textContent).toContain("Local");
    expect(trigger.hasAttribute("disabled")).toBe(false);
    expect(trigger.getAttribute("aria-disabled")).toBe("true");
    // No git → no worktree options → no menu content rendered.
    expect(screen.queryByTestId("folder-location-menu")).toBeNull();

    fireEvent.focus(trigger);
    expect((await screen.findByRole("tooltip")).textContent).toContain(
      "Worktrees require a Git repository",
    );
  });

  it("is disabled with a tooltip when modeDisabled (active owner)", () => {
    renderControl({
      modeDisabled: true,
      modeDisabledReason: "Stop the active run before rebinding",
    });
    expect(
      screen.getByTestId("folder-location-trigger").hasAttribute("disabled"),
    ).toBe(true);
  });

  it("omits the search bar with five or fewer worktrees", () => {
    // GIT_SUMMARY has a single non-main worktree.
    renderControl({ currentIntent: null });
    expect(screen.queryByLabelText("Search worktrees")).toBeNull();
    expect(
      screen.getByTestId("folder-location-import-/wt/feat-login"),
    ).toBeTruthy();
  });

  it("shows a search bar and filters the list past five worktrees", () => {
    const many = Array.from({ length: 6 }, (_unused, index) => ({
      worktreePath: `/wt/feat-${index}`,
      branch: `feat/${index}`,
      head: null,
      isMain: false,
      isLocked: false,
    }));
    const summary: WorktreeWorkspaceSummary = {
      ...GIT_SUMMARY,
      worktrees: [GIT_SUMMARY.worktrees[0], ...many],
    };
    renderControl({ summary, currentIntent: null });
    expect(
      screen.getByTestId("folder-location-import-/wt/feat-0"),
    ).toBeTruthy();
    expect(
      screen.getByTestId("folder-location-import-/wt/feat-5"),
    ).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Search worktrees"), {
      target: { value: "feat/3" },
    });
    expect(
      screen.getByTestId("folder-location-import-/wt/feat-3"),
    ).toBeTruthy();
    expect(
      screen.queryByTestId("folder-location-import-/wt/feat-0"),
    ).toBeNull();
  });
});

describe("FolderRow", () => {
  function renderRow(
    over: Partial<WorkspaceRunItem>,
    onEdit: (p: string) => void,
  ): void {
    render(
      <TooltipProvider>
        <FolderRow
          item={item(over)}
          onEditEnvironment={onEdit}
          uncommittedByPath={EMPTY_COUNTS}
          boundaryEl={null}
          readOnly={false}
        />
      </TooltipProvider>,
    );
  }

  it("opens the scripts editor from the ⚙ button in every mode", () => {
    let edited = "";
    renderRow({ mode: "local", currentIntent: null }, (p) => {
      edited = p;
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Edit setup and teardown scripts" }),
    );
    expect(edited).toBe("/repo");
  });

  it("renders a read-only branch label for Local mode (no branch popover)", async () => {
    renderRow(
      { mode: "local", branchLabel: "development", currentIntent: null },
      NOOP,
    );
    const readonly = screen.getByTestId("folder-branch-readonly");
    expect(readonly.textContent).toContain("development");
    expect(screen.queryByTestId("folder-branch-trigger")).toBeNull();
    // Full branch name surfaces in a tooltip on hover/focus (the label truncates).
    fireEvent.focus(readonly);
    expect((await screen.findByRole("tooltip")).textContent).toContain(
      "development",
    );
  });

  it("surfaces the full branch name in a tooltip on the editable chip", async () => {
    renderRow(
      {
        mode: "worktree",
        branchLabel: "Working tree · some/very-long-branch-name",
        currentIntent: null,
      },
      NOOP,
    );
    fireEvent.focus(screen.getByTestId("folder-branch-trigger"));
    expect((await screen.findByRole("tooltip")).textContent).toContain(
      "Working tree · some/very-long-branch-name",
    );
  });

  it("renders a read-only branch picker for an adopted worktree", () => {
    renderRow(
      {
        // An import is `mode: "worktree"`, so keying off `mode` alone would wrongly
        // show the editable new-worktree form — the branch must stay read-only.
        mode: "worktree",
        branchLabel: "feat/login",
        currentIntent: {
          kind: "import",
          workspacePath: "/repo",
          repoIdentifier: { owner: "acme", repo: "app" },
          isPrimary: true,
          worktreePath: "/wt/feat-login",
        },
      },
      NOOP,
    );
    fireEvent.click(screen.getByTestId("folder-branch-import-trigger"));
    expect(screen.getByTestId("import-worktree-branch-form")).toBeTruthy();
    expect(
      screen
        .getByTestId("import-worktree-source-branch")
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(
      screen.getByTestId("import-worktree-source-branch").textContent,
    ).toContain("development");
    const branchNameInput = screen.getByTestId("import-worktree-branch-name");
    if (!(branchNameInput instanceof HTMLInputElement)) {
      throw new Error("Expected imported worktree branch name input");
    }
    expect(branchNameInput.value).toBe("feat/login");
    expect(screen.queryByTestId("folder-branch-trigger")).toBeNull();
  });

  it("shows the delete button even for a single folder, wired to onRemove", () => {
    const onRemove = vi.fn();
    renderRow({ onRemove }, NOOP);
    const remove = screen.getByTestId("folder-remove");
    expect(remove).toBeTruthy();
    fireEvent.click(remove);
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it("offers both Locate and Remove on an Unavailable row", () => {
    const onLocate = vi.fn();
    const onRemove = vi.fn();
    renderRow({ unresolved: true, onLocate, onRemove }, NOOP);
    expect(screen.getByText("Unavailable")).toBeTruthy();

    fireEvent.click(screen.getByTestId("folder-row-locate"));
    expect(onLocate).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("folder-remove"));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it("hides both actions on a read-only Unavailable row", () => {
    render(
      <TooltipProvider>
        <FolderRow
          item={item({ unresolved: true, onLocate: NOOP, onRemove: NOOP })}
          onEditEnvironment={NOOP}
          uncommittedByPath={EMPTY_COUNTS}
          boundaryEl={null}
          readOnly
        />
      </TooltipProvider>,
    );
    expect(screen.getByText("Unavailable")).toBeTruthy();
    expect(screen.queryByTestId("folder-row-locate")).toBeNull();
    expect(screen.queryByTestId("folder-remove")).toBeNull();
  });
});

describe("WorkspaceFolderRows", () => {
  it("renders the leading slot, the first folder, and an Add folder button", () => {
    render(
      <TooltipProvider>
        <WorkspaceFolderRows
          items={[item({})]}
          trailingSlot={<span data-testid="device-slot">device</span>}
          onAddFolder={NOOP_ADD}
          addFolderPending={false}
          addFolderDisabled={false}
          addFolderDisabledReason={null}
          onUpdate={null}
          updateEnabled={false}
          updatePending={false}
          onEditEnvironment={NOOP}
          nestedInPopover={false}
          readOnly={false}
          bindingResolved
        />
      </TooltipProvider>,
    );
    expect(screen.getByTestId("device-slot")).toBeTruthy();
    expect(screen.getByTestId("folder-row")).toBeTruthy();
    expect(screen.getByTestId("folder-add")).toBeTruthy();
  });

  it("opens the OS folder picker from Add folder when empty and resolved", () => {
    let added = 0;
    render(
      <TooltipProvider>
        <WorkspaceFolderRows
          items={[]}
          trailingSlot={null}
          onAddFolder={() => {
            added += 1;
            return Promise.resolve(true);
          }}
          addFolderPending={false}
          addFolderDisabled={false}
          addFolderDisabledReason={null}
          onUpdate={null}
          updateEnabled={false}
          updatePending={false}
          onEditEnvironment={NOOP}
          nestedInPopover={false}
          readOnly={false}
          bindingResolved
        />
      </TooltipProvider>,
    );
    fireEvent.click(screen.getByTestId("folder-add"));
    expect(added).toBe(1);
  });

  it("shows a linking state when empty and the binding is unresolved", () => {
    render(
      <TooltipProvider>
        <WorkspaceFolderRows
          items={[]}
          trailingSlot={null}
          onAddFolder={NOOP_ADD}
          addFolderPending={false}
          addFolderDisabled={false}
          addFolderDisabledReason={null}
          onUpdate={null}
          updateEnabled={false}
          updatePending={false}
          onEditEnvironment={NOOP}
          nestedInPopover={false}
          readOnly={false}
          bindingResolved={false}
        />
      </TooltipProvider>,
    );
    expect(screen.getByTestId("workspace-folder-rows-linking")).toBeTruthy();
    expect(screen.queryByTestId("folder-add")).toBeNull();
  });

  it("read-only rows keep picker controls visible but non-actionable", () => {
    render(
      <TooltipProvider>
        <WorkspaceFolderRows
          items={[item({})]}
          trailingSlot={null}
          onAddFolder={NOOP_ADD}
          addFolderPending={false}
          addFolderDisabled={false}
          addFolderDisabledReason={null}
          onUpdate={null}
          updateEnabled={false}
          updatePending={false}
          onEditEnvironment={NOOP}
          nestedInPopover={false}
          readOnly
          bindingResolved
        />
      </TooltipProvider>,
    );
    const location = screen.getByTestId("folder-location-trigger");
    const branch = screen.getByTestId("folder-branch-trigger");
    expect(location).toBeTruthy();
    expect(branch).toBeTruthy();
    fireEvent.click(location);
    fireEvent.click(branch);
    expect(screen.queryByTestId("folder-location-menu")).toBeNull();
    expect(screen.queryByTestId("folder-branch-popover")).toBeNull();
    expect(screen.queryByTestId("folder-add")).toBeNull();
    expect(screen.queryByTestId("folder-scripts-trigger")).toBeNull();
    expect(screen.queryByTestId("folder-remove")).toBeNull();
  });

  it("hides the Update button on surfaces with no live PTY to resume", () => {
    render(
      <TooltipProvider>
        <WorkspaceFolderRows
          items={[item({})]}
          trailingSlot={null}
          onAddFolder={NOOP_ADD}
          addFolderPending={false}
          addFolderDisabled={false}
          addFolderDisabledReason={null}
          onUpdate={null}
          updateEnabled={false}
          updatePending={false}
          onEditEnvironment={NOOP}
          nestedInPopover={false}
          readOnly={false}
          bindingResolved
        />
      </TooltipProvider>,
    );
    expect(screen.getByTestId("folder-add")).toBeTruthy();
    expect(screen.queryByTestId("folder-update")).toBeNull();
  });

  it("renders the Update button disabled with nothing staged and ignores clicks", () => {
    let updates = 0;
    render(
      <TooltipProvider>
        <WorkspaceFolderRows
          items={[item({})]}
          trailingSlot={null}
          onAddFolder={NOOP_ADD}
          addFolderPending={false}
          addFolderDisabled={false}
          addFolderDisabledReason={null}
          onUpdate={() => {
            updates += 1;
          }}
          updateEnabled={false}
          updatePending={false}
          onEditEnvironment={NOOP}
          nestedInPopover={false}
          readOnly={false}
          bindingResolved
        />
      </TooltipProvider>,
    );
    const update = screen.getByTestId("folder-update");
    expect(update.hasAttribute("disabled")).toBe(true);
    fireEvent.click(update);
    expect(updates).toBe(0);
  });

  it("enables Update once changes are staged and applies them on click", () => {
    let updates = 0;
    render(
      <TooltipProvider>
        <WorkspaceFolderRows
          items={[item({})]}
          trailingSlot={null}
          onAddFolder={NOOP_ADD}
          addFolderPending={false}
          addFolderDisabled={false}
          addFolderDisabledReason={null}
          onUpdate={() => {
            updates += 1;
          }}
          updateEnabled
          updatePending={false}
          onEditEnvironment={NOOP}
          nestedInPopover={false}
          readOnly={false}
          bindingResolved
        />
      </TooltipProvider>,
    );
    const update = screen.getByTestId("folder-update");
    expect(update.hasAttribute("disabled")).toBe(false);
    fireEvent.click(update);
    expect(updates).toBe(1);
  });
});

describe("WorkspaceSummaryTrigger", () => {
  it("summarizes the primary folder and extra count", () => {
    render(
      <TooltipProvider>
        <WorkspaceSummaryTrigger
          items={[item({}), item({ key: "/repo2", displayName: "repo2" })]}
          readOnly={false}
          bindingResolved
        />
      </TooltipProvider>,
    );
    const trigger = screen.getByTestId("workspace-summary-trigger");
    expect(trigger.textContent).toContain("repo");
    expect(trigger.textContent).toContain("feat/x");
    expect(trigger.textContent).toContain("+1");
  });

  it("expands to a read-only folder list when read-only", async () => {
    render(
      <TooltipProvider>
        <WorkspaceSummaryTrigger items={[item({})]} readOnly bindingResolved />
      </TooltipProvider>,
    );
    const trigger = screen.getByTestId("workspace-summary-trigger");
    expect(trigger.getAttribute("aria-disabled")).toBeNull();

    fireEvent.click(trigger);

    expect(
      await screen.findByTestId("workspace-readonly-folders-popover"),
    ).toBeTruthy();
    expect(screen.getByTestId("workspace-folder-rows")).toBeTruthy();
    expect(screen.queryByTestId("workspace-folder-hover-list")).toBeNull();
    expect(screen.queryByTestId("folder-add")).toBeNull();
    const location = screen.getByTestId("folder-location-trigger");
    const branch = screen.getByTestId("folder-branch-trigger");
    expect(location).toBeTruthy();
    expect(branch).toBeTruthy();
    fireEvent.click(location);
    fireEvent.click(branch);
    expect(screen.queryByTestId("folder-location-menu")).toBeNull();
    expect(screen.queryByTestId("folder-branch-popover")).toBeNull();
    expect(screen.queryByTestId("folder-scripts-trigger")).toBeNull();
    expect(screen.queryByTestId("folder-remove")).toBeNull();
  });
});

describe("WorkspaceFolderSummaryControl", () => {
  it("renders Add folder directly when the folder list is empty and resolved", () => {
    let added = 0;
    render(
      <TooltipProvider>
        <WorkspaceFolderSummaryControl
          items={[]}
          readOnly={false}
          bindingResolved
          addFolderPending={false}
          addFolderDisabled={false}
          addFolderDisabledReason={null}
          onAddFolder={() => {
            added += 1;
            return Promise.resolve(true);
          }}
          onUpdate={null}
          updateEnabled={false}
          updatePending={false}
          onDiscardStaged={null}
          onEditEnvironment={NOOP}
          hoverPreviewEnabled={false}
          popoverTestId="workspace-rows-popover"
          popoverSide="top"
        />
      </TooltipProvider>,
    );

    expect(screen.queryByTestId("workspace-summary-trigger")).toBeNull();
    fireEvent.click(screen.getByTestId("folder-add"));
    expect(added).toBe(1);
  });

  it("keeps unresolved empty bindings in the loading summary state", () => {
    render(
      <TooltipProvider>
        <WorkspaceFolderSummaryControl
          items={[]}
          readOnly={false}
          bindingResolved={false}
          addFolderPending={false}
          addFolderDisabled={false}
          addFolderDisabledReason={null}
          onAddFolder={NOOP_ADD}
          onUpdate={null}
          updateEnabled={false}
          updatePending={false}
          onDiscardStaged={null}
          onEditEnvironment={NOOP}
          hoverPreviewEnabled={false}
          popoverTestId="workspace-rows-popover"
          popoverSide="top"
        />
      </TooltipProvider>,
    );

    expect(
      screen.getByTestId("workspace-summary-trigger").textContent,
    ).toContain("Linking workspace");
    expect(screen.queryByTestId("folder-add")).toBeNull();
  });

  it("opens the rows popover after a direct empty-state add succeeds", async () => {
    const addFolder = vi.fn(() => Promise.resolve(true));
    const { rerender } = render(
      <TooltipProvider>
        <WorkspaceFolderSummaryControl
          items={[]}
          readOnly={false}
          bindingResolved
          addFolderPending={false}
          addFolderDisabled={false}
          addFolderDisabledReason={null}
          onAddFolder={addFolder}
          onUpdate={null}
          updateEnabled={false}
          updatePending={false}
          onDiscardStaged={null}
          onEditEnvironment={NOOP}
          hoverPreviewEnabled={false}
          popoverTestId="workspace-rows-popover"
          popoverSide="top"
        />
      </TooltipProvider>,
    );

    fireEvent.click(screen.getByTestId("folder-add"));
    await waitFor(() => expect(addFolder).toHaveBeenCalledTimes(1));

    rerender(
      <TooltipProvider>
        <WorkspaceFolderSummaryControl
          items={[item({})]}
          readOnly={false}
          bindingResolved
          addFolderPending={false}
          addFolderDisabled={false}
          addFolderDisabledReason={null}
          onAddFolder={addFolder}
          onUpdate={null}
          updateEnabled={false}
          updatePending={false}
          onDiscardStaged={null}
          onEditEnvironment={NOOP}
          hoverPreviewEnabled={false}
          popoverTestId="workspace-rows-popover"
          popoverSide="top"
        />
      </TooltipProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("workspace-rows-popover")).toBeTruthy();
    });
    expect(screen.queryByTestId("folder-update")).toBeNull();
  });

  it("closes the pending rows popover when a direct empty-state add rejects", async () => {
    const addFolder = vi.fn(() => Promise.reject(new Error("cancelled")));
    const { rerender } = render(
      <TooltipProvider>
        <WorkspaceFolderSummaryControl
          items={[]}
          readOnly={false}
          bindingResolved
          addFolderPending={false}
          addFolderDisabled={false}
          addFolderDisabledReason={null}
          onAddFolder={addFolder}
          onUpdate={null}
          updateEnabled={false}
          updatePending={false}
          onDiscardStaged={null}
          onEditEnvironment={NOOP}
          hoverPreviewEnabled={false}
          popoverTestId="workspace-rows-popover"
          popoverSide="top"
        />
      </TooltipProvider>,
    );

    fireEvent.click(screen.getByTestId("folder-add"));
    await waitFor(() => expect(addFolder).toHaveBeenCalledTimes(1));

    rerender(
      <TooltipProvider>
        <WorkspaceFolderSummaryControl
          items={[item({})]}
          readOnly={false}
          bindingResolved
          addFolderPending={false}
          addFolderDisabled={false}
          addFolderDisabledReason={null}
          onAddFolder={addFolder}
          onUpdate={null}
          updateEnabled={false}
          updatePending={false}
          onDiscardStaged={null}
          onEditEnvironment={NOOP}
          hoverPreviewEnabled={false}
          popoverTestId="workspace-rows-popover"
          popoverSide="top"
        />
      </TooltipProvider>,
    );

    await waitFor(() => {
      expect(screen.queryByTestId("workspace-rows-popover")).toBeNull();
    });
  });
});
