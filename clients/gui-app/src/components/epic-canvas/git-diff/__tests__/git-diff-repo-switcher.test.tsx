import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { WorktreeBindingSelectorRow } from "@traycer/protocol/host";
import type { GitSubmoduleSummary } from "@/lib/git/git-repo-tree";
import {
  buildGitDiffRepoSwitcherModel,
  type GitDiffRepoSelection,
  type GitDiffRepoSwitcherRootInput,
} from "@/lib/git/git-diff-repo-switcher";
import {
  GitDiffRepoSwitcher,
  GitDiffRepoSwitcherDropdown,
} from "../git-diff-repo-switcher";

function row(
  overrides: Partial<WorktreeBindingSelectorRow>,
): WorktreeBindingSelectorRow {
  return {
    hostId: "host-1",
    runningDir: "/repo",
    workspacePath: "/repo",
    worktreePath: null,
    mode: "local",
    isGitRepo: true,
    repoIdentifier: { owner: "acme", repo: "traycer-internal" },
    branch: "development",
    isPrimary: true,
    isImported: false,
    setupState: "not_required",
    disabledReason: null,
    sources: [],
    ...overrides,
  };
}

function submoduleNode(
  overrides: Partial<GitSubmoduleSummary>,
): GitSubmoduleSummary {
  return {
    repoRoot: "/repo/vendor/traycer",
    parentPath: "vendor/traycer",
    label: "vendor/traycer",
    headLabel: "feature/submodule-ui",
    changeCount: 2,
    hasChanges: true,
    unavailable: false,
    ...overrides,
  };
}

function selection(
  overrides: Partial<GitDiffRepoSelection>,
): GitDiffRepoSelection {
  return {
    hostId: "host-1",
    rootRunningDir: "/repo",
    repoRoot: "/repo",
    ...overrides,
  };
}

function roots(): ReadonlyArray<GitDiffRepoSwitcherRootInput> {
  return [
    { row: row({}), fileChangeCount: 4, moduleChangeCount: 1 },
    {
      row: row({
        runningDir: "/notes",
        workspacePath: "/notes",
        repoIdentifier: null,
        branch: null,
        isGitRepo: false,
      }),
      fileChangeCount: null,
      moduleChangeCount: null,
    },
    {
      row: row({
        runningDir: "/other/repo",
        workspacePath: "/other/repo",
        repoIdentifier: { owner: "acme", repo: "other-repo" },
        branch: "main",
      }),
      fileChangeCount: 0,
      moduleChangeCount: 0,
    },
    {
      row: row({
        runningDir: "/setup-failed",
        workspacePath: "/setup-failed",
        repoIdentifier: { owner: "acme", repo: "setup-failed" },
        branch: "feature/setup",
        disabledReason: "setup_failed",
      }),
      fileChangeCount: null,
      moduleChangeCount: null,
    },
  ];
}

function changedSubmodules(): ReadonlyArray<GitSubmoduleSummary> {
  return [
    submoduleNode({}),
    submoduleNode({
      repoRoot: "/repo/clean-lib",
      parentPath: "clean-lib",
      label: "clean-lib",
      headLabel: "main",
      changeCount: 0,
      hasChanges: false,
    }),
  ];
}

function unavailableSubmodules(): ReadonlyArray<GitSubmoduleSummary> {
  return [
    submoduleNode({
      repoRoot: "/repo/broken",
      parentPath: "broken",
      label: "broken",
      headLabel: "detached",
      changeCount: 0,
      hasChanges: false,
      unavailable: true,
    }),
  ];
}

function referenceOnlySubmodules(): ReadonlyArray<GitSubmoduleSummary> {
  return [
    submoduleNode({
      changeCount: 0,
      hasChanges: true,
    }),
  ];
}

function DropdownHarness(props: {
  readonly selected: GitDiffRepoSelection;
  readonly submodules: ReadonlyArray<GitSubmoduleSummary>;
  readonly onSelectRoot: (row: WorktreeBindingSelectorRow) => void;
}) {
  const [query, setQuery] = useState("");
  const model = buildGitDiffRepoSwitcherModel({
    roots: roots(),
    activeRootSubmodules: props.submodules,
    selected: props.selected,
    searchQuery: query,
  });

  return (
    <GitDiffRepoSwitcherDropdown
      model={model}
      searchQuery={query}
      onSearchQueryChange={setQuery}
      onSelectRoot={props.onSelectRoot}
      autoFocusSearch={false}
    />
  );
}

describe("<GitDiffRepoSwitcherDropdown />", () => {
  afterEach(() => cleanup());

  it("renders the compact trigger with typed module and file count badges", () => {
    render(
      <GitDiffRepoSwitcher
        open={false}
        onOpenChange={vi.fn()}
        roots={roots()}
        activeRootSubmodules={changedSubmodules()}
        selected={selection({ repoRoot: "/repo/vendor/traycer" })}
        onSelectRoot={vi.fn()}
        hostSection={null}
        autoFocusSearch={false}
        triggerClassName={undefined}
        contentClassName={undefined}
        triggerTestId="repo-switcher-trigger"
        contentTestId="repo-switcher-content"
      />,
    );

    expect(screen.getByTestId("repo-switcher-trigger").textContent).toContain(
      "traycer-internal",
    );
    expect(
      screen.getByTestId("repo-switcher-trigger").textContent,
    ).not.toContain("vendor/traycer");
    expect(
      screen.getByTestId("repo-switcher-trigger").getAttribute("title"),
    ).toContain(`Path: /repo`);
    expect(
      screen.getByTestId("repo-switcher-trigger").getAttribute("title"),
    ).toContain("1 changed submodule");
    expect(
      screen.getByTestId("repo-switcher-trigger").getAttribute("title"),
    ).toContain("6 changed files");
    expect(
      screen.getByRole("button", {
        name: /Git workspace,\s*traycer-internal,.*1 changed submodule, 6 changed files/,
      }),
    ).toBeDefined();
    expect(screen.getByLabelText("1 changed submodule")).toBeDefined();
    expect(screen.getByLabelText("6 changed files")).toBeDefined();
  });

  it("opens as a labelled popover dialog and focuses the search input", () => {
    render(
      <GitDiffRepoSwitcher
        open
        onOpenChange={vi.fn()}
        roots={roots()}
        activeRootSubmodules={changedSubmodules()}
        selected={selection({})}
        onSelectRoot={vi.fn()}
        hostSection={null}
        autoFocusSearch
        triggerClassName={undefined}
        contentClassName={undefined}
        triggerTestId="repo-switcher-trigger"
        contentTestId="repo-switcher-content"
      />,
    );

    const trigger = screen.getByTestId("repo-switcher-trigger");
    const dialog = screen.getByRole("dialog", {
      name: "Git workspace selector",
    });
    const search = screen.getByRole("textbox", {
      name: "Search workspaces",
    });
    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(trigger.getAttribute("aria-controls")).toBe(dialog.id);
    expect(document.activeElement).toBe(search);
  });

  it("marks an unavailable trigger without using aria-invalid", () => {
    render(
      <GitDiffRepoSwitcher
        open={false}
        onOpenChange={vi.fn()}
        roots={roots()}
        activeRootSubmodules={[]}
        selected={selection({
          rootRunningDir: "/missing",
          repoRoot: "/missing",
        })}
        onSelectRoot={vi.fn()}
        hostSection={null}
        autoFocusSearch={false}
        triggerClassName={undefined}
        contentClassName={undefined}
        triggerTestId="repo-switcher-trigger"
        contentTestId="repo-switcher-content"
      />,
    );

    const trigger = screen.getByTestId("repo-switcher-trigger");
    expect(trigger.getAttribute("data-unavailable")).toBe("true");
    expect(trigger.getAttribute("aria-invalid")).toBeNull();
    expect(trigger.getAttribute("aria-label")).toContain("unavailable");
    expect(trigger.getAttribute("title")).toContain("Status: unavailable");
  });

  it("renders workspace rows only with stable path subtext", () => {
    render(
      <DropdownHarness
        selected={selection({})}
        submodules={changedSubmodules()}
        onSelectRoot={vi.fn()}
      />,
    );

    const options = screen.getAllByRole("option");
    const root = screen.getByTestId(
      "git-diff-repo-switcher-root-traycer-internal",
    );

    expect(options).toHaveLength(roots().length);
    expect(
      options.every((option) => option.getAttribute("data-kind") === "root"),
    ).toBe(true);
    expect(root.getAttribute("aria-selected")).toBe("true");
    expect(root.getAttribute("data-depth")).toBe("0");
    expect(root.textContent).toContain("/repo");
    expect(root.textContent).not.toContain("3 submodules · 2 changed");
    expect(screen.getAllByLabelText("1 changed submodule")).toHaveLength(1);
    expect(screen.getByLabelText("6 changed files")).toBeDefined();
    expect(root.textContent).toContain("6");
    expect(
      screen.queryByTestId("git-diff-repo-switcher-submodule-vendor/traycer"),
    ).toBeNull();
  });

  it("keeps unavailable submodule status out of the visible row", () => {
    render(
      <DropdownHarness
        selected={selection({})}
        submodules={unavailableSubmodules()}
        onSelectRoot={vi.fn()}
      />,
    );

    const root = screen.getByTestId(
      "git-diff-repo-switcher-root-traycer-internal",
    );
    expect(root.textContent).toContain("/repo");
    expect(root.textContent).not.toContain("submodule status unavailable");
    expect(
      screen.queryByTestId("git-diff-repo-switcher-submodule-broken"),
    ).toBeNull();
  });

  it("keeps parent-reference-only module changes out of the visible row", () => {
    const rootFixture = roots()[0];
    const model = buildGitDiffRepoSwitcherModel({
      roots: [
        {
          row: rootFixture.row,
          fileChangeCount: 0,
          moduleChangeCount: 1,
        },
      ],
      activeRootSubmodules: referenceOnlySubmodules(),
      selected: selection({}),
      searchQuery: "",
    });

    render(
      <GitDiffRepoSwitcherDropdown
        model={model}
        searchQuery=""
        onSearchQueryChange={vi.fn()}
        onSelectRoot={vi.fn()}
        autoFocusSearch={false}
      />,
    );

    const root = screen.getByTestId(
      "git-diff-repo-switcher-root-traycer-internal",
    );
    expect(root.textContent).toContain("/repo");
    expect(root.textContent).not.toContain("2 submodules · 1 changed");
    expect(screen.getByLabelText("1 changed submodule")).toBeDefined();
    expect(screen.queryByLabelText("1 changed file")).toBeNull();
    expect(
      screen.queryByTestId("git-diff-repo-switcher-submodule-vendor/traycer"),
    ).toBeNull();
  });

  it("renders disabled non-Git roots and blocks selection", () => {
    const onSelectRoot = vi.fn();
    render(
      <DropdownHarness
        selected={selection({})}
        submodules={changedSubmodules()}
        onSelectRoot={onSelectRoot}
      />,
    );

    const disabled = screen.getByTestId("git-diff-repo-switcher-root-notes");
    const setupFailed = screen.getByTestId(
      "git-diff-repo-switcher-root-setup-failed",
    );
    expect(disabled.getAttribute("aria-disabled")).toBe("true");
    expect(disabled.textContent).toContain("not git");
    expect(setupFailed.getAttribute("aria-disabled")).toBe("true");
    expect(setupFailed.textContent).toContain("failed");

    fireEvent.click(disabled);
    fireEvent.click(setupFailed);
    expect(onSelectRoot).not.toHaveBeenCalled();
  });

  it("moves keyboard focus through workspace rows only", () => {
    render(
      <DropdownHarness
        selected={selection({})}
        submodules={changedSubmodules()}
        onSelectRoot={vi.fn()}
      />,
    );

    const root = screen.getByTestId(
      "git-diff-repo-switcher-root-traycer-internal",
    );
    const disabled = screen.getByTestId("git-diff-repo-switcher-root-notes");
    const otherRoot = screen.getByTestId(
      "git-diff-repo-switcher-root-other-repo",
    );
    const setupFailed = screen.getByTestId(
      "git-diff-repo-switcher-root-setup-failed",
    );

    root.focus();
    fireEvent.keyDown(root, { key: "ArrowDown" });
    expect(document.activeElement).toBe(disabled);
    fireEvent.keyDown(disabled, { key: "End" });
    expect(document.activeElement).toBe(setupFailed);
    fireEvent.keyDown(setupFailed, { key: "ArrowUp" });
    expect(document.activeElement).toBe(otherRoot);
    fireEvent.keyDown(otherRoot, { key: "Home" });
    expect(document.activeElement).toBe(root);
  });

  it("filters by submodule search text while returning the parent workspace row", () => {
    render(
      <DropdownHarness
        selected={selection({})}
        submodules={changedSubmodules()}
        onSelectRoot={vi.fn()}
      />,
    );

    fireEvent.change(
      screen.getByRole("textbox", { name: "Search workspaces" }),
      {
        target: { value: "feature/submodule-ui" },
      },
    );

    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(
      screen.getByTestId("git-diff-repo-switcher-root-traycer-internal"),
    ).toBeDefined();
    expect(
      screen.queryByTestId("git-diff-repo-switcher-submodule-vendor/traycer"),
    ).toBeNull();
    expect(
      screen.queryByTestId("git-diff-repo-switcher-root-other-repo"),
    ).toBeNull();
  });

  it("selects only workspace rows and closes the switcher through the root callback", () => {
    const onSelectRoot = vi.fn();
    render(
      <GitDiffRepoSwitcher
        open
        onOpenChange={vi.fn()}
        roots={roots()}
        activeRootSubmodules={changedSubmodules()}
        selected={selection({})}
        onSelectRoot={onSelectRoot}
        hostSection={null}
        autoFocusSearch={false}
        triggerClassName={undefined}
        contentClassName={undefined}
        triggerTestId="repo-switcher-trigger"
        contentTestId="repo-switcher-content"
      />,
    );

    fireEvent.click(
      screen.getByTestId("git-diff-repo-switcher-root-other-repo"),
    );
    expect(onSelectRoot).toHaveBeenCalledWith(
      expect.objectContaining({ runningDir: "/other/repo" }),
    );
    expect(
      screen.queryByTestId("git-diff-repo-switcher-submodule-vendor/traycer"),
    ).toBeNull();
  });
});
