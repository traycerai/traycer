import { describe, expect, it } from "vitest";
import type { WorktreeIntent } from "@traycer/protocol/host/worktree-schemas";
import {
  takeArmedTeardownSubmit,
  worktreeCommitCaptureIsStale,
  type ArmedTeardownSubmit,
  type WorktreeCommitCapture,
} from "../worktree-commit-capture";

const draftA: WorktreeIntent = {
  entries: [
    {
      kind: "local",
      workspacePath: "/src/a",
      repoIdentifier: null,
      isPrimary: true,
    },
  ],
};
const draftB: WorktreeIntent = {
  entries: [
    {
      kind: "local",
      workspacePath: "/src/b",
      repoIdentifier: null,
      isPrimary: true,
    },
  ],
};

function capture(
  overrides: Partial<WorktreeCommitCapture>,
): WorktreeCommitCapture {
  return {
    draft: draftA,
    revision: 1,
    binding: { entries: [] },
    removedWorkspacePaths: [],
    stopTargets: [],
    ...overrides,
  };
}

describe("takeArmedTeardownSubmit", () => {
  it("consumes the armed payload so a later take cannot reuse it", () => {
    const slot: { current: ArmedTeardownSubmit<string> | null } = {
      current: { input: "send-a", capture: capture({}), ownerId: "chat-1" },
    };
    expect(takeArmedTeardownSubmit(slot)?.input).toBe("send-a");
    expect(takeArmedTeardownSubmit(slot)).toBeNull();
  });
});

describe("worktreeCommitCaptureIsStale", () => {
  it("is stale when staging mutates to a different draft after disclosure", () => {
    expect(
      worktreeCommitCaptureIsStale(
        capture({ draft: draftA, revision: 1 }),
        capture({ draft: draftB, revision: 2 }),
      ),
    ).toBe(true);
  });

  it("is stale when a folder is removed after disclosure", () => {
    expect(
      worktreeCommitCaptureIsStale(
        capture({ removedWorkspacePaths: [] }),
        capture({ removedWorkspacePaths: ["/src/b"] }),
      ),
    ).toBe(true);
  });

  it("is current when draft, revision, binding, and removals match", () => {
    const value = capture({
      draft: draftA,
      revision: 4,
      removedWorkspacePaths: ["/src/b"],
    });
    expect(worktreeCommitCaptureIsStale(value, { ...value })).toBe(false);
  });
});
