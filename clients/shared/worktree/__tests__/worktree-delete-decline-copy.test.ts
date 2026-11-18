import { describe, expect, it } from "vitest";
import type { WorktreeDeleteDeclinedKind } from "@traycer/protocol/host/worktree-delete-batch-stream";
import { worktreeDeleteDeclineMessage } from "../worktree-delete-decline-copy";

const GENERIC_MESSAGE =
  "Couldn't remove the worktree. It may still be in use - refresh and try again.";

describe("worktreeDeleteDeclineMessage", () => {
  it("keeps the generic line when the host named no decline kind", () => {
    expect(worktreeDeleteDeclineMessage(null, 1)).toBe(GENERIC_MESSAGE);
  });

  it("says something different for each decline kind", () => {
    const kinds: readonly WorktreeDeleteDeclinedKind[] = [
      "not_managed",
      "teardown_failed",
      "removal_failed",
    ];
    const messages = kinds.map((kind) => worktreeDeleteDeclineMessage(kind, 1));
    expect(new Set(messages).size).toBe(kinds.length);
    for (const message of messages) {
      expect(message).not.toBe(GENERIC_MESSAGE);
    }
  });

  it("tells the person nothing to delete, since a main worktree is not_managed too", () => {
    expect(worktreeDeleteDeclineMessage("not_managed", 1)).not.toMatch(
      /delete|try again/i,
    );
  });

  it("does not assume an open handle caused a failed removal", () => {
    expect(worktreeDeleteDeclineMessage("removal_failed", 1)).not.toMatch(
      /close|in use|using/i,
    );
  });

  it("speaks of one worktree for a count of 1 and of several for more", () => {
    expect(worktreeDeleteDeclineMessage("not_managed", 1)).toBe(
      "Traycer can't remove this folder because it isn't a worktree it manages, so it was left in place.",
    );
    expect(worktreeDeleteDeclineMessage("not_managed", 2)).toBe(
      "Traycer can't remove these folders because they aren't worktrees it manages, so they were left in place.",
    );
    expect(worktreeDeleteDeclineMessage("teardown_failed", 1)).toBe(
      "The teardown script didn't finish successfully, so the worktree was left in place - check the script and try again.",
    );
    expect(worktreeDeleteDeclineMessage("teardown_failed", 3)).toBe(
      "The teardown script didn't finish successfully, so the worktrees were left in place - check the script and try again.",
    );
    expect(worktreeDeleteDeclineMessage("removal_failed", 1)).toBe(
      "The worktree couldn't be fully removed and part of it may still be on disk - refresh the list and try again, or check the folder.",
    );
    expect(worktreeDeleteDeclineMessage("removal_failed", 2)).toBe(
      "The worktrees couldn't be fully removed and parts of them may still be on disk - refresh the list and try again, or check the folders.",
    );
  });

  it("keeps the plural wording free of the singular's delete and handle assumptions", () => {
    expect(worktreeDeleteDeclineMessage("not_managed", 2)).not.toMatch(
      /delete|try again/i,
    );
    expect(worktreeDeleteDeclineMessage("removal_failed", 2)).not.toMatch(
      /close|in use|using/i,
    );
  });
});
