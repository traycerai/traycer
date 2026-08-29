import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
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

function renderList(onSelect: () => void): void {
  render(
    <WorktreeFolderList
      rows={[checkingRow()]}
      selectedRow={null}
      secondaryLabel={(row) => row.runningDir}
      rowBadge={() => DISABLED_BADGE}
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
    renderList(onSelect);

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
});
