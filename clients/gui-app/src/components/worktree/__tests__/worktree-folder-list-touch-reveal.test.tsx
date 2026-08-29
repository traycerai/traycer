import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorktreeBindingSelectorRowV12 } from "@traycer/protocol/host";
import { WorktreeFolderList } from "@/components/worktree/worktree-folder-list";
import type { WorktreeFolderRowBadge } from "@/lib/worktree/worktree-folder-disabled-reason";

const RUNNING_DIR = "/work/traycer-wt/feature-login";

function checkingRow(): WorktreeBindingSelectorRowV12 {
  return {
    hostId: "host-1",
    runningDir: RUNNING_DIR,
    workspacePath: "/work/traycer",
    worktreePath: RUNNING_DIR,
    mode: "worktree",
    isGitRepo: true,
    repoIdentifier: { owner: "traycer", repo: "traycer" },
    branch: "feature-login",
    isPrimary: false,
    isImported: false,
    setupState: "not_required",
    disabledReason: null,
    sources: [],
    isGitResolvePending: false,
  };
}

/**
 * The row is visible but not selectable. This is the case the press placement
 * turns on: a disabled `CommandItem` takes `pointer-events-none` for its whole
 * box, so a recognizer on the ROW would be dead here - on the one row whose
 * location someone most wants to read.
 */
const DISABLED_BADGE: WorktreeFolderRowBadge = {
  label: "checking",
  pending: true,
  tone: "neutral",
  detail: "Checking whether the worktree is available.",
  disabled: true,
};

/**
 * A ready row, which is the only kind that can prove anything about the sheet's
 * dismissal: `WorktreeFolderList` returns before `onSelect` when a row is
 * disabled, so asserting "the row was not selected" against a DISABLED row
 * passes whether or not the click reached it.
 */
const READY_BADGE: WorktreeFolderRowBadge | null = null;

function renderList(
  onSelect: () => void,
  badge: WorktreeFolderRowBadge | null,
): void {
  render(
    <WorktreeFolderList
      rows={[checkingRow()]}
      selectedRow={null}
      secondaryLabel={(row) => row.runningDir}
      rowBadge={() => badge}
      onSelect={onSelect}
      autoFocusSearch={false}
      emptyMessage="No directories in this task."
    />,
  );
}

describe("WorktreeFolderList path on touch", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("reveals a disabled row's path on a long press, and still refuses to select it", () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onSelect = vi.fn();
    renderList(onSelect, DISABLED_BADGE);

    const line = screen.getByText(RUNNING_DIR);
    fireEvent.pointerDown(line, {
      clientX: 10,
      clientY: 10,
      pointerId: 1,
      pointerType: "touch",
      isPrimary: true,
    });
    act(() => {
      vi.advanceTimersByTime(500);
    });

    const sheet = screen.getByRole("dialog");
    expect(sheet.textContent).toContain("Full path");
    expect(sheet.textContent).toContain(RUNNING_DIR);

    fireEvent.click(line);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("does not select the row underneath when the sheet is dismissed", () => {
    // A device run saw a terminal launch when the sheet's Close was tapped,
    // and could not tell a real pass-through from an artefact of synthetic
    // input. This is the half that is decidable here: dismissing the sheet
    // must not reach the row that raised it. A row-level recognizer, or a
    // sheet rendered inside the row's own click path, would fail this.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onSelect = vi.fn();
    // ENABLED, deliberately: the disabled arm returns before `onSelect`, so the
    // same assertion against a disabled row would pass without the sheet
    // containing anything.
    renderList(onSelect, READY_BADGE);

    const line = screen.getByText(RUNNING_DIR);
    fireEvent.pointerDown(line, {
      clientX: 10,
      clientY: 10,
      pointerId: 1,
      pointerType: "touch",
      isPrimary: true,
    });
    act(() => {
      vi.advanceTimersByTime(500);
    });

    // Every surface inside the sheet, not just Close. A portal's clicks bubble
    // through React ancestry regardless of which element they start on, so the
    // path text a user selects and the overlay they tap to dismiss reach the
    // row exactly as the button does.
    const sheet = screen.getByRole("dialog");
    fireEvent.click(within(sheet).getByText(RUNNING_DIR));
    expect(onSelect).not.toHaveBeenCalled();

    // The overlay too: it is a sibling of the content inside the same portal,
    // so it shares the row's React ancestry exactly as the content does.
    const overlay = document.querySelector('[data-slot="sheet-overlay"]');
    // Asserted, not guarded: a `if (overlay !== null)` here would skip silently
    // the day the slot is renamed, which is the same shape as the disabled-row
    // fixture this test was just rescued from.
    if (!(overlay instanceof Element)) {
      throw new Error("the sheet rendered no overlay");
    }
    fireEvent.click(overlay);
    expect(onSelect).not.toHaveBeenCalled();

    const close = within(sheet).getByRole("button", { name: /close/i });
    fireEvent.click(close);

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
  });
});
