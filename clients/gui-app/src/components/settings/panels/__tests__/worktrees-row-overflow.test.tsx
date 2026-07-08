// This file deliberately does NOT mock "@/components/ui/dropdown-menu" (unlike
// worktrees-settings-panel.test.tsx, which renders it inline + always-open for
// easy assertions on the Filter/Sort menus). This file keeps the REAL primitive
// so row-utility menu mounting and keyboard access are tested against Radix.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { WorktreeHostEntryV11 } from "@traycer/protocol/host/index";
import { WorktreesList } from "@/components/settings/panels/worktrees-settings-panel";
import { installWorktreeVirtualizerOffsetHeight } from "./worktrees-virtualizer-test-utils";

function entry(
  over: Partial<WorktreeHostEntryV11> & {
    worktreePath: string;
    branch: string;
  },
): WorktreeHostEntryV11 {
  return {
    repoLabel: "acme/app",
    repoIdentifier: { owner: "acme", repo: "app" },
    inUse: false,
    uncommittedCount: 0,
    gitRemovable: true,
    scripts: null,
    owners: [],
    lastActivityAt: null,
    branchStatus: null,
    createdAt: null,
    prState: null,
    prNumber: null,
    prUrl: null,
    mergedHeadShaMatches: false,
    submodules: [],
    atBaseCommit: false,
    ...over,
  };
}

let restoreOffsetHeight: (() => void) | null = null;

beforeEach(() => {
  restoreOffsetHeight = installWorktreeVirtualizerOffsetHeight(() => 100_000);
});

afterEach(() => {
  if (restoreOffsetHeight !== null) {
    restoreOffsetHeight();
  }
  restoreOffsetHeight = null;
  cleanup();
});

function renderSingleRow(
  overrides: Partial<WorktreeHostEntryV11> & {
    worktreePath: string;
    branch: string;
  },
): void {
  const worktree = entry(overrides);
  const queryClient = new QueryClient();
  const Wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>{props.children}</TooltipProvider>
    </QueryClientProvider>
  );
  render(
    <Wrapper>
      <WorktreesList
        openStreamTransport={() => {
          throw new Error("delete is not exercised in this test file");
        }}
        hostId="host-a"
        worktrees={[worktree]}
        enrichedByPath={new Map([[worktree.worktreePath, worktree]])}
        erroredPaths={new Set()}
        onVisiblePathsChange={() => {}}
        taskTitlesByEpicId={new Map()}
        toolbarProps={{
          hosts: [],
          value: null,
          onChange: () => {},
          onRefresh: () => Promise.resolve(),
          refreshing: false,
          canRefresh: true,
        }}
      />
    </Wrapper>,
  );
}

describe("WorktreesList row overflow (real DropdownMenu)", () => {
  it("keeps all row actions in the compact overflow menu", () => {
    renderSingleRow({ worktreePath: "/wt/alpha", branch: "feat-alpha" });

    // Resting row: one quiet overflow trigger; no menu items or destructive
    // controls are mounted until the user opens it.
    screen.getByRole("button", { name: "Worktree actions for feat-alpha" });
    expect(screen.queryByRole("menuitem")).toBeNull();
    expect(
      screen.queryByRole("menuitem", { name: "Delete worktree feat-alpha" }),
    ).toBeNull();

    // Radix's DropdownMenuTrigger opens on pointerdown, not the click event.
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Worktree actions for feat-alpha" }),
      { button: 0 },
    );

    // Opened: utilities and destructive delete share the same compact menu.
    screen.getByRole("menuitem", { name: "Copy path" });
    screen.getByRole("menuitem", { name: "Manage script" });
    const deleteItem = screen.getByRole("menuitem", {
      name: "Delete worktree feat-alpha",
    });
    expect(deleteItem.getAttribute("data-variant")).toBe("destructive");
  });

  it("opens and activates an item entirely from the keyboard", () => {
    renderSingleRow({ worktreePath: "/wt/alpha", branch: "feat-alpha" });

    const trigger = screen.getByRole("button", {
      name: "Worktree actions for feat-alpha",
    });
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    // Enter opens the menu (Radix's own keydown handling, not a native
    // browser button-activation shortcut) and moves focus into it.
    fireEvent.keyDown(trigger, { key: "Enter" });
    const scriptsItem = screen.getByRole("menuitem", {
      name: "Manage script",
    });

    // Activate it from the keyboard, not by clicking.
    fireEvent.keyDown(scriptsItem, { key: "Enter" });

    screen.getByTestId("worktree-script-review-dialog");
  });

  it("disables the delete item for an in-use row without hiding it", () => {
    renderSingleRow({
      worktreePath: "/wt/busy",
      branch: "feat-busy",
      inUse: true,
    });

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Worktree actions for feat-busy" }),
      { button: 0 },
    );

    // Copy path and manage scripts stay usable while the row is in use.
    screen.getByRole("menuitem", { name: "Copy path" });
    screen.getByRole("menuitem", { name: "Manage script" });
    const deleteItem = screen.getByRole("menuitem", {
      name: "Delete worktree (in use by an active chat or agent)",
    });
    expect(deleteItem.getAttribute("aria-disabled")).toBe("true");
  });
});
