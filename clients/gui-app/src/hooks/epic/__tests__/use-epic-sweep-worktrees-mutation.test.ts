import { describe, expect, it } from "vitest";
import {
  sweepWorktreeSummary,
  sweepingWorktreePathsForHost,
} from "@/hooks/epic/use-epic-sweep-worktrees-mutation";

describe("sweepWorktreeSummary", () => {
  it("reports a fully observed sweep as successful", () => {
    expect(
      sweepWorktreeSummary({
        removed: ["/wt/a", "/wt/b"],
        failed: [],
        uncertain: [],
      }),
    ).toEqual({ level: "success", message: "2 worktrees swept" });
  });

  it("keeps unconfirmed targets distinct from filesystem failures", () => {
    expect(
      sweepWorktreeSummary({
        removed: ["/wt/a"],
        failed: ["/wt/b"],
        uncertain: ["/wt/c", "/wt/d"],
      }),
    ).toEqual({
      level: "warning",
      message:
        "1 worktree swept, 1 worktree couldn't be removed, 2 worktrees unconfirmed",
    });
  });

  it("says nothing when no worktree was part of the command", () => {
    expect(
      sweepWorktreeSummary({ removed: [], failed: [], uncertain: [] }),
    ).toBeNull();
  });
});

describe("sweepingWorktreePathsForHost", () => {
  const target = (worktreePath: string) => ({
    worktreePath,
    branch: null,
    repoIdentifier: null,
    stopOwners: false,
  });

  it("does not let a sweep on one host reserve the same path on another", () => {
    const pending = [
      { hostId: "host-1", worktrees: [target("/wt/shared")] },
      { hostId: "host-2", worktrees: [target("/wt/shared"), target("/wt/b")] },
    ];

    expect([...sweepingWorktreePathsForHost(pending, "host-1")]).toEqual([
      "/wt/shared",
    ]);
    expect([...sweepingWorktreePathsForHost(pending, "host-2")]).toEqual([
      "/wt/shared",
      "/wt/b",
    ]);
    expect([...sweepingWorktreePathsForHost(pending, null)]).toEqual([]);
  });
});
