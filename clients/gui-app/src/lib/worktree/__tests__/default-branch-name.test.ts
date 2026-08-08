import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorktreeWorkspaceSummaryV14 } from "@traycer/protocol/host/worktree-schemas";
import {
  buildDefaultBranchByPath,
  regenerateSingleWorkspaceBranchName,
} from "@/lib/worktree/default-branch-name";

const randomMocks = vi.hoisted(() => ({
  pickFriendlyBranchSuffix: vi.fn(() => "swift-otter"),
}));

vi.mock("@/lib/worktree/random-friendly-name", () => ({
  pickFriendlyBranchSuffix: () => randomMocks.pickFriendlyBranchSuffix(),
}));

function summary(
  overrides: Partial<WorktreeWorkspaceSummaryV14>,
): WorktreeWorkspaceSummaryV14 {
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
    resolvedAt: Date.now(),
    repoBranchPrefix: { status: "absent" },
    ...overrides,
  };
}

/** Map descriptor records down to name-only maps for name-focused assertions. */
function namesOnly(
  result: Readonly<Record<string, { readonly name: string }>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(result).map(([path, entry]) => [path, entry.name]),
  );
}

describe("buildDefaultBranchByPath", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    randomMocks.pickFriendlyBranchSuffix.mockReturnValue("swift-otter");
  });

  it("uses a custom prefix + friendly tail for a single workspace", () => {
    const result = buildDefaultBranchByPath([summary({})], false, "feat-");

    expect(namesOnly(result)).toEqual({
      "/repos/app": "feat-swift-otter",
    });
  });

  it("uses an empty prefix to mean no prefix at all", () => {
    const result = buildDefaultBranchByPath([summary({})], false, "");

    expect(namesOnly(result)).toEqual({
      "/repos/app": "swift-otter",
    });
  });

  it("uses the default traycer/ prefix when configured", () => {
    const result = buildDefaultBranchByPath([summary({})], false, "traycer/");

    expect(namesOnly(result)).toEqual({
      "/repos/app": "traycer/swift-otter",
    });
  });

  it("inserts the repo slug between prefix and tail when multi-workspace prefixing is on", () => {
    const result = buildDefaultBranchByPath(
      [summary({ repoIdentifier: { owner: "acme", repo: "Traycer GUI" } })],
      true,
      "traycer/",
    );

    expect(namesOnly(result)).toEqual({
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

    expect(namesOnly(result)).toEqual({
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

    expect(namesOnly(result)).toEqual({
      "/repos/app": "feat/app-swift-otter",
      "/repos/api": "feat/api-swift-otter",
    });
  });

  it("falls back to the default prefix when the configured prefix is over max length", () => {
    // Over-max prefixes are invalid now and must not flow into composition.
    const longPrefix = "x".repeat(100);
    const result = buildDefaultBranchByPath([summary({})], false, longPrefix);

    expect(namesOnly(result)).toEqual({
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

    expect(namesOnly(result)).toEqual({
      "/repos/app": "traycer/long-repo-name-swift-otter",
    });
  });

  it("falls back to the default prefix for other invalid values", () => {
    // Leading dash is also invalid; same choke-point fallback applies.
    const result = buildDefaultBranchByPath([summary({})], false, "-wip/");

    expect(namesOnly(result)).toEqual({
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
    const name = result["/repos/app"].name;

    expect(name.length).toBeLessThanOrEqual(80);
    expect(name).toMatch(/[a-z0-9-]$/);
    expect(name.startsWith(prefix)).toBe(true);
  });

  it("keeps single-workspace composition safe under a max-length prefix", () => {
    const prefix = "q".repeat(40);
    const result = buildDefaultBranchByPath([summary({})], false, prefix);
    const name = result["/repos/app"].name;

    expect(name.length).toBeLessThanOrEqual(80);
    expect(name).toMatch(/[a-z0-9-]$/);
    expect(name).toBe(`${prefix}swift-otter`);
  });

  it("uses a valid present repo override instead of the global prefix", () => {
    const result = buildDefaultBranchByPath(
      [
        summary({
          repoBranchPrefix: { status: "present", value: "repo/" },
        }),
      ],
      false,
      "global/",
    );

    expect(namesOnly(result)).toEqual({
      "/repos/app": "repo/swift-otter",
    });
  });

  it("falls back to the global prefix when a present repo value is invalid", () => {
    // resolveEffectiveBranchPrefix re-validates and hands composition the
    // global value - so a valid global is used, not the default traycer/.
    const result = buildDefaultBranchByPath(
      [
        summary({
          repoBranchPrefix: { status: "present", value: "has spaces" },
        }),
      ],
      false,
      "global/",
    );

    expect(namesOnly(result)).toEqual({
      "/repos/app": "global/swift-otter",
    });
  });

  it("falls back to the default when both the repo override and global are invalid", () => {
    // Mirrors an invalid-global-only case once the effective value itself
    // fails composition's re-validation.
    const result = buildDefaultBranchByPath(
      [
        summary({
          repoBranchPrefix: { status: "present", value: "has spaces" },
        }),
      ],
      false,
      "-wip/",
    );

    expect(namesOnly(result)).toEqual({
      "/repos/app": "traycer/swift-otter",
    });
  });

  it("honors a present empty repo override as no prefix at all", () => {
    const result = buildDefaultBranchByPath(
      [summary({ repoBranchPrefix: { status: "present", value: "" } })],
      false,
      "global/",
    );

    expect(namesOnly(result)).toEqual({
      "/repos/app": "swift-otter",
    });
  });

  it("resolves each workspace's own repoBranchPrefix independently", () => {
    const workspaces = [
      summary({
        workspacePath: "/repos/app",
        repoIdentifier: { owner: "acme", repo: "app" },
        repoBranchPrefix: { status: "present", value: "app-prefix/" },
      }),
      summary({
        workspacePath: "/repos/api",
        repoIdentifier: { owner: "acme", repo: "api" },
        repoBranchPrefix: { status: "absent" },
      }),
      summary({
        workspacePath: "/repos/lib",
        repoIdentifier: { owner: "acme", repo: "lib" },
        repoBranchPrefix: { status: "malformed" },
      }),
    ];

    const result = buildDefaultBranchByPath(workspaces, true, "global/");

    expect(namesOnly(result)).toEqual({
      "/repos/app": "app-prefix/app-swift-otter",
      // Absent inherits the global fallback.
      "/repos/api": "global/api-swift-otter",
      // Malformed also falls through resolveEffectiveBranchPrefix to global,
      // then the invalid-global composition path only fires when the *global*
      // itself is invalid - here global is fine so the name uses it.
      "/repos/lib": "global/lib-swift-otter",
    });
  });
});

// Formerly `buildBranchPrefixWarningsByPath` - warnings now live on the
// same `DefaultBranchDescriptor` that carries each path's name.
describe("buildDefaultBranchByPath warnings", () => {
  it("is null when every workspace's override is absent or valid", () => {
    const result = buildDefaultBranchByPath(
      [
        summary({ repoBranchPrefix: { status: "absent" } }),
        summary({
          workspacePath: "/repos/api",
          repoBranchPrefix: { status: "present", value: "team/" },
        }),
      ],
      false,
      "global/",
    );
    expect(result["/repos/app"].warning).toBeNull();
    expect(result["/repos/api"].warning).toBeNull();
  });

  it("carries a warning, naming the environment file, for an invalid or malformed workspace only", () => {
    const result = buildDefaultBranchByPath(
      [
        summary({
          workspacePath: "/repos/app",
          repoBranchPrefix: { status: "absent" },
        }),
        summary({
          workspacePath: "/repos/bad",
          repoBranchPrefix: { status: "present", value: "has spaces" },
        }),
        summary({
          workspacePath: "/repos/broken",
          repoBranchPrefix: { status: "malformed" },
        }),
      ],
      false,
      "global/",
    );
    expect(result["/repos/app"].warning).toBeNull();
    expect(result["/repos/bad"].warning).toContain(
      "/repos/bad/.traycer/environment.json",
    );
    expect(result["/repos/broken"].warning).toContain(
      "/repos/broken/.traycer/environment.json",
    );
  });
});

describe("regenerateSingleWorkspaceBranchName", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    randomMocks.pickFriendlyBranchSuffix.mockReturnValue("swift-otter");
  });

  it("uses the freshly-passed prefix, ignoring the matching workspace's own (possibly stale) repoBranchPrefix", () => {
    // Simulates the picker's cached summary BEFORE the invalidation triggered
    // by a repo-prefix save has refetched - `repoBranchPrefix` here is still
    // "absent" even though the user just saved "team/". A caller that read
    // THIS field would regenerate with the OLD (global) prefix; this
    // function must not.
    const staleWorkspaces = [
      summary({ repoBranchPrefix: { status: "absent" } }),
    ];

    const result = regenerateSingleWorkspaceBranchName({
      workspaces: staleWorkspaces,
      globalBranchPrefix: "global/",
      workspacePath: "/repos/app",
      freshRepoBranchPrefix: { status: "present", value: "team/" },
      suffix: "soft-wombat",
    });

    expect(result).toBe("team/soft-wombat");
  });

  it("returns null for a workspace path the picker doesn't know about", () => {
    const result = regenerateSingleWorkspaceBranchName({
      workspaces: [summary({})],
      globalBranchPrefix: "global/",
      workspacePath: "/repos/unknown",
      freshRepoBranchPrefix: { status: "present", value: "team/" },
      suffix: "soft-wombat",
    });
    expect(result).toBeNull();
  });

  it("still re-validates the fresh prefix, falling back to global when it's invalid", () => {
    const result = regenerateSingleWorkspaceBranchName({
      workspaces: [summary({})],
      globalBranchPrefix: "global/",
      workspacePath: "/repos/app",
      freshRepoBranchPrefix: { status: "present", value: "has spaces" },
      suffix: "soft-wombat",
    });
    expect(result).toBe("global/soft-wombat");
  });

  it("honors the caller-supplied suffix deterministically (no internal random pick)", () => {
    const workspaces = [summary({})];
    const first = regenerateSingleWorkspaceBranchName({
      workspaces,
      globalBranchPrefix: "team/",
      workspacePath: "/repos/app",
      freshRepoBranchPrefix: { status: "present", value: "team/" },
      suffix: "calm-badger",
    });
    const second = regenerateSingleWorkspaceBranchName({
      workspaces,
      globalBranchPrefix: "team/",
      workspacePath: "/repos/app",
      freshRepoBranchPrefix: { status: "present", value: "team/" },
      suffix: "calm-badger",
    });
    const third = regenerateSingleWorkspaceBranchName({
      workspaces,
      globalBranchPrefix: "team/",
      workspacePath: "/repos/app",
      freshRepoBranchPrefix: { status: "present", value: "team/" },
      suffix: "bright-fox",
    });

    expect(first).toBe("team/calm-badger");
    expect(second).toBe("team/calm-badger");
    expect(third).toBe("team/bright-fox");
    // pickFriendlyBranchSuffix is only used by buildDefaultBranchByPath now.
    expect(randomMocks.pickFriendlyBranchSuffix).not.toHaveBeenCalled();
  });

  it("inserts the repo slug when multiple workspaces are staged together", () => {
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

    const result = regenerateSingleWorkspaceBranchName({
      workspaces,
      globalBranchPrefix: "feat/",
      workspacePath: "/repos/app",
      freshRepoBranchPrefix: { status: "present", value: "feat/" },
      suffix: "calm-badger",
    });

    expect(result).toBe("feat/app-calm-badger");
  });
});

describe("buildDefaultBranchByPath random suffix", () => {
  beforeEach(() => {
    randomMocks.pickFriendlyBranchSuffix.mockReset();
    randomMocks.pickFriendlyBranchSuffix.mockReturnValue("swift-otter");
  });

  it("picks a fresh random suffix per call (bulk generation still invokes pickFriendlyBranchSuffix)", () => {
    // Regression: bulk generation must keep picking inside buildDefaultBranchByPath
    // rather than accepting a caller-supplied fixed suffix (that API is only for
    // regenerateSingleWorkspaceBranchName / the Environment preview path).
    randomMocks.pickFriendlyBranchSuffix
      .mockReturnValueOnce("alpha-one")
      .mockReturnValueOnce("beta-two");

    const first = buildDefaultBranchByPath([summary({})], false, "traycer/");
    const second = buildDefaultBranchByPath([summary({})], false, "traycer/");

    expect(first["/repos/app"].name).toBe("traycer/alpha-one");
    expect(second["/repos/app"].name).toBe("traycer/beta-two");
    expect(randomMocks.pickFriendlyBranchSuffix).toHaveBeenCalledTimes(2);
  });

  it("picks once per workspace in a multi-workspace bulk generation", () => {
    randomMocks.pickFriendlyBranchSuffix
      .mockReturnValueOnce("alpha-one")
      .mockReturnValueOnce("beta-two");

    const result = buildDefaultBranchByPath(
      [
        summary({
          workspacePath: "/repos/app",
          repoIdentifier: { owner: "acme", repo: "app" },
        }),
        summary({
          workspacePath: "/repos/api",
          repoIdentifier: { owner: "acme", repo: "api" },
        }),
      ],
      true,
      "feat/",
    );

    expect(namesOnly(result)).toEqual({
      "/repos/app": "feat/app-alpha-one",
      "/repos/api": "feat/api-beta-two",
    });
    expect(randomMocks.pickFriendlyBranchSuffix).toHaveBeenCalledTimes(2);
  });
});
