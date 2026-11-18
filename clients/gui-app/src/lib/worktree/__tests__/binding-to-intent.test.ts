import { describe, expect, it } from "vitest";
import type {
  WorktreeBinding,
  WorktreeBindingEntry,
} from "@traycer/protocol/host/worktree-schemas";
import {
  bindingEntryToFolderIntent,
  bindingToWorktreeIntent,
} from "@/lib/worktree/binding-to-intent";

function bindingEntry(
  overrides: Partial<WorktreeBindingEntry>,
): WorktreeBindingEntry {
  return {
    workspacePath: "/a",
    mode: "local",
    repoIdentifier: null,
    worktreePath: null,
    branch: null,
    isPrimary: true,
    isImported: false,
    setupState: "not_required",
    setupTerminalSessionId: null,
    setupExitCode: null,
    setupFailedAt: null,
    createdAt: 0,
    ownedSubmodules: [],
    ...overrides,
  };
}

describe("bindingEntryToFolderIntent", () => {
  it("maps a worktree-bound entry to an import of its on-disk path", () => {
    expect(
      bindingEntryToFolderIntent(
        bindingEntry({ mode: "worktree", worktreePath: "/wt/feat" }),
        null,
        true,
      ),
    ).toEqual({
      kind: "import",
      workspacePath: "/a",
      repoIdentifier: null,
      isPrimary: true,
      worktreePath: "/wt/feat",
    });
  });

  it("maps a local entry to a local intent", () => {
    expect(
      bindingEntryToFolderIntent(bindingEntry({ mode: "local" }), null, false),
    ).toEqual({
      kind: "local",
      workspacePath: "/a",
      repoIdentifier: null,
      isPrimary: false,
    });
  });

  it("treats a worktree mode with no path as local (nothing to adopt)", () => {
    expect(
      bindingEntryToFolderIntent(
        bindingEntry({ mode: "worktree", worktreePath: null }),
        null,
        true,
      )?.kind,
    ).toBe("local");
  });

  it("returns null for a null entry", () => {
    expect(bindingEntryToFolderIntent(null, null, true)).toBeNull();
  });
});

describe("bindingToWorktreeIntent", () => {
  it("returns null for a null or empty binding", () => {
    expect(bindingToWorktreeIntent(null)).toBeNull();
    expect(bindingToWorktreeIntent({ entries: [] })).toBeNull();
  });

  it("projects every entry, re-stamping from the entry's own repo / primary", () => {
    const binding: WorktreeBinding = {
      entries: [
        bindingEntry({
          workspacePath: "/a",
          mode: "worktree",
          worktreePath: "/wt/a",
          isPrimary: true,
        }),
        bindingEntry({
          workspacePath: "/b",
          mode: "local",
          isPrimary: false,
        }),
      ],
    };
    const intent = bindingToWorktreeIntent(binding);
    expect(intent?.entries.map((e) => [e.workspacePath, e.kind])).toEqual([
      ["/a", "import"],
      ["/b", "local"],
    ]);
    expect(
      intent?.entries.find((e) => e.workspacePath === "/a")?.isPrimary,
    ).toBe(true);
  });
});
