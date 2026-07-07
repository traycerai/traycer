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

describe("formatWorktreeListTable", () => {
  it("returns an explicit empty-state line when there are no worktrees", () => {
    expect(formatWorktreeListTable([], true)).toBe(
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
    );
    const lines = table.split("\n");
    expect(lines[1]).toContain("Merged");
    expect(lines[2]).toContain("At base commit");
    expect(lines[3]).toContain("-");
  });

  it("shows a detached placeholder and a dash for a null last-active", () => {
    const table = formatWorktreeListTable(
      [row({ branch: null, lastActivityAt: null }, "review")],
      true,
    );
    const line = table.split("\n")[1];
    expect(line).toContain("(detached)");
    expect(line).toContain("-");
  });

  it("normalises a seconds-based epoch up to a real date", () => {
    const table = formatWorktreeListTable(
      [row({ lastActivityAt: 1_700_000_000 }, "review")],
      true,
    );
    expect(table).toContain("2023-11-14");
  });

  it("appends the --include-activity hint only when activity was not requested", () => {
    const withoutActivity = formatWorktreeListTable([row({}, null)], false);
    expect(withoutActivity).toContain("--include-activity");
    const withActivity = formatWorktreeListTable([row({}, "review")], true);
    expect(withActivity).not.toContain("--include-activity");
  });
});

describe("buildWorktreeListCommand", () => {
  it("calls listAllForHost with includeActivity and returns the entries with the computed tier", async () => {
    // The default fixture is clean, on a named branch, with a null
    // branchStatus - unproven, so the shared classifier reads it as review.
    const worktrees = [entry({})];
    rpcMock.mockResolvedValue({ worktrees });

    const result = await buildWorktreeListCommand({ includeActivity: true })(
      ctx,
    );

    expect(rpcMock).toHaveBeenCalledWith("worktree.listAllForHost", {
      includeActivity: true,
      activityPaths: null,
    });
    expect(result.data).toEqual({
      worktrees: [{ ...entry({}), tier: "review" }],
    });
    expect(result.exitCode).toBe(0);
  });

  it("classifies with the shared ladder: a validated merged PR rides out as merged", async () => {
    rpcMock.mockResolvedValue({
      worktrees: [
        entry({ prState: "merged", mergedHeadShaMatches: true, prNumber: 7 }),
      ],
    });

    const result = await buildWorktreeListCommand({ includeActivity: true })(
      ctx,
    );

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
    });
  });

  it("emits tier null without --include-activity (unprobed entries are never classified)", async () => {
    rpcMock.mockResolvedValue({
      worktrees: [entry({ prState: "merged", mergedHeadShaMatches: true })],
    });

    const result = await buildWorktreeListCommand({ includeActivity: false })(
      ctx,
    );

    expect(rpcMock).toHaveBeenCalledWith("worktree.listAllForHost", {
      includeActivity: false,
      activityPaths: null,
    });
    expect(result.data).toEqual({
      worktrees: [
        {
          ...entry({ prState: "merged", mergedHeadShaMatches: true }),
          tier: null,
        },
      ],
    });
  });
});
