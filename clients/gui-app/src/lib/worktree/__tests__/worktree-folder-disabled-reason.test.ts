import { describe, expect, it } from "vitest";
import type { WorktreeBindingSelectorRowV12 } from "@traycer/protocol/host";
import { worktreeRowState } from "@traycer-clients/shared/worktree/worktree-row-state";
import {
  formatWorktreeFolderDisabledReason,
  worktreeFolderRowBadge,
} from "@/lib/worktree/worktree-folder-disabled-reason";

/**
 * WHICH state a row is in is `clients/shared`'s ladder, tested exhaustively in
 * `clients/shared/worktree/__tests__/worktree-row-state.test.ts`. What is tested
 * here is the GUI's half: that each state renders with the tone and the
 * disabled/pending flags the pickers rely on, and — the part that is easy to
 * get wrong — that `disabled` tracks usability rather than badge visibility.
 */
function row(
  overrides: Partial<WorktreeBindingSelectorRowV12>,
): WorktreeBindingSelectorRowV12 {
  return {
    hostId: "host_1",
    runningDir: "/repo",
    workspacePath: "/repo",
    worktreePath: null,
    mode: "worktree",
    isGitRepo: true,
    repoIdentifier: null,
    branch: "main",
    isPrimary: false,
    isImported: false,
    setupState: "succeeded",
    disabledReason: null,
    sources: [],
    isGitResolvePending: false,
    ...overrides,
  };
}

describe("worktreeFolderRowBadge", () => {
  it("renders no badge for a healthy row", () => {
    expect(worktreeFolderRowBadge(row({}))).toBeNull();
  });

  it("renders a blocked row as an error the user cannot select", () => {
    expect(
      worktreeFolderRowBadge(row({ disabledReason: "missing_worktree_path" })),
    ).toStrictEqual({
      label: "missing",
      pending: false,
      disabled: true,
      tone: "error",
      detail:
        "This worktree is unavailable because its directory could not be found.",
    });
  });

  it("renders unresolved git facts as neutral 'checking', not as an error", () => {
    // A pending row may still converge to selectable, so it must not be
    // dressed in the destructive tone the resolved-missing row gets.
    expect(
      worktreeFolderRowBadge(
        row({
          disabledReason: "missing_worktree_path",
          isGitResolvePending: true,
        }),
      ),
    ).toStrictEqual({
      label: "checking",
      pending: true,
      disabled: true,
      tone: "neutral",
      detail: "Checking whether the worktree is available.",
    });
  });

  it.each([
    ["pending", "setup pending", "neutral", false],
    ["running", "setting up", "neutral", true],
    ["failed", "setup failed", "warning", false],
    ["cancelled", "setup cancelled", "warning", false],
  ] as const)(
    "reports setup %s as a visible but NON-blocking badge",
    (setupState, label, tone, pending) => {
      const badge = worktreeFolderRowBadge(row({ setupState }));
      expect(badge).not.toBeNull();
      expect(badge?.label).toBe(label);
      expect(badge?.tone).toBe(tone);
      expect(badge?.pending).toBe(pending);
      // The invariant the whole ladder exists to protect: a worktree whose
      // setup script failed is still a directory an agent can work in, so the
      // badge informs without taking the row away.
      expect(badge?.disabled).toBe(false);
    },
  );

  it("disables exactly the states the shared ladder calls unusable", () => {
    const rows = [
      row({}),
      row({ setupState: "pending" }),
      row({ setupState: "running" }),
      row({ setupState: "failed" }),
      row({ setupState: "cancelled" }),
      row({ disabledReason: "missing_worktree_path" }),
      row({
        disabledReason: "missing_worktree_path",
        isGitResolvePending: true,
      }),
      row({ disabledReason: "setup_failed", isGitRepo: false }),
      row({ disabledReason: "setup_failed", isGitRepo: true }),
    ];
    for (const candidate of rows) {
      const state = worktreeRowState(candidate);
      const unusable = state === "missing" || state === "checking";
      expect(worktreeFolderRowBadge(candidate)?.disabled ?? false).toBe(
        unusable,
      );
    }
  });
});

describe("formatWorktreeFolderDisabledReason", () => {
  it("names only genuine unavailability", () => {
    expect(
      formatWorktreeFolderDisabledReason(
        row({ disabledReason: "missing_worktree_path" }),
      ),
    ).toBe("missing");
  });

  it("is null for a row that is merely mid-setup", () => {
    // Both call sites render this as "Workspace unavailable: <reason>", so a
    // setup state leaking through here would tell the user a usable worktree
    // is gone.
    expect(
      formatWorktreeFolderDisabledReason(row({ setupState: "failed" })),
    ).toBeNull();
    expect(
      formatWorktreeFolderDisabledReason(
        row({ disabledReason: "setup_failed", isGitRepo: true }),
      ),
    ).toBeNull();
  });

  it("is null for a healthy row", () => {
    expect(formatWorktreeFolderDisabledReason(row({}))).toBeNull();
  });
});
