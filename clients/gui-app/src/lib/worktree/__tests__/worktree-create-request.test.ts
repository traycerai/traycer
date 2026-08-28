import { describe, expect, it } from "vitest";
import { worktreeCreateEntries } from "../worktree-create-request";

const baseEntry = {
  kind: "worktree" as const,
  workspacePath: "/repo",
  repoIdentifier: null,
  isPrimary: true,
  scripts: null,
  branch: {
    type: "new" as const,
    name: "gentle-yak",
    source: "development",
    carryUncommittedChanges: false,
  },
};

describe("worktreeCreateEntries", () => {
  it("defaults a pre-policy persisted intent to fail", () => {
    const entry = worktreeCreateEntries([baseEntry])[0];
    if (entry.kind !== "worktree") throw new Error("expected worktree entry");
    expect(entry.branch).toMatchObject({
      collision: "fail",
    });
  });

  it("preserves random retry identity on a fresh generated intent", () => {
    const entry = worktreeCreateEntries([
      {
        ...baseEntry,
        branch: {
          ...baseEntry.branch,
          collision: "random",
          retryIdentity: "retry-identity",
        },
      },
    ])[0];
    if (entry.kind !== "worktree") throw new Error("expected worktree entry");
    expect(entry.branch).toMatchObject({
      collision: "random",
      retryIdentity: "retry-identity",
    });
  });
});
