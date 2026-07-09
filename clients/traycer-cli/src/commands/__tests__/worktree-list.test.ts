import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorktreeHostEntryV11 } from "@traycer/protocol/host";
import type { WorktreeTier } from "@traycer-clients/shared/worktree/classify-worktree";
import {
  buildWorktreeListCommand,
  formatWorktreeListTable,
  type WorktreeListRow,
} from "../worktree-list";
import { callHostRpc } from "../../internal/host-rpc";
import type { CommandContext } from "../../runner/runner";
import { CLI_ERROR_CODES } from "../../runner/errors";

vi.mock("../../internal/host-rpc", async () => {
  const actual = await vi.importActual<
    typeof import("../../internal/host-rpc")
  >("../../internal/host-rpc");
  return {
    ...actual,
    callHostRpc: vi.fn(),
  };
});

const rpcMock = vi.mocked(callHostRpc);

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function entry(overrides: Partial<WorktreeHostEntryV11>): WorktreeHostEntryV11 {
  return {
    worktreePath: "/Users/dev/.traycer/worktrees/acme__web/feature-x",
    repoLabel: "acme/web",
    repoIdentifier: { owner: "acme", repo: "web" },
    branch: "feature/x",
    inUse: false,
    uncommittedCount: 0,
    gitRemovable: true,
    scripts: null,
    lastActivityAt: null,
    owners: [],
    branchStatus: null,
    createdAt: null,
    prState: null,
    prNumber: null,
    prUrl: null,
    mergedHeadShaMatches: false,
    submodules: [],
    atBaseCommit: false,
    ...overrides,
  };
}

function row(
  overrides: Partial<WorktreeHostEntryV11>,
  tier: WorktreeTier | null,
): WorktreeListRow {
  return { ...entry(overrides), tier };
}

// A fake CommandContext is unnecessary for the list command (it ignores ctx),
// but the CommandFn signature requires one.
const ctx = {} as CommandContext;

const defaultOpts = {
  includeActivity: true,
  cursor: null,
  limit: null,
} as const;

describe("formatWorktreeListTable", () => {
  it("returns an explicit empty-state line when there are no worktrees", () => {
    expect(formatWorktreeListTable([], true, null)).toBe(
      "No Traycer-managed worktrees found.",
    );
  });

  it("renders a header row and one row per worktree", () => {
    const table = formatWorktreeListTable(
      [
        row(
          {
            repoLabel: "acme/web",
            branch: "feature/x",
            inUse: true,
            uncommittedCount: 3,
            lastActivityAt: 1_700_000_000_000,
            owners: [
              {
                epicId: "e1",
                ownerKind: "chat",
                ownerId: "c1",
                updatedAt: 1_700_000_000_000,
              },
            ],
          },
          "in-use",
        ),
      ],
      true,
      null,
    );
    const lines = table.split("\n");
    expect(lines[0]).toContain("REPO");
    expect(lines[0]).toContain("BRANCH");
    expect(lines[0]).toContain("TIER");
    expect(lines[0]).toContain("IN-USE");
    expect(lines[0]).toContain("OWNERS");
    expect(lines[0]).toContain("PATH");
    expect(lines[1]).toContain("acme/web");
    expect(lines[1]).toContain("feature/x");
    expect(lines[1]).toContain("In use");
    expect(lines[1]).toContain("yes");
    expect(lines[1]).toContain("2023-11-14");
    // one owner
    expect(lines[1]).toContain("1");
    expect(lines[1]).toContain(
      "/Users/dev/.traycer/worktrees/acme__web/feature-x",
    );
  });

  it("renders the shared classifier's human label per tier, and a dash when unclassified", () => {
    const table = formatWorktreeListTable(
      [
        row({ branch: "feat/merged" }, "merged"),
        row({ branch: "feat/base" }, "at-base-commit"),
        row({ branch: "feat/unprobed" }, null),
      ],
      true,
      null,
    );
    const lines = table.split("\n");
    expect(lines[1]).toContain("Landed");
    expect(lines[2]).toContain("At base commit");
    expect(lines[3]).toContain("-");
  });

  it("shows a detached placeholder and a dash for a null last-active", () => {
    const table = formatWorktreeListTable(
      [row({ branch: null, lastActivityAt: null }, "review")],
      true,
      null,
    );
    const line = table.split("\n")[1];
    expect(line).toContain("(detached)");
    expect(line).toContain("-");
  });

  it("normalises a seconds-based epoch up to a real date", () => {
    const table = formatWorktreeListTable(
      [row({ lastActivityAt: 1_700_000_000 }, "review")],
      true,
      null,
    );
    expect(table).toContain("2023-11-14");
  });

  it("appends the --include-activity hint only when activity was not requested", () => {
    const withoutActivity = formatWorktreeListTable(
      [row({}, null)],
      false,
      null,
    );
    expect(withoutActivity).toContain("--include-activity");
    const withActivity = formatWorktreeListTable(
      [row({}, "review")],
      true,
      null,
    );
    expect(withActivity).not.toContain("--include-activity");
  });

  it("appends a resume hint when a single-page response has a next cursor", () => {
    const table = formatWorktreeListTable(
      [row({}, "review")],
      true,
      "/Users/dev/.traycer/worktrees/acme__web/feature-x",
    );
    expect(table).toContain("More worktrees available");
    expect(table).toContain(
      "--cursor /Users/dev/.traycer/worktrees/acme__web/feature-x",
    );
  });
});

describe("buildWorktreeListCommand", () => {
  it("calls listAllForHost with includeActivity and returns the entries with the computed tier", async () => {
    // The default fixture is clean, on a named branch, with a null
    // branchStatus - unproven, so the shared classifier reads it as review.
    const worktrees = [entry({})];
    rpcMock.mockResolvedValue({ worktrees, nextCursor: null });

    const result = await buildWorktreeListCommand(defaultOpts)(ctx);

    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(rpcMock).toHaveBeenNthCalledWith(1, "worktree.listAllForHost", {
      includeActivity: true,
      activityPaths: null,
      cursor: null,
      limit: 32,
    });
    expect(result.data).toEqual({
      worktrees: [{ ...entry({}), tier: "review" }],
      nextCursor: null,
    });
    expect(result.exitCode).toBe(0);
  });

  it("classifies with the shared ladder: a validated merged PR rides out as merged", async () => {
    rpcMock.mockResolvedValue({
      worktrees: [
        entry({ prState: "merged", mergedHeadShaMatches: true, prNumber: 7 }),
      ],
      nextCursor: null,
    });

    const result = await buildWorktreeListCommand(defaultOpts)(ctx);

    expect(result.data).toEqual({
      worktrees: [
        {
          ...entry({
            prState: "merged",
            mergedHeadShaMatches: true,
            prNumber: 7,
          }),
          tier: "merged",
        },
      ],
      nextCursor: null,
    });
  });

  it("emits tier null without --include-activity (unprobed entries are never classified)", async () => {
    rpcMock.mockResolvedValue({
      worktrees: [entry({ prState: "merged", mergedHeadShaMatches: true })],
      nextCursor: null,
    });

    const result = await buildWorktreeListCommand({
      includeActivity: false,
      cursor: null,
      limit: null,
    })(ctx);

    expect(rpcMock).toHaveBeenNthCalledWith(1, "worktree.listAllForHost", {
      includeActivity: false,
      activityPaths: null,
      cursor: null,
      limit: 32,
    });
    expect(result.data).toEqual({
      worktrees: [
        {
          ...entry({ prState: "merged", mergedHeadShaMatches: true }),
          tier: null,
        },
      ],
      nextCursor: null,
    });
  });

  it("auto-pages by default and aggregates rows into one result", async () => {
    const first = entry({
      worktreePath: "/Users/dev/.traycer/worktrees/acme__api/feature-a",
      repoLabel: "acme/api",
      branch: "feature/a",
    });
    const second = entry({
      worktreePath: "/Users/dev/.traycer/worktrees/acme__web/feature-b",
      repoLabel: "acme/web",
      branch: "feature/b",
    });
    rpcMock
      .mockResolvedValueOnce({
        worktrees: [first],
        nextCursor: first.worktreePath,
      })
      .mockResolvedValueOnce({ worktrees: [second], nextCursor: null });

    const result = await buildWorktreeListCommand(defaultOpts)(ctx);

    expect(rpcMock).toHaveBeenCalledTimes(2);
    expect(rpcMock).toHaveBeenNthCalledWith(1, "worktree.listAllForHost", {
      includeActivity: true,
      activityPaths: null,
      cursor: null,
      limit: 32,
    });
    expect(rpcMock).toHaveBeenNthCalledWith(2, "worktree.listAllForHost", {
      includeActivity: true,
      activityPaths: null,
      cursor: first.worktreePath,
      limit: 32,
    });
    expect(result.data).toEqual({
      worktrees: [
        { ...first, tier: "review" },
        { ...second, tier: "review" },
      ],
      nextCursor: null,
    });
  });

  it("passes explicit cursor and limit through as a single-page request", async () => {
    const worktrees = [entry({})];
    rpcMock.mockResolvedValue({
      worktrees,
      nextCursor: "/Users/dev/.traycer/worktrees/acme__web/feature-y",
    });

    const result = await buildWorktreeListCommand({
      includeActivity: true,
      cursor: "/Users/dev/.traycer/worktrees/acme__web/feature-x",
      limit: "7",
    })(ctx);

    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(rpcMock).toHaveBeenNthCalledWith(1, "worktree.listAllForHost", {
      includeActivity: true,
      activityPaths: null,
      cursor: "/Users/dev/.traycer/worktrees/acme__web/feature-x",
      limit: 7,
    });
    expect(result.data).toEqual({
      worktrees: [{ ...entry({}), tier: "review" }],
      nextCursor: "/Users/dev/.traycer/worktrees/acme__web/feature-y",
    });
    expect(result.human).toContain("More worktrees available");
  });

  it("auto-pages from an explicit cursor when no limit is provided", async () => {
    const startCursor = "/Users/dev/.traycer/worktrees/acme__api/feature-a";
    const first = entry({
      worktreePath: "/Users/dev/.traycer/worktrees/acme__web/feature-b",
      repoLabel: "acme/web",
      branch: "feature/b",
    });
    const second = entry({
      worktreePath: "/Users/dev/.traycer/worktrees/acme__web/feature-c",
      repoLabel: "acme/web",
      branch: "feature/c",
    });
    rpcMock
      .mockResolvedValueOnce({
        worktrees: [first],
        nextCursor: first.worktreePath,
      })
      .mockResolvedValueOnce({ worktrees: [second], nextCursor: null });

    const result = await buildWorktreeListCommand({
      includeActivity: true,
      cursor: startCursor,
      limit: null,
    })(ctx);

    expect(rpcMock).toHaveBeenCalledTimes(2);
    expect(rpcMock).toHaveBeenNthCalledWith(1, "worktree.listAllForHost", {
      includeActivity: true,
      activityPaths: null,
      cursor: startCursor,
      limit: 32,
    });
    expect(rpcMock).toHaveBeenNthCalledWith(2, "worktree.listAllForHost", {
      includeActivity: true,
      activityPaths: null,
      cursor: first.worktreePath,
      limit: 32,
    });
    expect(result.data).toEqual({
      worktrees: [
        { ...first, tier: "review" },
        { ...second, tier: "review" },
      ],
      nextCursor: null,
    });
    expect(result.human).not.toContain("More worktrees available");
  });

  it("throws a resume envelope with partial rows when auto-paging fails mid-loop", async () => {
    const first = entry({
      worktreePath: "/Users/dev/.traycer/worktrees/acme__api/feature-a",
      repoLabel: "acme/api",
      branch: "feature/a",
    });
    rpcMock
      .mockResolvedValueOnce({
        worktrees: [first],
        nextCursor: first.worktreePath,
      })
      .mockRejectedValueOnce(new Error("frame timeout"));

    await expect(
      buildWorktreeListCommand(defaultOpts)(ctx),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.UNEXPECTED,
      message: expect.stringContaining(
        `resume with --cursor ${first.worktreePath}`,
      ),
      details: {
        worktrees: [{ ...first, tier: "review" }],
        resumeCursor: first.worktreePath,
      },
      exitCode: 1,
    });
  });
});
