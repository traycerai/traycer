import "../../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import type {
  WorktreeFolderIntent,
  WorktreeWorkspaceSummary,
} from "@traycer/protocol/host/worktree-schemas";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  contrastRatio,
  DARK_THEME_SURFACES,
  LIGHT_THEME_SURFACES,
  MUTED_FOREGROUND_DARK,
  MUTED_FOREGROUND_LIGHT,
} from "../../../../../__tests__/contrast";

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

import { FolderBranchControl } from "../folder-branch-control";
import { FolderLocationControl } from "../folder-location-control";
import { FolderRow } from "../folder-row";
import { WorkspaceFolderRows } from "../workspace-folder-rows";
import { WorkspaceFolderSummaryControl } from "../workspace-folder-summary-control";
import { WorkspaceSummaryTrigger } from "../workspace-summary-trigger";
import type { WorkspaceRunItem } from "../workspace-run-item";

const NOOP = (): void => undefined;
const NOOP_ADD = (): Promise<boolean> => Promise.resolve(false);
const EMPTY_COUNTS: ReadonlyMap<string, number> = new Map();

function tabForward(): void {
  const focusable = Array.from(
    document.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  );
  const currentIndex = focusable.findIndex(
    (element) => element === document.activeElement,
  );
  const next = focusable[currentIndex + 1] ?? focusable[0];
  fireEvent.keyDown(document.activeElement ?? document.body, {
    key: "Tab",
    code: "Tab",
  });
  next.focus();
  fireEvent.keyUp(next, { key: "Tab", code: "Tab" });
}

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
    summary: GIT_SUMMARY,
    currentIntent: null,
    defaultNewBranchName: "traycer/swift-otter",
    repoIdentifier: { owner: "acme", repo: "app" },
    isPrimary: true,
    canChangePrimary: true,
    makePrimaryDisabled: false,
    makePrimaryDisabledReason: null,
    hostClient: null,
    modeDisabled: false,
    modeDisabledReason: null,
    removeDisabled: false,
    removeDisabledReason: null,
    removePending: false,
    onSelectMode: NOOP,
    onEmit: NOOP,
    onLocate: null,
    onMakePrimary: NOOP,
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

  it("copies the run path from the click-open row - the surface the copy action moved to", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    renderRow(
      { mode: "local", displayPath: "/repo", currentIntent: null },
      NOOP,
    );
    fireEvent.click(screen.getByLabelText("Copy folder path"));
    expect(writeText).toHaveBeenCalledWith("/repo");
  });

  it("copies the adopted worktree path, not the source folder, for an imported worktree", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    renderRow(
      {
        mode: "worktree",
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
    fireEvent.click(screen.getByLabelText("Copy folder path"));
    expect(writeText).toHaveBeenCalledWith("/wt/feat-login");
  });

  it("hides the copy-path action for a new worktree that has no path yet", () => {
    renderRow({ mode: "worktree", currentIntent: null }, NOOP);
    expect(screen.queryByLabelText("Copy folder path")).toBeNull();
  });

  it("keeps the copy-path icon's default state free of stacked opacity attenuation and >=3:1 against the popover in every theme preset", () => {
    renderRow(
      { mode: "local", displayPath: "/repo", currentIntent: null },
      NOOP,
    );
    const copyButton = screen.getByLabelText("Copy folder path");
    // The bug was `text-muted-foreground/70` (a fractional text color) MULTIPLIED
    // by an outer `opacity-[var(--fc-opacity,0.7)]` - ~49% effective opacity.
    // Both must be gone from the default (non-hover) state.
    expect(copyButton.className).not.toMatch(/text-muted-foreground\/\d/);
    expect(copyButton.className).not.toMatch(/opacity-\[var\(--fc-opacity/);
    expect(copyButton.className).toContain("text-muted-foreground");

    for (const [preset, foreground] of Object.entries(MUTED_FOREGROUND_LIGHT)) {
      const surfaces = LIGHT_THEME_SURFACES[preset];
      expect(
        contrastRatio(foreground, surfaces.popover),
      ).toBeGreaterThanOrEqual(3);
    }
    for (const [preset, foreground] of Object.entries(MUTED_FOREGROUND_DARK)) {
      const surfaces = DARK_THEME_SURFACES[preset];
      expect(
        contrastRatio(foreground, surfaces.popover),
      ).toBeGreaterThanOrEqual(3);
    }
  });

  it("keeps pin, identity, controls, and actions on one aligned row", () => {
    renderRow({ displayName: "a-folder-name-that-needs-room" }, NOOP);

    const row = screen.getByTestId("folder-row");
    const pin = screen.getByTestId("folder-primary-pin");
    const identity = screen.getByTestId("folder-chip");
    const actions = screen.getByTestId("folder-row-actions");
    const location = screen.getByTestId("folder-location-trigger");
    const branch = screen.getByTestId("folder-branch-trigger");

    expect(row.className).toContain("grid-cols-subgrid");
    expect(row.contains(pin)).toBe(true);
    expect(row.contains(identity)).toBe(true);
    expect(row.contains(location)).toBe(true);
    expect(row.contains(branch)).toBe(true);
    expect(row.contains(actions)).toBe(true);
    expect(screen.queryByTestId("folder-row-details")).toBeNull();
    expect(location.className).toContain("w-full");
    expect(branch.className).toContain("w-full");
    expect(identity.className).toContain("w-full");
    expect(identity.className).not.toContain("opacity-[var(--fc-opacity,0.7)]");
    expect(identity.children[1].className).toContain("text-foreground/90");
    expect(location.className).toContain("var(--color-muted-foreground)");
    expect(branch.className).toContain("text-foreground/75");
    expect(identity.getAttribute("title")).toBe("/repo");
  });

  it("reserves two stable trailing action slots", () => {
    renderRow({ isPrimary: true, canChangePrimary: true }, NOOP);

    const actions = screen.getByTestId("folder-row-actions");
    expect(actions.children).toHaveLength(2);
    expect(actions.className).toContain("justify-self-end");
    expect(
      actions.children[0].querySelector(
        '[data-testid="folder-scripts-trigger"]',
      ),
    ).not.toBeNull();
    expect(
      actions.children[1].querySelector('[data-testid="folder-remove"]'),
    ).not.toBeNull();
  });

  it("renders a read-only branch label for Local mode (no branch popover)", async () => {
    renderRow(
      { mode: "local", branchLabel: "development", currentIntent: null },
      NOOP,
    );
    const readonly = screen.getByTestId("folder-branch-readonly");
    expect(readonly.textContent).toContain("development");
    expect(readonly.className).toContain("text-foreground/75");
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

  it("shows a new worktree's target and lower-emphasis source without changing the branch track", async () => {
    renderRow(
      {
        branchLabel: "traycer/new-feature",
        currentIntent: {
          kind: "worktree",
          workspacePath: "/repo",
          repoIdentifier: { owner: "acme", repo: "app" },
          isPrimary: true,
          scripts: null,
          branch: {
            type: "new",
            name: "traycer/new-feature",
            source: "development",
            carryUncommittedChanges: false,
          },
        },
      },
      NOOP,
    );

    const trigger = screen.getByTestId("folder-branch-trigger");
    expect(trigger.textContent).toContain("traycer/new-feature");
    expect(trigger.textContent).toContain("from development");
    expect(screen.getByTestId("folder-branch-target").className).toContain(
      "truncate",
    );
    const source = screen.getByTestId("folder-branch-source");
    expect(source.className).toContain("text-ui-xs");
    expect(source.className).toContain("text-muted-foreground");
    expect(trigger.className).toContain("w-full");
    expect(trigger.className).toContain("max-w-full");
    fireEvent.focus(trigger);
    expect((await screen.findByRole("tooltip")).textContent).toContain(
      "traycer/new-feature · from development",
    );
  });

  it("keeps a short target content-sized and gives its source the remaining branch space", () => {
    renderRow(
      {
        branchLabel: "helo",
        currentIntent: {
          kind: "worktree",
          workspacePath: "/repo",
          repoIdentifier: { owner: "acme", repo: "app" },
          isPrimary: true,
          scripts: null,
          branch: {
            type: "new",
            name: "helo",
            source: "origin/main",
            carryUncommittedChanges: false,
          },
        },
      },
      NOOP,
    );

    const relationship = screen.getByTestId("folder-branch-label");
    const target = screen.getByTestId("folder-branch-target");
    const source = screen.getByTestId("folder-branch-source");
    expect(relationship.className).toContain("flex");
    expect(relationship.className).not.toContain("grid-cols");
    expect(target.textContent).toBe("helo");
    expect(target.className).toContain("max-w-[60%]");
    expect(target.className).toContain("shrink-0");
    expect(source.textContent).toBe("from origin/main");
    expect(source.className).toContain("flex-1");
    expect(source.className).toContain("min-w-0");
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
    const details = screen.getByTestId("import-worktree-branch-form");
    expect(details).toBeInstanceOf(HTMLDListElement);
    expect(within(details).queryByRole("listbox")).toBeNull();
    expect(within(details).queryByRole("option")).toBeNull();
    expect(within(details).queryByRole("button")).toBeNull();
    const sourceBranch = screen.getByTestId("import-worktree-source-branch");
    expect(sourceBranch).not.toBeInstanceOf(HTMLInputElement);
    expect(sourceBranch.textContent).toBe("development");
    const branchName = screen.getByTestId("import-worktree-branch-name");
    expect(branchName).not.toBeInstanceOf(HTMLInputElement);
    expect(branchName.textContent).toBe("feat/login");
    expect(screen.getByText("Source branch")).toBeTruthy();
    expect(screen.getByText("Current branch")).toBeTruthy();
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

  it("shows a filled Primary pin with an explanatory tooltip", async () => {
    renderRow({ isPrimary: true }, NOOP);
    const pin = screen.getByTestId("folder-primary-pin");
    expect(pin.tagName).toBe("BUTTON");
    expect(pin.getAttribute("aria-disabled")).toBe("true");
    expect(pin.getAttribute("aria-label")).toBe("Primary folder information");
    expect(pin.querySelector("svg")?.getAttribute("fill")).toBe("currentColor");
    tabForward();
    expect(document.activeElement).toBe(pin);
    expect((await screen.findByRole("tooltip")).textContent).toContain(
      "New agent commands and terminals start here",
    );
  });

  it("shows an outline locked pin with a disabled cursor and explanation", async () => {
    renderRow({ isPrimary: false, canChangePrimary: false }, NOOP);
    const pin = screen.getByTestId("folder-secondary-pin");
    expect(pin.querySelector("svg")?.getAttribute("fill")).toBe("none");
    expect(pin.getAttribute("aria-disabled")).toBe("true");
    expect(pin.className).toContain("cursor-not-allowed");
    fireEvent.focus(pin);
    expect((await screen.findByRole("tooltip")).textContent).toContain(
      "cannot be changed after the agent starts",
    );
  });

  it("explains the post-start lock on the filled Primary pin", async () => {
    renderRow({ isPrimary: true, canChangePrimary: false }, NOOP);
    const pin = screen.getByTestId("folder-primary-pin");
    expect(pin.getAttribute("aria-disabled")).toBe("true");
    expect(pin.className).toContain("cursor-not-allowed");
    tabForward();
    expect(document.activeElement).toBe(pin);
    expect((await screen.findByRole("tooltip")).textContent).toContain(
      "cannot be changed after the agent starts",
    );
  });

  it("hides the Make primary action on the primary row itself", () => {
    renderRow({ isPrimary: true, canChangePrimary: true }, NOOP);
    expect(screen.queryByTestId("folder-make-primary")).toBeNull();
    expect(screen.getByTestId("folder-primary-pin")).toBeTruthy();
  });

  it("offers a keyboard-operable Make primary action on a non-primary row, wired to onMakePrimary", () => {
    const onMakePrimary = vi.fn();
    renderRow(
      { isPrimary: false, canChangePrimary: true, onMakePrimary },
      NOOP,
    );
    const button = screen.getByRole("button", { name: "Set as primary" });
    expect(button).toBeTruthy();
    expect(button.hasAttribute("disabled")).toBe(false);
    fireEvent.click(button);
    expect(onMakePrimary).toHaveBeenCalledTimes(1);
  });

  it("replaces Make primary with a passive outline pin when the surface can't change primary", () => {
    renderRow({ isPrimary: false, canChangePrimary: false }, NOOP);
    expect(screen.queryByTestId("folder-make-primary")).toBeNull();
    expect(screen.getByTestId("folder-secondary-pin")).toBeTruthy();
  });

  it("keeps the disabled pin keyboard-reachable while metadata is pending", async () => {
    const onRemove = vi.fn();
    renderRow(
      {
        metadataPending: true,
        isPrimary: false,
        canChangePrimary: true,
        makePrimaryDisabled: true,
        makePrimaryDisabledReason: "Loading folder metadata",
        summary: null,
        onRemove,
      },
      NOOP,
    );
    expect(screen.getByTestId("folder-row-loading")).toBeTruthy();
    // aria-disabled keeps the explanation in normal keyboard traversal while
    // guarding activation during the fetch.
    const pin = screen.getByTestId("folder-make-primary");
    expect(pin.hasAttribute("disabled")).toBe(false);
    expect(pin.getAttribute("aria-disabled")).toBe("true");
    tabForward();
    expect(document.activeElement).toBe(pin);
    const tooltip = await screen.findByRole("tooltip");
    expect(pin.getAttribute("aria-describedby")).toBe(tooltip.id);
    expect(tooltip.textContent).toContain("Loading folder metadata");
    // Remove stays live - a pending row is still removable.
    fireEvent.click(screen.getByTestId("folder-remove"));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it("tabs to the disabled Make primary explanation for an unresolved row", async () => {
    const onMakePrimary = vi.fn();
    renderRow(
      {
        unresolved: true,
        isPrimary: false,
        canChangePrimary: true,
        makePrimaryDisabled: true,
        makePrimaryDisabledReason: "Resolve this folder to make it primary",
        onLocate: NOOP,
        onMakePrimary,
        onRemove: NOOP,
      },
      NOOP,
    );
    const button = screen.getByTestId("folder-make-primary");
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    tabForward();
    expect(document.activeElement).toBe(button);
    const tooltip = await screen.findByRole("tooltip");
    expect(button.getAttribute("aria-describedby")).toBe(tooltip.id);
    expect(tooltip.textContent).toContain(
      "Resolve this folder to make it primary",
    );
    fireEvent.click(button);
    expect(onMakePrimary).not.toHaveBeenCalled();
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

  it("lets the container own all text-track widths so long values cannot overflow a modal", () => {
    render(
      <TooltipProvider>
        <WorkspaceFolderRows
          items={[
            item({
              key: "/repo",
              displayName:
                "a-repository-name-long-enough-to-exceed-a-dialog-column",
              branchLabel:
                "traycer/a-target-branch-long-enough-to-exceed-a-dialog-column",
              currentIntent: {
                kind: "worktree",
                workspacePath: "/repo",
                repoIdentifier: { owner: "acme", repo: "app" },
                isPrimary: true,
                scripts: null,
                branch: {
                  type: "new",
                  name: "traycer/a-target-branch-long-enough-to-exceed-a-dialog-column",
                  source:
                    "release/a-base-branch-long-enough-to-exceed-a-dialog-column",
                  carryUncommittedChanges: false,
                },
              },
            }),
            item({ key: "/repo/infra", branchLabel: "main" }),
          ]}
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

    const grid = screen.getByTestId("workspace-folder-grid");
    expect(grid.className).toContain(
      "grid-cols-[1.5rem_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.5fr)_auto]",
    );
    expect(grid.className).not.toContain("max-content");

    const triggers = screen.getAllByTestId("folder-branch-trigger");
    expect(triggers).toHaveLength(2);
    for (const trigger of triggers) {
      expect(trigger.className).toContain("w-full");
      expect(trigger.className).toContain("max-w-full");
      expect(trigger.className).not.toContain("vw");
      expect(
        trigger.querySelector('[data-testid="folder-branch-label"]')?.className,
      ).toContain("min-w-0");
    }
    expect(screen.getAllByTestId("folder-chip")[0].className).toContain(
      "min-w-0",
    );
    expect(screen.getByTestId("folder-branch-target").className).toContain(
      "truncate",
    );
    expect(screen.getByTestId("folder-branch-source").className).toContain(
      "truncate",
    );
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

  it("shows the new target and its source in the collapsed workspace trigger", () => {
    render(
      <TooltipProvider>
        <WorkspaceSummaryTrigger
          items={[
            item({
              branchLabel: "traycer/new-feature",
              currentIntent: {
                kind: "worktree",
                workspacePath: "/repo",
                repoIdentifier: { owner: "acme", repo: "app" },
                isPrimary: true,
                scripts: null,
                branch: {
                  type: "new",
                  name: "traycer/new-feature",
                  source: "development",
                  carryUncommittedChanges: false,
                },
              },
            }),
          ]}
          readOnly={false}
          bindingResolved
        />
      </TooltipProvider>,
    );

    const trigger = screen.getByTestId("workspace-summary-trigger");
    expect(trigger.textContent).toContain("traycer/new-feature");
    expect(trigger.textContent).toContain("from development");
    expect(screen.getByTestId("folder-branch-source").className).toContain(
      "text-muted-foreground",
    );
  });

  it("resolves the collapsed summary by the marked isPrimary row, not array position", () => {
    render(
      <TooltipProvider>
        <WorkspaceSummaryTrigger
          items={[
            item({ key: "/repo", displayName: "repo", isPrimary: false }),
            item({
              key: "/repo2",
              displayName: "repo2",
              branchLabel: "main",
              isPrimary: true,
            }),
          ]}
          readOnly={false}
          bindingResolved
        />
      </TooltipProvider>,
    );
    const trigger = screen.getByTestId("workspace-summary-trigger");
    expect(trigger.textContent).toContain("repo2");
    expect(trigger.textContent).not.toContain("feat/x");
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

  it("hides the read-only hover preview while its inspect popover is open", async () => {
    render(
      <TooltipProvider delayDuration={0}>
        <WorkspaceSummaryTrigger
          items={[item({ mode: "local", displayPath: "/repo" })]}
          readOnly
          bindingResolved
        />
      </TooltipProvider>,
    );
    const trigger = screen.getByTestId("workspace-summary-trigger");
    // Hover opens the read-only preview card...
    fireEvent.focus(trigger);
    await waitFor(() => {
      expect(
        document.querySelector('[data-slot="hover-card-content"]'),
      ).not.toBeNull();
    });
    // ...and clicking to open the inspect popover must dismiss it. This is the
    // read-only sibling of the interactive coordination gate - the same
    // HoverCard-doesn't-close-on-trigger-click gap, guarded here too.
    fireEvent.click(trigger);
    await screen.findByTestId("workspace-readonly-folders-popover");
    await waitFor(() => {
      expect(
        document.querySelector('[data-slot="hover-card-content"]'),
      ).toBeNull();
    });
  });
});

describe("FolderBranchControl — Escape close", () => {
  const AUTOSAVE_DELAY_MS = 500;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("commits the pending autosave draft when Escape closes the popover", async () => {
    const onEmit = vi.fn<(intent: WorktreeFolderIntent) => void>();
    render(
      <TooltipProvider delayDuration={0}>
        <FolderBranchControl
          item={item({
            mode: "worktree",
            currentIntent: null,
            branchLabel: "traycer/swift-otter",
            summary: GIT_SUMMARY,
            onEmit,
          })}
          boundaryEl={null}
          readOnly={false}
        />
      </TooltipProvider>,
    );

    const chip = screen.getByRole("button", {
      name: "Choose worktree branch",
    });
    fireEvent.click(chip);
    const popover = await screen.findByTestId("folder-branch-popover");
    const name = screen.getByTestId("new-worktree-branch-name");
    fireEvent.change(name, { target: { value: "feat/escape-commits" } });
    expect(onEmit).not.toHaveBeenCalled();

    // Escape before debounce: unmount flush still commits (no cancel path).
    act(() => {
      vi.advanceTimersByTime(AUTOSAVE_DELAY_MS - 1);
    });
    expect(onEmit).not.toHaveBeenCalled();

    fireEvent.keyDown(popover, { key: "Escape", code: "Escape" });

    await act(async () => {
      await Promise.resolve();
      vi.advanceTimersByTime(AUTOSAVE_DELAY_MS + 200);
      await Promise.resolve();
    });

    expect(onEmit).toHaveBeenCalledTimes(1);
    expect(onEmit.mock.calls[0][0]).toMatchObject({
      branch: { name: "feat/escape-commits" },
    });
    expect(screen.queryByTestId("folder-branch-popover")).toBeNull();
  });

  it("returns focus to the chip on Escape without opening the chip tooltip from focus restore", async () => {
    render(
      <TooltipProvider delayDuration={0}>
        <FolderBranchControl
          item={item({
            mode: "worktree",
            currentIntent: null,
            branchLabel: "traycer/swift-otter",
            summary: GIT_SUMMARY,
          })}
          boundaryEl={null}
          readOnly={false}
        />
      </TooltipProvider>,
    );

    const chip = screen.getByRole("button", {
      name: "Choose worktree branch",
    });
    fireEvent.click(chip);
    const popover = await screen.findByTestId("folder-branch-popover");
    expect(popover).toBeTruthy();

    // Escape closes the popover and restores focus to the trigger. Production
    // arms suppress via onCloseAutoFocus (no preventDefault) so the chip
    // tooltip does not open solely from that focus return.
    fireEvent.keyDown(popover, { key: "Escape", code: "Escape" });
    await waitFor(() => {
      expect(screen.queryByTestId("folder-branch-popover")).toBeNull();
    });

    // Do not preventDefault onCloseAutoFocus for Escape — chip must regain focus.
    expect(document.activeElement).toBe(chip);

    // Drain focusin microtask + 150ms suppress fallback so any delayed open
    // would surface. With delayDuration={0}, a suppress miss would show a
    // tooltip role for the chip label.
    await act(async () => {
      await Promise.resolve();
      vi.advanceTimersByTime(200);
      await Promise.resolve();
    });

    expect(document.activeElement).toBe(chip);
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(
      document.querySelector(
        '[data-slot="tooltip-content"][data-state="open"]',
      ),
    ).toBeNull();
    expect(
      document.querySelector(
        '[data-slot="tooltip-content"][data-state="delayed-open"]',
      ),
    ).toBeNull();
  });
});

describe("WorkspaceFolderSummaryControl", () => {
  it("uses the rich hover preview instead of a competing native title", () => {
    render(
      <TooltipProvider>
        <WorkspaceFolderSummaryControl
          items={[item({})]}
          readOnly={false}
          bindingResolved
          addFolderPending={false}
          addFolderDisabled={false}
          addFolderDisabledReason={null}
          onAddFolder={NOOP_ADD}
          onUpdate={null}
          updateEnabled={false}
          updatePending={false}
          onDiscardStaged={null}
          onEditEnvironment={NOOP}
          popoverTestId="workspace-rows-popover"
          popoverSide="top"
        />
      </TooltipProvider>,
    );

    expect(
      screen.getByTestId("workspace-summary-trigger").getAttribute("title"),
    ).toBeNull();
  });

  it("renders the rich hover preview as a single HoverCard card carrying a reachable copy-path action", async () => {
    render(
      <TooltipProvider delayDuration={0}>
        <WorkspaceFolderSummaryControl
          items={[
            item({ mode: "local", displayPath: "/repo", currentIntent: null }),
          ]}
          readOnly={false}
          bindingResolved
          addFolderPending={false}
          addFolderDisabled={false}
          addFolderDisabledReason={null}
          onAddFolder={NOOP_ADD}
          onUpdate={null}
          updateEnabled={false}
          updatePending={false}
          onDiscardStaged={null}
          onEditEnvironment={NOOP}
          popoverTestId="workspace-rows-popover"
          popoverSide="top"
        />
      </TooltipProvider>,
    );

    const trigger = screen.getByTestId("workspace-summary-trigger");
    fireEvent.focus(trigger);

    const hoverContent = await waitFor(() => {
      const node = document.querySelector('[data-slot="hover-card-content"]');
      if (!(node instanceof HTMLElement)) {
        throw new Error("Expected hover card content element");
      }
      return node;
    });
    // The preview is a popover card, not the inverted tooltip chip: it drops
    // the chip's `max-w-xs` and owns its own width/padding.
    expect(hoverContent.className).not.toContain("max-w-xs");
    expect(hoverContent.className).toContain("bg-popover");

    // A HoverCard renders exactly one copy of its content - no visually-hidden
    // accessible clone - so the copy-path button exists once, not twice.
    const hoverLists = within(hoverContent).getAllByTestId(
      "workspace-folder-hover-list",
    );
    expect(hoverLists).toHaveLength(1);
    expect(
      within(hoverLists[0]).getByTestId("workspace-hover-run-path").textContent,
    ).toBe("/repo");
    expect(hoverLists[0].className).toContain("w-[min(92vw,24rem)]");

    const copyButtons = within(hoverContent).getAllByTestId(
      "workspace-hover-copy-path",
    );
    expect(copyButtons).toHaveLength(1);
    // The copy action is a real (non-inert) focusable control - it exists once
    // on the card, not duplicated into an a11y clone. NB: this asserts it is
    // focusable, not that it is in the sequential Tab order: hover-card content
    // is pointer-operable only (see hover-card.tsx), and copy-path's
    // keyboard-reachable home is the click-open folder rows.
    copyButtons[0].focus();
    expect(document.activeElement).toBe(copyButtons[0]);
  });

  it("shows full landing-page folder and branch provenance in the hover preview", async () => {
    render(
      <TooltipProvider delayDuration={0}>
        <WorkspaceFolderSummaryControl
          items={[
            item({
              displayName: "a-very-long-repository-name-that-is-truncated",
              branchLabel: "traycer/a-very-long-target-branch",
              currentIntent: {
                kind: "worktree",
                workspacePath: "/repo",
                repoIdentifier: { owner: "acme", repo: "app" },
                isPrimary: true,
                scripts: null,
                branch: {
                  type: "new",
                  name: "traycer/a-very-long-target-branch",
                  source: "release/a-very-long-base-branch",
                  carryUncommittedChanges: false,
                },
              },
            }),
          ]}
          readOnly={false}
          bindingResolved
          addFolderPending={false}
          addFolderDisabled={false}
          addFolderDisabledReason={null}
          onAddFolder={NOOP_ADD}
          onUpdate={null}
          updateEnabled={false}
          updatePending={false}
          onDiscardStaged={null}
          onEditEnvironment={NOOP}
          popoverTestId="workspace-rows-popover"
          popoverSide="top"
        />
      </TooltipProvider>,
    );

    const trigger = screen.getByTestId("workspace-summary-trigger");
    expect(trigger.getAttribute("title")).toBeNull();
    fireEvent.focus(trigger);
    const hoverList = await screen.findByTestId("workspace-folder-hover-list");
    expect(hoverList.textContent).toContain(
      "a-very-long-repository-name-that-is-truncated",
    );
    expect(hoverList.textContent).toContain(
      "traycer/a-very-long-target-branch",
    );
    expect(hoverList.textContent).toContain(
      "From release/a-very-long-base-branch",
    );
  });

  it("opens quietly without auto-focusing the Primary pin tooltip", async () => {
    render(
      <TooltipProvider>
        <WorkspaceFolderSummaryControl
          items={[item({ isPrimary: true })]}
          readOnly={false}
          bindingResolved
          addFolderPending={false}
          addFolderDisabled={false}
          addFolderDisabledReason={null}
          onAddFolder={NOOP_ADD}
          onUpdate={null}
          updateEnabled={false}
          updatePending={false}
          onDiscardStaged={null}
          onEditEnvironment={NOOP}
          popoverTestId="workspace-rows-popover"
          popoverSide="top"
        />
      </TooltipProvider>,
    );

    const trigger = screen.getByTestId("workspace-summary-trigger");
    trigger.focus();
    fireEvent.click(trigger);

    await screen.findByTestId("workspace-rows-popover");
    expect(document.activeElement).toBe(trigger);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("hides the hover preview while the click-open picker is open", async () => {
    render(
      <TooltipProvider delayDuration={0}>
        <WorkspaceFolderSummaryControl
          items={[item({ mode: "local", displayPath: "/repo" })]}
          readOnly={false}
          bindingResolved
          addFolderPending={false}
          addFolderDisabled={false}
          addFolderDisabledReason={null}
          onAddFolder={NOOP_ADD}
          onUpdate={null}
          updateEnabled={false}
          updatePending={false}
          onDiscardStaged={null}
          onEditEnvironment={NOOP}
          popoverTestId="workspace-rows-popover"
          popoverSide="top"
        />
      </TooltipProvider>,
    );

    const trigger = screen.getByTestId("workspace-summary-trigger");
    // Hover opens the preview card...
    fireEvent.focus(trigger);
    await waitFor(() => {
      expect(
        document.querySelector('[data-slot="hover-card-content"]'),
      ).not.toBeNull();
    });

    // ...but clicking to open the picker must dismiss it. A HoverCard, unlike a
    // Tooltip, does not close on the trigger's own click, so the control gates
    // the preview closed while the popover is open (regression guard).
    fireEvent.click(trigger);
    await screen.findByTestId("workspace-rows-popover");
    await waitFor(() => {
      expect(
        document.querySelector('[data-slot="hover-card-content"]'),
      ).toBeNull();
    });
  });

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
          popoverTestId="workspace-rows-popover"
          popoverSide="top"
        />
      </TooltipProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("workspace-rows-popover")).toBeTruthy();
    });
    expect(screen.getByTestId("workspace-rows-popover").className).toContain(
      "w-[min(92vw,42rem)]",
    );
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
