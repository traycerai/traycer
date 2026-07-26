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

  it("falls back to the default prefix when the configured prefix is over max length", () => {
    // Over-max prefixes are invalid now and must not flow into composition.
    const longPrefix = "x".repeat(100);
    const result = buildDefaultBranchByPath([summary({})], false, longPrefix);

    expect(result).toEqual({
      "/repos/app": "traycer/swift-otter",
    });
  });

  it("falls back to the default prefix for multi-workspace when the configured prefix is over max length", () => {
    const longPrefix = "p".repeat(70);
    const result = buildDefaultBranchByPath(
      [summary({ repoIdentifier: { owner: "acme", repo: "long-repo-name" } })],
      true,
      longPrefix,
    );

    expect(result).toEqual({
      "/repos/app": "traycer/long-repo-name-swift-otter",
    });
  });

  it("falls back to the default prefix for other invalid values", () => {
    // Leading dash is also invalid; same choke-point fallback applies.
    const result = buildDefaultBranchByPath([summary({})], false, "-wip/");

    expect(result).toEqual({
      "/repos/app": "traycer/swift-otter",
    });
  });

  // A max-length (40-char) prefix + a max-length (40-char) repo slug can
  // together exceed 80, so the cutoff can land in the repo-slug material, not
  // just the random suffix. That is still safe: both the repo slug
  // (slugify-branch-seed) and the suffix (random-friendly-name) are
  // ASCII-sanitized to [a-z0-9-], so slice(0, 80) never ends on / or .
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
