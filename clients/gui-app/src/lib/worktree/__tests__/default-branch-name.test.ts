import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorktreeWorkspaceSummary } from "@traycer/protocol/host/worktree-schemas";
import { buildDefaultBranchByPath } from "@/lib/worktree/default-branch-name";

vi.mock("@/lib/worktree/random-friendly-name", () => ({
  pickFriendlyBranchSuffix: () => "swift-otter",
}));

function summary(
  overrides: Partial<WorktreeWorkspaceSummary>,
): WorktreeWorkspaceSummary {
  return {
    workspacePath: "/repos/app",
    isGitRepo: true,
    repoIdentifier: { owner: "acme", repo: "app" },
    mainBranch: "main",
    worktrees: [
      {
        worktreePath: "/repos/app",
        branch: "main",
        head: null,
        isMain: true,
        isLocked: false,
      },
    ],
    scripts: null,
    ...overrides,
  };
}

describe("buildDefaultBranchByPath", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses a custom prefix + friendly tail for a single workspace", () => {
    const result = buildDefaultBranchByPath([summary({})], false, "feat-");

    expect(result).toEqual({
      "/repos/app": "feat-swift-otter",
    });
  });

  it("uses an empty prefix to mean no prefix at all", () => {
    const result = buildDefaultBranchByPath([summary({})], false, "");

    expect(result).toEqual({
      "/repos/app": "swift-otter",
    });
  });

  it("uses the default traycer/ prefix when configured", () => {
    const result = buildDefaultBranchByPath([summary({})], false, "traycer/");

    expect(result).toEqual({
      "/repos/app": "traycer/swift-otter",
    });
  });

  it("inserts the repo slug between prefix and tail when multi-workspace prefixing is on", () => {
    const result = buildDefaultBranchByPath(
      [summary({ repoIdentifier: { owner: "acme", repo: "Traycer GUI" } })],
      true,
      "traycer/",
    );

    expect(result).toEqual({
      "/repos/app": "traycer/traycer-gui-swift-otter",
    });
  });

  it("falls back to the folder name when multi-prefixing and repo id is null", () => {
    const result = buildDefaultBranchByPath(
      [
        summary({
          workspacePath: "/Users/me/projects/my-app",
          repoIdentifier: null,
        }),
      ],
      true,
      "anurag/",
    );

    expect(result).toEqual({
      "/Users/me/projects/my-app": "anurag/my-app-swift-otter",
    });
  });

  it("builds a branch name per workspace path", () => {
    const workspaces = [
      summary({
        workspacePath: "/repos/app",
        repoIdentifier: { owner: "acme", repo: "app" },
      }),
      summary({
        workspacePath: "/repos/api",
        repoIdentifier: { owner: "acme", repo: "api" },
      }),
    ];

    const result = buildDefaultBranchByPath(workspaces, true, "feat/");

    expect(result).toEqual({
      "/repos/app": "feat/app-swift-otter",
      "/repos/api": "feat/api-swift-otter",
    });
  });

  it("truncates the composed name to 80 characters", () => {
    const longPrefix = "x".repeat(100);
    const result = buildDefaultBranchByPath([summary({})], false, longPrefix);
    const name = result["/repos/app"] ?? "";

    expect(name.length).toBe(80);
    expect(name).toBe(`${longPrefix}swift-otter`.slice(0, 80));
  });

  it("truncates multi-workspace composed names to 80 characters", () => {
    const longPrefix = "p".repeat(70);
    const result = buildDefaultBranchByPath(
      [summary({ repoIdentifier: { owner: "acme", repo: "long-repo-name" } })],
      true,
      longPrefix,
    );
    const name = result["/repos/app"] ?? "";
    const full = `${longPrefix}long-repo-name-swift-otter`;

    expect(name.length).toBe(80);
    expect(name).toBe(full.slice(0, 80));
  });

  // Validator caps prefixes at 40 chars; suffix material is always [a-z0-9-].
  // So slice(0, 80) always lands inside that suffix and never ends on / or .
  it("keeps multi-workspace truncation safe under a max-length prefix", () => {
    const prefix = "p".repeat(40);
    const result = buildDefaultBranchByPath(
      [
        summary({
          repoIdentifier: {
            owner: "acme",
            repo: "extremely-long-repository-name-for-truncation",
          },
        }),
      ],
      true,
      prefix,
    );
    const name = result["/repos/app"] ?? "";

    expect(name.length).toBeLessThanOrEqual(80);
    expect(name).toMatch(/[a-z0-9-]$/);
    expect(name.startsWith(prefix)).toBe(true);
  });

  it("keeps single-workspace composition safe under a max-length prefix", () => {
    const prefix = "q".repeat(40);
    const result = buildDefaultBranchByPath([summary({})], false, prefix);
    const name = result["/repos/app"] ?? "";

    expect(name.length).toBeLessThanOrEqual(80);
    expect(name).toMatch(/[a-z0-9-]$/);
    expect(name).toBe(`${prefix}swift-otter`);
  });
});
