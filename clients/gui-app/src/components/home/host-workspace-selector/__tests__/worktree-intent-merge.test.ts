import { describe, expect, it } from "vitest";
import type {
  WorktreeEntryScripts,
  WorktreeFolderIntent,
} from "@traycer/protocol/host/worktree-schemas";
import {
  mergeWorktreeIntent,
  mergeWorktreeIntentEntry,
  removeWorktreeIntentEntry,
  restampWorktreeIntentPrimary,
  setWorktreeIntentEntryScripts,
} from "../worktree-intent-merge";

const SCRIPTS: WorktreeEntryScripts = {
  setup: { default: "bun install", macos: null, windows: null, linux: null },
  teardown: { default: "", macos: null, windows: null, linux: null },
};

function createEntry(input: {
  readonly workspacePath: string;
  readonly newBranch: string;
  readonly isPrimary: boolean;
}): WorktreeFolderIntent {
  return {
    kind: "worktree",
    scripts: null,
    workspacePath: input.workspacePath,
    repoIdentifier: null,
    isPrimary: input.isPrimary,
    branch: {
      type: "new",
      name: input.newBranch,
      source: "main",
      carryUncommittedChanges: false,
    },
  };
}

describe("worktree intent merge", () => {
  it("preserves previous workspace intent entries when scoped create capture adds another workspace", () => {
    const first = createEntry({
      workspacePath: "/workspace/first",
      newBranch: "traycer/first",
      isPrimary: true,
    });
    const second = createEntry({
      workspacePath: "/workspace/second",
      newBranch: "traycer/second",
      isPrimary: true,
    });

    expect(
      mergeWorktreeIntent({ entries: [first] }, { entries: [second] }),
    ).toEqual({
      entries: [{ ...first, isPrimary: false }, second],
    });
  });

  it("replaces an existing entry for the same workspace path", () => {
    const first = createEntry({
      workspacePath: "/workspace/first",
      newBranch: "traycer/first",
      isPrimary: true,
    });
    const second = createEntry({
      workspacePath: "/workspace/second",
      newBranch: "traycer/second",
      isPrimary: false,
    });
    const changedFirst = createEntry({
      workspacePath: "/workspace/first",
      newBranch: "traycer/changed",
      isPrimary: false,
    });

    expect(
      mergeWorktreeIntentEntry({ entries: [first, second] }, changedFirst),
    ).toEqual({
      entries: [second, changedFirst],
    });
  });

  it("removes entries by workspace path and returns null when none remain", () => {
    const first = createEntry({
      workspacePath: "/workspace/first",
      newBranch: "traycer/first",
      isPrimary: true,
    });
    const second = createEntry({
      workspacePath: "/workspace/second",
      newBranch: "traycer/second",
      isPrimary: false,
    });

    expect(
      removeWorktreeIntentEntry(
        { entries: [first, second] },
        first.workspacePath,
      ),
    ).toEqual({ entries: [second] });
    expect(
      removeWorktreeIntentEntry({ entries: [first] }, first.workspacePath),
    ).toBeNull();
  });

  it("sets the scripts override on a worktree entry, preserving its branch", () => {
    const entry = createEntry({
      workspacePath: "/workspace/first",
      newBranch: "traycer/first",
      isPrimary: true,
    });
    const next = setWorktreeIntentEntryScripts(
      { entries: [entry] },
      "/workspace/first",
      SCRIPTS,
    );
    const updated = next?.entries.find(
      (e) => e.workspacePath === "/workspace/first",
    );
    expect(updated?.kind).toBe("worktree");
    expect(updated?.kind === "worktree" ? updated.scripts : null).toEqual(
      SCRIPTS,
    );
    expect(updated?.kind === "worktree" ? updated.branch.name : null).toBe(
      "traycer/first",
    );
  });

  it("is a no-op (same reference) for a folder with no staged worktree entry", () => {
    const local: WorktreeFolderIntent = {
      kind: "local",
      workspacePath: "/workspace/local",
      repoIdentifier: null,
      isPrimary: true,
    };
    const intent = { entries: [local] };
    expect(
      setWorktreeIntentEntryScripts(intent, "/workspace/local", SCRIPTS),
    ).toBe(intent);
    expect(
      setWorktreeIntentEntryScripts(null, "/workspace/x", SCRIPTS),
    ).toBeNull();
  });

  describe("restampWorktreeIntentPrimary", () => {
    it("flips the target entry primary and demotes the previous primary, preserving scripts", () => {
      const first = {
        ...createEntry({
          workspacePath: "/workspace/first",
          newBranch: "traycer/first",
          isPrimary: true,
        }),
        scripts: SCRIPTS,
      };
      const second = createEntry({
        workspacePath: "/workspace/second",
        newBranch: "traycer/second",
        isPrimary: false,
      });

      const result = restampWorktreeIntentPrimary(
        { entries: [first, second] },
        "/workspace/second",
      );

      expect(result).toEqual({
        entries: [
          { ...first, isPrimary: false },
          { ...second, isPrimary: true },
        ],
      });
      const restampedFirst = result?.entries.find(
        (e) => e.workspacePath === "/workspace/first",
      );
      expect(
        restampedFirst?.kind === "worktree" ? restampedFirst.scripts : null,
      ).toEqual(SCRIPTS);
    });

    it("preserves entry identity (reference equality) for entries whose isPrimary bit doesn't change", () => {
      const first = createEntry({
        workspacePath: "/workspace/first",
        newBranch: "traycer/first",
        isPrimary: true,
      });
      const second = createEntry({
        workspacePath: "/workspace/second",
        newBranch: "traycer/second",
        isPrimary: false,
      });

      const result = restampWorktreeIntentPrimary(
        { entries: [first, second] },
        "/workspace/first",
      );

      // No entry's flag actually changes (first is already primary, second
      // already isn't), so the whole intent - and every entry - is the SAME
      // reference. This is the invariant `setPrimaryFolder` relies on to skip
      // a redundant staged-intent write.
      expect(result?.entries[0]).toBe(first);
      expect(result?.entries[1]).toBe(second);
    });

    it("never removes or reorders entries - a target with no staged entry only demotes others", () => {
      const first = createEntry({
        workspacePath: "/workspace/first",
        newBranch: "traycer/first",
        isPrimary: true,
      });
      const second = createEntry({
        workspacePath: "/workspace/second",
        newBranch: "traycer/second",
        isPrimary: false,
      });

      const result = restampWorktreeIntentPrimary(
        { entries: [first, second] },
        "/workspace/third",
      );

      expect(result?.entries.map((e) => e.workspacePath)).toEqual([
        "/workspace/first",
        "/workspace/second",
      ]);
      expect(result?.entries.every((e) => !e.isPrimary)).toBe(true);
    });

    it("returns null unchanged for a null intent", () => {
      expect(restampWorktreeIntentPrimary(null, "/workspace/first")).toBeNull();
    });
  });
});
