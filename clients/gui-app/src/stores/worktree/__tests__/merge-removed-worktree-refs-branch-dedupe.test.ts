/**
 * `mergeRemovedWorktreeRefs` folds newly observed sweep evidence into
 * evidence already held. The branch list must be DEDUPED by repo-qualified
 * identity, not concatenated: a caller that folds the same observation
 * repeatedly (the consumer-observing subscription does, once per staging
 * mutation, for as long as a hash-only send stays live) would otherwise grow
 * an unbounded list of identical records - 101 copies after 101 unchanged
 * observations - when every reader of the list only ever asks "was this
 * branch removed", an identity question plain concatenation answers no
 * better with 101 entries than with one.
 */
import { describe, expect, it } from "vitest";

import { mergeRemovedWorktreeRefs } from "@/stores/worktree/worktree-intent-staging-store";
import type { RemovedWorktreeRefs } from "@/lib/worktree/removed-worktree-refs";

describe("mergeRemovedWorktreeRefs: branch identity, not arrival count", () => {
  it("folding the SAME branch observation 101 times yields exactly one branch record (DRIVE RED)", () => {
    const observation: RemovedWorktreeRefs = {
      worktreePaths: new Set(["/repo-dedupe"]),
      branches: [
        {
          repoIdentifier: { owner: "acme", repo: "app" },
          branch: "feat/x",
        },
      ],
    };

    let held: RemovedWorktreeRefs | null = null;
    for (let i = 0; i < 101; i += 1) {
      held = mergeRemovedWorktreeRefs(held, observation);
    }

    expect(held).not.toBeNull();
    if (held === null) throw new Error("expected merged refs");
    expect(held.branches).toHaveLength(1);
    expect(held.branches[0]).toEqual({
      repoIdentifier: { owner: "acme", repo: "app" },
      branch: "feat/x",
    });
  });

  it("a DIFFERENT branch (or repo) still accumulates as its own record", () => {
    const first: RemovedWorktreeRefs = {
      worktreePaths: new Set(),
      branches: [
        { repoIdentifier: { owner: "acme", repo: "app" }, branch: "feat/x" },
      ],
    };
    const sameNameOtherRepo: RemovedWorktreeRefs = {
      worktreePaths: new Set(),
      branches: [
        { repoIdentifier: { owner: "acme", repo: "other" }, branch: "feat/x" },
      ],
    };
    const differentBranch: RemovedWorktreeRefs = {
      worktreePaths: new Set(),
      branches: [
        { repoIdentifier: { owner: "acme", repo: "app" }, branch: "feat/y" },
      ],
    };

    let held: RemovedWorktreeRefs | null = mergeRemovedWorktreeRefs(
      null,
      first,
    );
    held = mergeRemovedWorktreeRefs(held, sameNameOtherRepo);
    held = mergeRemovedWorktreeRefs(held, differentBranch);
    // Re-fold the very first observation again - it must not re-appear.
    held = mergeRemovedWorktreeRefs(held, first);

    expect(held?.branches).toHaveLength(3);
  });
});
