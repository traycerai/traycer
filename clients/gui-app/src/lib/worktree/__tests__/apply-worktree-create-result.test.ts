import { describe, expect, it } from "vitest";
import type {
  WorktreeCreateResponse,
  WorktreeIntent,
} from "@traycer/protocol/host/worktree-schemas";
import {
  applyWorktreeCreateResult,
  type WorktreeCreateResultActions,
} from "@/lib/worktree/apply-worktree-create-result";

type WorktreeIntentEntry = WorktreeIntent["entries"][number];
type WorktreePerEntryResult = WorktreeCreateResponse["perEntry"][number];

function worktreeEntry(workspacePath: string): WorktreeIntentEntry {
  return {
    workspacePath,
    kind: "worktree",
    repoIdentifier: { owner: "traycerai", repo: "traycer" },
    branch: {
      type: "new",
      name: "feature/x",
      source: "main",
      carryUncommittedChanges: false,
    },
    scripts: null,
    isPrimary: true,
  };
}

function perEntryResult(
  workspacePath: string,
  ok: boolean,
  errorMessage: string | null,
): WorktreePerEntryResult {
  return {
    workspacePath,
    ok,
    worktreePath: ok ? `/worktrees/${workspacePath}` : null,
    branch: ok ? "feature/x" : null,
    errorMessage,
  };
}

interface RecordedActions {
  readonly actions: WorktreeCreateResultActions;
  readonly finishAndResumeCalls: () => number;
  readonly unstaged: () => readonly string[];
  readonly committed: () => readonly (readonly string[])[];
  readonly failureMessages: () => readonly string[];
}

function recordedActions(): RecordedActions {
  let finishAndResumeCalls = 0;
  const unstaged: string[] = [];
  const committed: (readonly string[])[] = [];
  const failureMessages: string[] = [];
  return {
    actions: {
      finishAndResume: () => {
        finishAndResumeCalls += 1;
      },
      unstageEntry: (workspacePath) => {
        unstaged.push(workspacePath);
      },
      commitPaths: (workspacePaths) => {
        committed.push([...workspacePaths]);
      },
      showPartialFailure: (message) => {
        failureMessages.push(message);
      },
    },
    finishAndResumeCalls: () => finishAndResumeCalls,
    unstaged: () => unstaged,
    committed: () => committed,
    failureMessages: () => failureMessages,
  };
}

describe("applyWorktreeCreateResult", () => {
  it("finishes and resumes once when every entry succeeded", () => {
    const recorder = recordedActions();
    applyWorktreeCreateResult({
      stagedEntries: [worktreeEntry("/repo/a"), worktreeEntry("/repo/b")],
      changedWorkspacePaths: ["/repo/a", "/repo/b"],
      perEntry: [
        perEntryResult("/repo/a", true, null),
        perEntryResult("/repo/b", true, null),
      ],
      actions: recorder.actions,
    });

    expect(recorder.finishAndResumeCalls()).toBe(1);
    expect(recorder.unstaged()).toEqual([]);
    expect(recorder.committed()).toEqual([]);
    expect(recorder.failureMessages()).toEqual([]);
  });

  it("keeps failed entries staged and actionable on a mixed outcome", () => {
    const recorder = recordedActions();
    applyWorktreeCreateResult({
      stagedEntries: [worktreeEntry("/repo/a"), worktreeEntry("/repo/b")],
      changedWorkspacePaths: ["/repo/a", "/repo/b", "/repo/removed"],
      perEntry: [
        perEntryResult("/repo/a", true, null),
        perEntryResult("/repo/b", false, "branch already exists"),
      ],
      actions: recorder.actions,
    });

    // No unconditional clear/resume: the popover stays open for a retry.
    expect(recorder.finishAndResumeCalls()).toBe(0);
    // Only the succeeded entry is unstaged; /repo/b stays staged.
    expect(recorder.unstaged()).toEqual(["/repo/a"]);
    // Succeeded paths (including committed add/removes) are bound; the failed
    // path is not.
    expect(recorder.committed()).toEqual([["/repo/a", "/repo/removed"]]);
    const message = recorder.failureMessages()[0];
    expect(message).toContain("b");
    expect(message).toContain("branch already exists");
    expect(message).toContain("Update");
  });

  it("keeps everything staged when every entry failed", () => {
    const recorder = recordedActions();
    applyWorktreeCreateResult({
      stagedEntries: [worktreeEntry("/repo/a"), worktreeEntry("/repo/b")],
      changedWorkspacePaths: ["/repo/a", "/repo/b"],
      perEntry: [
        perEntryResult("/repo/a", false, "disk full"),
        perEntryResult("/repo/b", false, "disk full"),
      ],
      actions: recorder.actions,
    });

    expect(recorder.finishAndResumeCalls()).toBe(0);
    expect(recorder.unstaged()).toEqual([]);
    expect(recorder.committed()).toEqual([]);
    expect(recorder.failureMessages()).toHaveLength(1);
    expect(recorder.failureMessages()[0]).toContain("2 folders");
  });

  it("treats an entry the host reported nothing about as failed, not silently succeeded", () => {
    const recorder = recordedActions();
    applyWorktreeCreateResult({
      stagedEntries: [worktreeEntry("/repo/a"), worktreeEntry("/repo/b")],
      changedWorkspacePaths: ["/repo/a", "/repo/b"],
      perEntry: [perEntryResult("/repo/a", true, null)],
      actions: recorder.actions,
    });

    expect(recorder.finishAndResumeCalls()).toBe(0);
    expect(recorder.unstaged()).toEqual(["/repo/a"]);
    expect(recorder.committed()).toEqual([["/repo/a"]]);
    expect(recorder.failureMessages()).toHaveLength(1);
  });
});
