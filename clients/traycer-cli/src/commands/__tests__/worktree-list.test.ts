import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorktreeHostEntryV11 } from "@traycer/protocol/host";
import {
  buildWorktreeListCommand,
  formatWorktreeListTable,
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
        entry({
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
        }),
      ],
      true,
    );
    const lines = table.split("\n");
    expect(lines[0]).toContain("REPO");
    expect(lines[0]).toContain("BRANCH");
    expect(lines[0]).toContain("IN-USE");
    expect(lines[0]).toContain("OWNERS");
    expect(lines[0]).toContain("PATH");
    expect(lines[1]).toContain("acme/web");
    expect(lines[1]).toContain("feature/x");
    expect(lines[1]).toContain("yes");
    expect(lines[1]).toContain("2023-11-14");
    // one owner
    expect(lines[1]).toContain("1");
    expect(lines[1]).toContain(
      "/Users/dev/.traycer/worktrees/acme__web/feature-x",
    );
  });

  it("shows a detached placeholder and a dash for a null last-active", () => {
    const table = formatWorktreeListTable(
      [entry({ branch: null, lastActivityAt: null })],
      true,
    );
    const row = table.split("\n")[1];
    expect(row).toContain("(detached)");
    expect(row).toContain("-");
  });

  it("normalises a seconds-based epoch up to a real date", () => {
    const table = formatWorktreeListTable(
      [entry({ lastActivityAt: 1_700_000_000 })],
      true,
    );
    expect(table).toContain("2023-11-14");
  });

  it("appends the --include-activity hint only when activity was not requested", () => {
    const withoutActivity = formatWorktreeListTable([entry({})], false);
    expect(withoutActivity).toContain("--include-activity");
    const withActivity = formatWorktreeListTable([entry({})], true);
    expect(withActivity).not.toContain("--include-activity");
  });
});

describe("buildWorktreeListCommand", () => {
  it("calls listAllForHost with includeActivity and returns the raw entries as data", async () => {
    const worktrees = [entry({})];
    rpcMock.mockResolvedValue({ worktrees });

    const result = await buildWorktreeListCommand({ includeActivity: true })(
      ctx,
    );

    expect(rpcMock).toHaveBeenCalledWith("worktree.listAllForHost", {
      includeActivity: true,
      activityPaths: null,
    });
    expect(result.data).toEqual({ worktrees });
    expect(result.exitCode).toBe(0);
  });

  it("defaults includeActivity to false", async () => {
    rpcMock.mockResolvedValue({ worktrees: [] });

    await buildWorktreeListCommand({ includeActivity: false })(ctx);

    expect(rpcMock).toHaveBeenCalledWith("worktree.listAllForHost", {
      includeActivity: false,
      activityPaths: null,
    });
  });
});
