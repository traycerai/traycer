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
    ).toEqual({
      level: "success",
      message: "2 worktrees swept",
      detail: null,
    });
  });

  it("keeps unconfirmed targets distinct from filesystem failures", () => {
    expect(
      sweepWorktreeSummary({
        removed: ["/wt/a"],
        failed: [
          {
            worktreePath: "/wt/b",
            reason: "The worktree is still in use by an agent.",
          },
        ],
        uncertain: ["/wt/c", "/wt/d"],
      }),
    ).toEqual({
      level: "warning",
      message:
        "1 worktree swept, 1 worktree couldn't be removed, 2 worktrees unconfirmed",
      detail: "/wt/b: The worktree is still in use by an agent.",
    });
  });

  // The reason the host gave is the whole point of the detail line: before
  // this, the stream delivered it and the sweep toast dropped it on the floor,
  // leaving `host.log` as the only place it existed.
  it("carries the host's reason for a single failure", () => {
    const summary = sweepWorktreeSummary({
      removed: [],
      failed: [
        {
          worktreePath: "/wt/busy",
          reason: "Its teardown script failed; the worktree was left in place.",
        },
      ],
      uncertain: [],
    });

    expect(summary?.detail).toBe(
      "/wt/busy: Its teardown script failed; the worktree was left in place.",
    );
  });

  // A `deleted: false` decline arrives with no reason string at all. Fixed
  // copy, never `undefined` rendered into the toast.
  it("substitutes fixed copy for a decline that carried no reason", () => {
    const summary = sweepWorktreeSummary({
      removed: [],
      failed: [
        { worktreePath: "/wt/x", reason: "The host declined the deletion." },
      ],
      uncertain: [],
    });

    expect(summary?.detail).toBe("/wt/x: The host declined the deletion.");
    expect(summary?.detail).not.toContain("undefined");
  });

  it("lists reasons for three failures", () => {
    const summary = sweepWorktreeSummary({
      removed: [],
      failed: [
        { worktreePath: "/wt/a", reason: "Removing it failed." },
        { worktreePath: "/wt/b", reason: "Removing it failed." },
        { worktreePath: "/wt/c", reason: "Removing it failed." },
      ],
      uncertain: [],
    });

    expect(summary?.detail).toBe(
      "/wt/a: Removing it failed. · /wt/b: Removing it failed. · /wt/c: Removing it failed.",
    );
  });

  // Past three, the list stops being a sentence and becomes a log. The count
  // line in `message` still tells the user how many, and Settings ▸ Worktrees
  // plus the durable row carry the per-path detail.
  it("falls back to the count line alone beyond three failures", () => {
    const summary = sweepWorktreeSummary({
      removed: [],
      failed: ["/wt/a", "/wt/b", "/wt/c", "/wt/d"].map((worktreePath) => ({
        worktreePath,
        reason: "Removing it failed.",
      })),
      uncertain: [],
    });

    expect(summary).toEqual({
      level: "warning",
      message: "4 worktrees couldn't be removed",
      detail: null,
    });
  });

  it("says nothing when no worktree was part of the command", () => {
    expect(
      sweepWorktreeSummary({
        removed: [],
        failed: [],
        uncertain: [],
      }),
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
