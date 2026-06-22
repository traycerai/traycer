import { describe, expect, it } from "vitest";
import {
  createWorktreeBranchSearchIndex,
  filterWorktreeBranchRows,
  pathSearchBasename,
  pathSearchTail,
  type WorktreeBranchSearchRow,
} from "@/components/home/data/worktree-branch-search";

function searchRow(
  id: string,
  branch: string,
  path: string,
): WorktreeBranchSearchRow {
  return {
    id,
    searchBranch: branch,
    searchPathTail: pathSearchTail(path),
    searchPathBasename: pathSearchBasename(path),
    searchFullPath: path,
  };
}

describe("worktree branch search", () => {
  it("preserves input order when the query is empty", () => {
    const rows = [
      searchRow("one", "main", "/repo/main"),
      searchRow("two", "feature/payments", "/repo/worktrees/payments"),
      searchRow("three", "bugfix/login", "/repo/worktrees/login"),
    ];
    const index = createWorktreeBranchSearchIndex(rows);

    expect(
      filterWorktreeBranchRows(rows, index, "").map((row) => row.id),
    ).toEqual(["one", "two", "three"]);
  });

  it("ranks branch-name matches above path-tail matches", () => {
    const rows = [
      searchRow("path", "maintenance", "/repo/worktrees/feature-payments"),
      searchRow("branch", "feature/payments", "/repo/worktrees/alpha"),
    ];
    const index = createWorktreeBranchSearchIndex(rows);

    expect(
      filterWorktreeBranchRows(rows, index, "feature").map((row) => row.id),
    ).toEqual(["branch", "path"]);
  });

  it("finds typo-tolerant branch matches and path-tail fallbacks", () => {
    const rows = [
      searchRow("sonnet", "feature/sonnet-model", "/repo/worktrees/model"),
      searchRow("tail", "main", "/Users/me/worktrees/zebra-checkout"),
    ];
    const index = createWorktreeBranchSearchIndex(rows);

    expect(
      filterWorktreeBranchRows(rows, index, "sonet").map((row) => row.id),
    ).toEqual(["sonnet"]);
    expect(
      filterWorktreeBranchRows(rows, index, "zebra").map((row) => row.id),
    ).toEqual(["tail"]);
  });

  it("uses the last path segments for tail search", () => {
    expect(pathSearchTail("/Users/me/worktrees/repo-feature-x")).toBe(
      "me/worktrees/repo-feature-x",
    );
    expect(pathSearchBasename("/Users/me/worktrees/repo-feature-x")).toBe(
      "repo-feature-x",
    );
  });
});
