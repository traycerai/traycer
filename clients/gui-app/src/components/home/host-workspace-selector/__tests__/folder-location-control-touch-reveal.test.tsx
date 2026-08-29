import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorktreeWorkspaceSummary } from "@traycer/protocol/host/worktree-schemas";
import { FolderLocationControl } from "@/components/home/host-workspace-selector/folder-location-control";
import type { WorkspaceRunItem } from "@/components/home/host-workspace-selector/workspace-run-item";

const WORKTREE_PATH = "/Users/me/worktrees/very/long/feature-login";

// Two worktrees, which is under the search threshold - the submenu opens
// straight onto the rows with no search field to focus first.
const SUMMARY: WorktreeWorkspaceSummary = {
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
      worktreePath: WORKTREE_PATH,
      branch: "feature/login",
      head: null,
      isMain: false,
      isLocked: false,
    },
  ],
  scripts: null,
};

function workspaceRunItem(
  onEmit: WorkspaceRunItem["onEmit"],
): WorkspaceRunItem {
  return {
    key: "/repo",
    displayName: "repo",
    displayPath: "/repo",
    unresolved: false,
    metadataPending: false,
    missing: false,
    isGitRepo: true,
    mode: "worktree",
    branchLabel: "feature/new",
    summary: SUMMARY,
    currentIntent: null,
    defaultNewBranchName: "traycer/swift-otter",
    branchPrefixWarning: null,
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
    onSelectMode: () => undefined,
    onEmit,
    onLocate: null,
    onMakePrimary: () => undefined,
    onRemove: null,
  };
}

/** Opens the Location menu and its "Existing worktree" submenu. */
async function openWorktreeSubmenu(): Promise<void> {
  fireEvent.pointerDown(screen.getByLabelText("Choose run location"), {
    button: 0,
    ctrlKey: false,
  });
  const existing = await screen.findByTestId("folder-location-existing");
  existing.focus();
  fireEvent.keyDown(existing, { key: "ArrowRight" });
  await screen.findByTestId("folder-location-existing-list");
}

/** The row's secondary path line - the element hover and press both hang off. */
function pathLine(): HTMLElement {
  const row = screen.getByTestId(`folder-location-import-${WORKTREE_PATH}`);
  return within(row).getByText(WORKTREE_PATH);
}

function press(element: HTMLElement, pointerType: "touch" | "mouse"): void {
  fireEvent.pointerDown(element, {
    clientX: 10,
    clientY: 10,
    pointerId: 1,
    pointerType,
    isPrimary: true,
  });
  act(() => {
    vi.advanceTimersByTime(500);
  });
}

describe("FolderLocationControl worktree path on touch", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("reveals the row's full path on a long press without adopting the worktree", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onEmit = vi.fn();
    render(
      <FolderLocationControl
        item={workspaceRunItem(onEmit)}
        uncommittedByPath={new Map()}
        boundaryEl={null}
        readOnly={false}
      />,
    );
    await openWorktreeSubmenu();

    const line = pathLine();
    press(line, "touch");

    // The sheet, not merely the string: the string is already in the row (the
    // truncation that hides it is CSS, which jsdom does not apply), so asserting
    // the text alone would pass against no change at all.
    const sheet = screen.getByRole("dialog");
    expect(sheet.textContent).toContain("Full path");
    expect(sheet.textContent).toContain(WORKTREE_PATH);

    // The sheet is rendered BY the menu row, so a menu that dismissed itself
    // would take the sheet down with it.
    expect(screen.getByTestId("folder-location-existing-list")).toBeTruthy();

    // The load-bearing case, and the one the press alone does not reach: a
    // pointer landing INSIDE the sheet is, to the menu, a pointer outside
    // itself. What stops the menu dismissing on it is a layer-index predicate
    // in Radix's dismissable layer, not hit-testing - the modal sheet is the
    // highest layer with outside pointer events disabled, so the menu's own
    // outside handler is skipped. That predicate is plain JS and runs here
    // exactly as it does in a browser.
    fireEvent.pointerDown(sheet, { pointerId: 2, pointerType: "touch" });
    expect(screen.getByTestId("folder-location-existing-list")).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();

    // And the press must not ALSO pick the worktree it was inspecting - the
    // browser still delivers a click to the menu item afterwards.
    fireEvent.click(line);
    expect(onEmit).not.toHaveBeenCalled();
  });

  it("leaves a mouse press to hover, which is the pointer's own route", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(
      <FolderLocationControl
        item={workspaceRunItem(vi.fn())}
        uncommittedByPath={new Map()}
        boundaryEl={null}
        readOnly={false}
      />,
    );
    await openWorktreeSubmenu();

    press(pathLine(), "mouse");

    // A held left button is an interrupted drag, not an intent, and a mouse
    // already reaches this path by hovering the same line.
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("abandons the press that turns into a scroll", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(
      <FolderLocationControl
        item={workspaceRunItem(vi.fn())}
        uncommittedByPath={new Map()}
        boundaryEl={null}
        readOnly={false}
      />,
    );
    await openWorktreeSubmenu();

    const line = pathLine();
    fireEvent.pointerDown(line, {
      clientX: 10,
      clientY: 10,
      pointerId: 1,
      pointerType: "touch",
      isPrimary: true,
    });
    fireEvent.pointerMove(line, {
      clientX: 10,
      clientY: 60,
      pointerId: 1,
      pointerType: "touch",
      isPrimary: true,
    });
    act(() => {
      vi.advanceTimersByTime(500);
    });

    // A submenu list scrolls. A sheet that opened under the finger doing it
    // would make the list unusable on the surface this exists for.
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
