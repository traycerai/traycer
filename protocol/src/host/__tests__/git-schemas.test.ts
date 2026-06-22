/**
 * Round-trip parse tests for git schemas.
 * Each top-level schema is parsed twice to ensure idempotency and stability.
 */
import { describe, it, expect } from "vitest";
import {
  gitChangedFileSchema,
  repoStateSchema,
  gitGetFileDiffRequestSchema,
  gitListChangedFilesResponseSchema,
  gitGetFileDiffResponseSchema,
  gitGetFileDiffsRequestSchema,
  gitGetFileDiffsResponseSchema,
  gitGetCapabilitiesResponseSchema,
  gitSubscribeStatusEventSchema,
  gitStageSchema,
} from "@traycer/protocol/host/git-schemas";
import {
  DEFAULT_GIT_FILE_DIFF_BYTE_BUDGET,
  DEFAULT_GIT_FILE_DIFFS_BYTE_BUDGET,
} from "@traycer/protocol/host/git-constants";

describe("gitChangedFileSchema", () => {
  it("parses and reparses unchanged", () => {
    const fixture = {
      path: "/absolute/path/to/file.ts",
      previousPath: null,
      status: "modified" as const,
      stage: "staged" as const,
      isBinary: false,
      insertions: 5,
      deletions: 3,
      sizeBytes: 1024,
      stagedOid: "abc123def456",
      worktreeOid: "xyz789uvw012",
    };
    const parsed1 = gitChangedFileSchema.parse(fixture);
    const parsed2 = gitChangedFileSchema.parse(parsed1);
    expect(parsed2).toEqual(parsed1);
  });

  it("accepts nullable OIDs (degraded mode)", () => {
    const fixture = {
      path: "/absolute/path/to/file.ts",
      previousPath: null,
      status: "modified" as const,
      stage: "unstaged" as const,
      isBinary: false,
      insertions: 0,
      deletions: 0,
      sizeBytes: 2048,
      stagedOid: null,
      worktreeOid: null,
    };
    const parsed = gitChangedFileSchema.parse(fixture);
    expect(parsed.stagedOid).toBeNull();
    expect(parsed.worktreeOid).toBeNull();
  });

  it("accepts renamed files with previousPath", () => {
    const fixture = {
      path: "/absolute/path/to/newname.ts",
      previousPath: "/absolute/path/to/oldname.ts",
      status: "renamed" as const,
      stage: "staged" as const,
      isBinary: false,
      insertions: 0,
      deletions: 0,
      sizeBytes: 1024,
      stagedOid: "abc123",
      worktreeOid: null,
    };
    const parsed = gitChangedFileSchema.parse(fixture);
    expect(parsed.previousPath).toBe("/absolute/path/to/oldname.ts");
  });

  it("accepts all stage values", () => {
    const stages = ["staged", "unstaged", "untracked", "conflicted"] as const;
    const baseFixture = {
      path: "/path/file.ts",
      previousPath: null,
      status: "modified" as const,
      isBinary: false,
      insertions: 0,
      deletions: 0,
      sizeBytes: 0,
      stagedOid: null,
      worktreeOid: null,
    };

    stages.forEach((stage) => {
      const fixture = { ...baseFixture, stage };
      const parsed = gitChangedFileSchema.parse(fixture);
      expect(parsed.stage).toBe(stage);
    });
  });
});

describe("repoStateSchema", () => {
  it("parses clean state", () => {
    const fixture = { kind: "clean" as const };
    const parsed1 = repoStateSchema.parse(fixture);
    const parsed2 = repoStateSchema.parse(parsed1);
    expect(parsed2).toEqual(parsed1);
  });

  it("parses merge state", () => {
    const fixture = {
      kind: "merge" as const,
      headRef: "main",
      mergeHeads: ["abc123", "def456"],
    };
    const parsed1 = repoStateSchema.parse(fixture);
    const parsed2 = repoStateSchema.parse(parsed1);
    expect(parsed2).toEqual(parsed1);
  });

  it("parses rebase state", () => {
    const fixture = {
      kind: "rebase" as const,
      ontoSha: "abc123",
      originalBranch: "feature",
      step: 3,
      totalSteps: 10,
    };
    const parsed1 = repoStateSchema.parse(fixture);
    const parsed2 = repoStateSchema.parse(parsed1);
    expect(parsed2).toEqual(parsed1);
  });

  it("parses cherry-pick state", () => {
    const fixture = {
      kind: "cherry-pick" as const,
      pickingSha: "abc123",
    };
    const parsed1 = repoStateSchema.parse(fixture);
    const parsed2 = repoStateSchema.parse(parsed1);
    expect(parsed2).toEqual(parsed1);
  });

  it("parses revert state", () => {
    const fixture = {
      kind: "revert" as const,
      revertingSha: "abc123",
    };
    const parsed1 = repoStateSchema.parse(fixture);
    const parsed2 = repoStateSchema.parse(parsed1);
    expect(parsed2).toEqual(parsed1);
  });

  it("parses am state", () => {
    const fixture = {
      kind: "am" as const,
      patchName: "0001-fix-something.patch",
    };
    const parsed1 = repoStateSchema.parse(fixture);
    const parsed2 = repoStateSchema.parse(parsed1);
    expect(parsed2).toEqual(parsed1);
  });

  it("parses bisect state", () => {
    const fixture = {
      kind: "bisect" as const,
      goodSha: "abc123",
      badSha: "xyz789",
    };
    const parsed1 = repoStateSchema.parse(fixture);
    const parsed2 = repoStateSchema.parse(parsed1);
    expect(parsed2).toEqual(parsed1);
  });
});

describe("gitListChangedFilesResponseSchema", () => {
  it("parses and reparses unchanged", () => {
    const fixture = {
      runningDir: "/absolute/path",
      headSha: "abc123def456",
      branch: "main",
      files: [
        {
          path: "/absolute/path/file1.ts",
          previousPath: null,
          status: "modified" as const,
          stage: "staged" as const,
          isBinary: false,
          insertions: 5,
          deletions: 3,
          sizeBytes: 1024,
          stagedOid: "abc123",
          worktreeOid: "xyz789",
        },
      ],
      fingerprint: "fp123",
      repoMode: "normal" as const,
      repoState: { kind: "clean" as const },
    };
    const parsed1 = gitListChangedFilesResponseSchema.parse(fixture);
    const parsed2 = gitListChangedFilesResponseSchema.parse(parsed1);
    expect(parsed2).toEqual(parsed1);
  });

  it("accepts null branch", () => {
    const fixture = {
      runningDir: "/absolute/path",
      headSha: "abc123",
      branch: null,
      files: [],
      fingerprint: "fp123",
      repoMode: "normal" as const,
      repoState: { kind: "clean" as const },
    };
    const parsed = gitListChangedFilesResponseSchema.parse(fixture);
    expect(parsed.branch).toBeNull();
  });

  it("accepts degraded mode", () => {
    const fixture = {
      runningDir: "/absolute/path",
      headSha: "abc123",
      branch: "main",
      files: [],
      fingerprint: "fp123",
      repoMode: "degraded" as const,
      repoState: { kind: "clean" as const },
    };
    const parsed = gitListChangedFilesResponseSchema.parse(fixture);
    expect(parsed.repoMode).toBe("degraded");
  });

  it("accepts refused mode", () => {
    const fixture = {
      runningDir: "/absolute/path",
      headSha: "abc123",
      branch: "main",
      files: [],
      fingerprint: "fp123",
      repoMode: "refused" as const,
      repoState: { kind: "clean" as const },
    };
    const parsed = gitListChangedFilesResponseSchema.parse(fixture);
    expect(parsed.repoMode).toBe("refused");
  });
});

describe("gitGetFileDiffResponseSchema", () => {
  it("parses and reparses unchanged", () => {
    const fixture = {
      filePath: "/absolute/path/file.ts",
      headSha: "abc123",
      stagedOid: "oid1",
      worktreeOid: "oid2",
      patch: "--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new",
      isTruncated: false,
      truncatedAfterBytes: null,
      isBinary: false,
    };
    const parsed1 = gitGetFileDiffResponseSchema.parse(fixture);
    const parsed2 = gitGetFileDiffResponseSchema.parse(parsed1);
    expect(parsed2).toEqual(parsed1);
  });

  it("accepts truncated diffs", () => {
    const fixture = {
      filePath: "/absolute/path/file.ts",
      headSha: "abc123",
      stagedOid: null,
      worktreeOid: null,
      patch: "--- a/file.ts\n+++ b/file.ts\n... (truncated)",
      isTruncated: true,
      truncatedAfterBytes: 1048576,
      isBinary: false,
    };
    const parsed = gitGetFileDiffResponseSchema.parse(fixture);
    expect(parsed.isTruncated).toBe(true);
    expect(parsed.truncatedAfterBytes).toBe(1048576);
  });

  it("accepts binary diffs", () => {
    const fixture = {
      filePath: "/absolute/path/file.bin",
      headSha: "abc123",
      stagedOid: "oid1",
      worktreeOid: "oid2",
      patch: "Binary files a/file.bin and b/file.bin differ",
      isTruncated: false,
      truncatedAfterBytes: null,
      isBinary: true,
    };
    const parsed = gitGetFileDiffResponseSchema.parse(fixture);
    expect(parsed.isBinary).toBe(true);
  });
});

describe("gitGetFileDiffRequestSchema", () => {
  it("accepts rename previousPath for diff requests", () => {
    const parsed = gitGetFileDiffRequestSchema.parse({
      hostId: "host-1",
      runningDir: "/repo",
      filePath: "src/new-name.ts",
      previousPath: "src/old-name.ts",
      stage: "staged",
      ignoreWhitespace: false,
    });

    expect(parsed.previousPath).toBe("src/old-name.ts");
    expect(parsed.byteBudget).toBe(DEFAULT_GIT_FILE_DIFF_BYTE_BUDGET);
  });

  it("accepts null byteBudget for uncapped full diff requests", () => {
    const parsed = gitGetFileDiffRequestSchema.parse({
      hostId: "host-1",
      runningDir: "/repo",
      filePath: "src/file.ts",
      previousPath: null,
      stage: "unstaged",
      ignoreWhitespace: false,
      byteBudget: null,
    });

    expect(parsed.byteBudget).toBeNull();
  });
});

describe("gitGetFileDiffsResponseSchema", () => {
  it("parses and reparses unchanged", () => {
    const fixture = {
      runningDir: "/absolute/path",
      headSha: "abc123",
      diffs: [
        {
          filePath: "/absolute/path/file1.ts",
          headSha: "abc123",
          stagedOid: "oid1",
          worktreeOid: "oid2",
          patch: "--- a/file1.ts\n+++ b/file1.ts\n@@ -1 +1 @@",
          isTruncated: false,
          truncatedAfterBytes: null,
          isBinary: false,
        },
        {
          filePath: "/absolute/path/file2.ts",
          headSha: "abc123",
          stagedOid: null,
          worktreeOid: null,
          patch: "",
          isTruncated: false,
          truncatedAfterBytes: null,
          isBinary: false,
        },
      ],
    };
    const parsed1 = gitGetFileDiffsResponseSchema.parse(fixture);
    const parsed2 = gitGetFileDiffsResponseSchema.parse(parsed1);
    expect(parsed2).toEqual(parsed1);
  });
});

describe("gitGetFileDiffsRequestSchema", () => {
  it("accepts per-file rename previousPath values", () => {
    const parsed = gitGetFileDiffsRequestSchema.parse({
      hostId: "host-1",
      runningDir: "/repo",
      files: [
        {
          filePath: "src/new-name.ts",
          previousPath: "src/old-name.ts",
          stage: "staged",
        },
      ],
      ignoreWhitespace: false,
      byteBudget: DEFAULT_GIT_FILE_DIFFS_BYTE_BUDGET,
    });

    expect(parsed.files[0].previousPath).toBe("src/old-name.ts");
  });
});

describe("gitGetCapabilitiesResponseSchema", () => {
  it("accepts available capabilities with null reason", () => {
    const parsed = gitGetCapabilitiesResponseSchema.parse({
      available: true,
      gitVersion: "git version 2.46.0",
      reason: null,
    });

    expect(parsed.available).toBe(true);
    expect(parsed.reason).toBeNull();
  });

  it("accepts unavailable capabilities with non-null reason", () => {
    const parsed = gitGetCapabilitiesResponseSchema.parse({
      available: false,
      gitVersion: null,
      reason: "git not found",
    });

    expect(parsed.available).toBe(false);
    expect(parsed.reason).toBe("git not found");
  });

  it("rejects capability payloads with contradictory availability fields", () => {
    expect(() =>
      gitGetCapabilitiesResponseSchema.parse({
        available: false,
        gitVersion: null,
        reason: null,
      }),
    ).toThrow();

    expect(() =>
      gitGetCapabilitiesResponseSchema.parse({
        available: true,
        gitVersion: "git version 2.46.0",
        reason: "not a git repository",
      }),
    ).toThrow();
  });
});

describe("gitSubscribeStatusEventSchema", () => {
  it("parses snapshot event", () => {
    const fixture = {
      type: "snapshot" as const,
      runningDir: "/absolute/path",
      headSha: "abc123",
      branch: "main",
      files: [],
      fingerprint: "fp123",
      repoMode: "normal" as const,
      repoState: { kind: "clean" as const },
      pollStartedAtMs: 1234567890,
    };
    const parsed1 = gitSubscribeStatusEventSchema.parse(fixture);
    const parsed2 = gitSubscribeStatusEventSchema.parse(parsed1);
    expect(parsed2).toEqual(parsed1);
  });

  it("parses updated event", () => {
    const fixture = {
      type: "updated" as const,
      runningDir: "/absolute/path",
      headSha: "abc123",
      branch: "main",
      files: [],
      fingerprint: "fp456",
      repoMode: "normal" as const,
      repoState: { kind: "clean" as const },
      changedPaths: ["/absolute/path/file1.ts", "/absolute/path/file2.ts"],
      pollStartedAtMs: 1234567891,
    };
    const parsed1 = gitSubscribeStatusEventSchema.parse(fixture);
    const parsed2 = gitSubscribeStatusEventSchema.parse(parsed1);
    expect(parsed2).toEqual(parsed1);
  });

  it("parses error event", () => {
    const fixture = {
      type: "error" as const,
      message: "Failed to poll git status",
      isFatal: false,
    };
    const parsed1 = gitSubscribeStatusEventSchema.parse(fixture);
    const parsed2 = gitSubscribeStatusEventSchema.parse(parsed1);
    expect(parsed2).toEqual(parsed1);
  });

  it("accepts fatal error events", () => {
    const fixture = {
      type: "error" as const,
      message: "Repository is corrupted",
      isFatal: true,
    };
    const parsed = gitSubscribeStatusEventSchema.parse(fixture);
    if (parsed.type === "error") {
      expect(parsed.isFatal).toBe(true);
    } else {
      expect.fail("Expected error event");
    }
  });

  it("snapshot includes pollStartedAtMs for debugging", () => {
    const fixture = {
      type: "snapshot" as const,
      runningDir: "/absolute/path",
      headSha: "abc123",
      branch: null,
      files: [],
      fingerprint: "fp123",
      repoMode: "normal" as const,
      repoState: { kind: "clean" as const },
      pollStartedAtMs: 1000000,
    };
    const parsed = gitSubscribeStatusEventSchema.parse(fixture);
    expect(parsed.type).toBe("snapshot");
    if (parsed.type === "snapshot") {
      expect(parsed.pollStartedAtMs).toBe(1000000);
    }
  });

  it("updated includes changedPaths array", () => {
    const fixture = {
      type: "updated" as const,
      runningDir: "/absolute/path",
      headSha: "abc123",
      branch: "main",
      files: [],
      fingerprint: "fp456",
      repoMode: "normal" as const,
      repoState: { kind: "clean" as const },
      changedPaths: ["/absolute/path/a.ts", "/absolute/path/b.ts"],
      pollStartedAtMs: 2000000,
    };
    const parsed = gitSubscribeStatusEventSchema.parse(fixture);
    if (parsed.type === "updated") {
      expect(Array.isArray(parsed.changedPaths)).toBe(true);
      expect(parsed.changedPaths).toHaveLength(2);
    } else {
      expect.fail("Expected updated event");
    }
  });
});

describe("gitStageSchema", () => {
  it("accepts all four stage values", () => {
    const stages = ["staged", "unstaged", "untracked", "conflicted"] as const;
    stages.forEach((stage) => {
      const parsed = gitStageSchema.parse(stage);
      expect(parsed).toBe(stage);
    });
  });
});
